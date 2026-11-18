(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;

  function t(key, params) {
    return Game.I18N.t(key, params);
  }

  // 同向双车道：玩家在右车道，邻车在左车道；玩家不变道，教学聚焦"减速不超车"
  const C = Object.assign({}, Game.C, {
    CAR_X: 236,
    CAR_MIN_X: 214,
    CAR_MAX_X: 256,
    LANE_LINE_X: 186,
    NEIGHBOR_X: 136,
    NEIGHBOR_SPEED: 36,
    NEIGHBOR_START_GAP: 42,
    NEIGHBOR_STOP_LINE_GAP: 5,
    NEIGHBOR_WIDTH_PX: 28,
    NEIGHBOR_LENGTH_PX: 44,
    NEIGHBOR_STOP_BUFFER_PX: 4,
    NEIGHBOR_BRAKE: 3.5,
    NEIGHBOR_RECOVERY: 2.2,
    NEIGHBOR_GONE_GAP: 55,
    EVENT_ACTIVATE: 95,
    PEDESTRIAN_START_X: 140,
    PEDESTRIAN_CLEAR_X: 268,
    PEDESTRIAN_CONFLICT_X: 210,
    PEDESTRIAN_TIME_LEAD: 0.8,
    YIELD_ZONE_NEAR: 0.5,
    YIELD_ZONE_FAR: 18,
    CROSS_POSITIONS: [120, 300, 480]
  });

  function createEvents(seed) {
    const random = M.mulberry32(M.hashSeed(seed));
    const events = C.CROSS_POSITIONS.map(function (position, index) {
      return {
        id: index,
        crossingPosition: position,
        occupied: true,
        runSpeed: 22 + random() * 6,
        coatColor: ['#f4d35e', '#ee6c72', '#7fd1ed'][Math.floor(random() * 3)],
        skinColor: random() > 0.5 ? '#efb489' : '#c88760',
        neighborSpeed: 34 + random() * 4,
        recorded30: false,
        recorded15: false,
        speedAt30: null,
        speedAt15: null,
        minSpeedInRisk: Infinity,
        maxSpeedAfter30: 0,
        maxLateralShift: 0,
        earlySlow: false,
        lateSlow: false,
        resolved: false,
        attempts: 0,
        failed: false,
        active: false,
        neighbor: {
          distance: position - C.NEIGHBOR_START_GAP,
          speed: 0,
          state: 'approach',
          stateTime: 0,
          braking: false,
          stopped: false
        },
        pedestrian: {
          active: false,
          x: C.PEDESTRIAN_START_X,
          visible: false,
          cleared: false,
          firstVisibleDistance: null
        }
      };
    });
    events.forEach(function (event) { event.neighbor.speed = event.neighborSpeed; });
    return events;
  }

  function resetEventRuntime(event) {
    event.recorded30 = false;
    event.recorded15 = false;
    event.speedAt30 = null;
    event.speedAt15 = null;
    event.minSpeedInRisk = Infinity;
    event.maxSpeedAfter30 = 0;
    event.maxLateralShift = 0;
    event.earlySlow = false;
    event.lateSlow = false;
    event.active = false;
    event.neighbor = {
      distance: event.crossingPosition - C.NEIGHBOR_START_GAP,
      speed: event.neighborSpeed,
      state: 'approach',
      stateTime: 0,
      braking: false,
      stopped: false
    };
    event.pedestrian = {
      active: false,
      x: C.PEDESTRIAN_START_X,
      visible: false,
      cleared: false,
      firstVisibleDistance: null
    };
  }

  function segmentIntersectsAABB(start, end, rect, epsilon) {
    const eps = epsilon == null ? 0.000001 : epsilon;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let near = 0;
    let far = 1;
    const axes = [
      { origin: start.x, delta: dx, min: rect.left, max: rect.right },
      { origin: start.y, delta: dy, min: rect.bottom, max: rect.top }
    ];
    for (let index = 0; index < axes.length; index += 1) {
      const axis = axes[index];
      if (Math.abs(axis.delta) <= eps) {
        if (axis.origin < axis.min - eps || axis.origin > axis.max + eps) return false;
        continue;
      }
      let a = (axis.min - axis.origin) / axis.delta;
      let b = (axis.max - axis.origin) / axis.delta;
      if (a > b) { const swap = a; a = b; b = swap; }
      near = Math.max(near, a);
      far = Math.min(far, b);
      if (near > far + eps) return false;
    }
    return far >= -eps && near <= 1 + eps;
  }

  function neighborStopPosition(event) {
    const frontLength = (C.NEIGHBOR_LENGTH_PX / 2 + C.NEIGHBOR_STOP_BUFFER_PX) / C.PIXELS_PER_METER;
    return event.crossingPosition - C.NEIGHBOR_STOP_LINE_GAP - frontLength;
  }

  function neighborRect(event) {
    const neighbor = event.neighbor;
    const centerY = neighbor.distance * C.PIXELS_PER_METER;
    return {
      left: C.NEIGHBOR_X - C.NEIGHBOR_WIDTH_PX / 2,
      right: C.NEIGHBOR_X + C.NEIGHBOR_WIDTH_PX / 2,
      bottom: centerY - C.NEIGHBOR_LENGTH_PX / 2,
      top: centerY + C.NEIGHBOR_LENGTH_PX / 2
    };
  }

  function visibilityFor(simulation, event) {
    const pedestrian = event.pedestrian;
    if (!event.occupied || !pedestrian.active || pedestrian.cleared) {
      return { visible: false, occluded: false };
    }
    if (!event.active || event.neighbor.state === 'gone') return { visible: true, occluded: false };
    const eye = { x: simulation.x, y: (simulation.distance + 0.8) * C.PIXELS_PER_METER };
    const target = { x: pedestrian.x, y: event.crossingPosition * C.PIXELS_PER_METER };
    const occluded = segmentIntersectsAABB(eye, target, neighborRect(event), 0.000001);
    return { visible: !occluded, occluded: occluded };
  }

  function actorBlocking(simulation, event, visibleOnly) {
    const pedestrian = event && event.pedestrian;
    return Boolean(event && event.occupied && pedestrian.active && !pedestrian.cleared &&
      (!visibleOnly || pedestrian.visible) && pedestrian.x < C.CAR_MAX_X + 6);
  }

  function yieldRequired(simulation, event, visibleOnly) {
    if (!event || !event.active) return false;
    const bumperRemaining = event.crossingPosition - (simulation.distance + C.CAR_LENGTH_M / 2);
    if (bumperRemaining < C.YIELD_ZONE_NEAR || bumperRemaining > C.YIELD_ZONE_FAR) return false;
    return event.neighbor.braking || event.neighbor.stopped || actorBlocking(simulation, event, visibleOnly);
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    let target = 47;
    let right = false;
    if (event) {
      const remaining = event.crossingPosition - simulation.distance;
      const signaling = event.active && (event.neighbor.braking || event.neighbor.stopped);
      if ((remaining < C.RISK_START + 5 && remaining > -C.RISK_END) ||
        (signaling && remaining > 0 && remaining <= C.EVENT_ACTIVATE)) {
        target = 18;
      }
      if (yieldRequired(simulation, event, true)) target = 0;
      right = remaining < C.RISK_START + 10 && remaining > -C.RISK_END;
    }
    return {
      throttle: simulation.speed < target - 0.5,
      brake: simulation.speed > target + 0.5,
      right: right
    };
  }

  class Simulation {
    constructor(seed) {
      this.seed = seed;
      this.distance = 0;
      this.speed = C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.necessaryBraking = false;
      this.x = C.CAR_X;
      this.elapsed = 0;
      this.status = 'ready';
      this.events = createEvents(seed);
      this.scoring = Game.Scoring.createState();
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demoTime = 0;
      this.demo = null;
      this.demoEventId = null;
      this.retryCount = 0;
    }

    start() {
      this.status = 'driving';
    }

    get currentEvent() {
      return this.events.find(function (event) { return !event.resolved; }) || null;
    }

    get finishDistance() {
      return C.CROSS_POSITIONS[C.CROSS_POSITIONS.length - 1] + C.FINISH_BUFFER;
    }

    getRiskEvent() {
      return Scoring.getRiskEvent(this);
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      if (dt <= 0) return;
      input = input || {};
      this.justHardBrake = false;
      this.justResolved = null;
      this.previousSpeed = this.speed;

      let acceleration = -C.NATURAL_DECELERATION;
      const approachingEvent = this.currentEvent;
      const emergencyBrake = approachingEvent && this.speed > C.HARD_BRAKE_MIN_SPEED &&
        approachingEvent.crossingPosition - this.distance < C.REVEAL_DISTANCE &&
        approachingEvent.crossingPosition - this.distance > -2;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = -(emergencyBrake ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);
      this.acceleration = acceleration;

      const oldSpeedMps = this.speed / 3.6;
      let nextSpeedMps = M.clamp(oldSpeedMps + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      if (!input.throttle && !input.brake && this.speed < 1) nextSpeedMps = 0;
      this.speed = nextSpeedMps * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeedMps - nextSpeedMps) / dt);
      this.distance += (oldSpeedMps + nextSpeedMps) * 0.5 * dt;
      this.elapsed += dt;

      if (this.speed > 0.5) {
        const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        this.x = M.clamp(this.x + steering * C.STEER_SPEED * dt, C.CAR_MIN_X, C.CAR_MAX_X);
      }

      this.updateTraffic(dt);
      const event = this.currentEvent;
      this.necessaryBraking = Boolean(event && input.brake && event.active &&
        this.previousSpeed <= C.SAFE_SPEED + 2 && yieldRequired(this, event));
      if (event) {
        this.updateEvent(event, dt);
        Scoring.recordStep(this.scoring, this, dt);
        if (event.occupied && !event.resolved && this.predictConflict(event, input)) {
          this.freeze(event);
          return;
        }
        if (!event.resolved && this.distance > event.crossingPosition + C.RISK_END) {
          this.resolveEvent(event);
        }
      } else {
        Scoring.recordStep(this.scoring, this, dt);
      }

      if (this.distance >= this.finishDistance) {
        this.distance = this.finishDistance;
        this.speed = 0;
        this.status = 'complete';
      } else if (this.elapsed >= C.MAX_TIME) {
        this.speed = 0;
        this.status = 'timeout';
      }
    }

    updateTraffic(dt) {
      const current = this.currentEvent;
      if (current && !current.active && current.crossingPosition - this.distance <= C.EVENT_ACTIVATE) {
        current.active = true;
        current.neighbor.speed = current.neighborSpeed;
        current.neighbor.state = 'approach';
        current.neighbor.stateTime = 0;
      }
      this.events.forEach(function (event) {
        if (!event.active || event.neighbor.state === 'gone') return;
        this.updateNeighbor(event, dt);
        this.updatePedestrian(event, dt);
        const visibility = visibilityFor(this, event);
        event.pedestrian.visible = visibility.visible;
        if (visibility.visible && event.pedestrian.firstVisibleDistance == null) {
          event.pedestrian.firstVisibleDistance = Math.max(0,
            event.crossingPosition - (this.distance + C.CAR_LENGTH_M / 2));
        }
      }, this);
    }

    updateNeighbor(event, dt) {
      const neighbor = event.neighbor;
      neighbor.stateTime += dt;
      neighbor.braking = neighbor.state === 'braking';
      neighbor.stopped = neighbor.state === 'yielding';
      if (neighbor.state === 'gone') return;

      if (neighbor.state === 'yielding') {
        neighbor.speed = 0;
        if (event.pedestrian.cleared) {
          neighbor.state = 'recovering';
          neighbor.stateTime = 0;
          neighbor.stopped = false;
        }
        return;
      }

      const previous = neighbor.speed / 3.6;
      let next = previous;
      let arrived = false;
      if (neighbor.state === 'recovering') {
        next = Math.min(event.neighborSpeed / 3.6, previous + C.NEIGHBOR_RECOVERY * dt);
      } else {
        // 每条斑马线都有真实行人通过，蓝车据此连续制动并停车让行。
        const stopPosition = neighborStopPosition(event);
        const remaining = stopPosition - neighbor.distance;
        const brakingDistance = previous * previous / (2 * C.NEIGHBOR_BRAKE) + 0.35;
        if (neighbor.state === 'approach' && remaining <= brakingDistance) {
          neighbor.state = 'braking';
          neighbor.stateTime = 0;
          neighbor.braking = true;
          // 进入制动时确定一条连续减速曲线，避免末段先归零却永远到不了停止点。
          neighbor.brakeDeceleration = previous > 0 && remaining > 0
            ? previous * previous / (2 * remaining) : C.NEIGHBOR_BRAKE;
        }
        if (neighbor.state === 'braking') {
          const timeToStop = previous > 0 ? 2 * Math.max(0, remaining) / previous : 0;
          if (remaining <= 0.0001 || previous <= 0.0001 || timeToStop <= dt + 0.000001) {
            next = 0;
            neighbor.distance = stopPosition;
            neighbor.state = 'yielding';
            neighbor.stateTime = 0;
            neighbor.braking = false;
            neighbor.stopped = true;
            arrived = true;
          } else {
            next = Math.max(0, previous - neighbor.brakeDeceleration * dt);
          }
        }
      }
      if (!arrived) neighbor.distance += (previous + next) * 0.5 * dt;
      neighbor.speed = next * 3.6;
      if (neighbor.distance > event.crossingPosition + C.NEIGHBOR_GONE_GAP) {
        neighbor.state = 'gone';
        neighbor.stateTime = 0;
        neighbor.braking = false;
        neighbor.stopped = false;
      }
    }

    updatePedestrian(event, dt) {
      if (!event.occupied) return;
      const pedestrian = event.pedestrian;
      const neighbor = event.neighbor;
      if (!pedestrian.active && !pedestrian.cleared && (neighbor.braking || neighbor.stopped)) {
        const frontRemaining = Math.max(0, event.crossingPosition - (this.distance + C.CAR_LENGTH_M / 2));
        const playerSpeed = this.speed / 3.6;
        const playerEta = playerSpeed > 0.5 ? frontRemaining / playerSpeed : Infinity;
        const pedestrianEta = Math.max(0, C.PEDESTRIAN_CONFLICT_X - pedestrian.x) / event.runSpeed;
        // 按双方接近时序启动，最迟在蓝车停稳时进入，禁止出现无行人空等。
        if (neighbor.stopped || playerEta <= pedestrianEta + C.PEDESTRIAN_TIME_LEAD) {
          pedestrian.active = true;
        }
      }
      if (pedestrian.active && !pedestrian.cleared) {
        pedestrian.x += event.runSpeed * dt;
        if (pedestrian.x >= C.PEDESTRIAN_CLEAR_X) {
          pedestrian.cleared = true;
          pedestrian.visible = false;
        }
      }
    }

    updateEvent(event, dt) {
      const distanceToCross = event.crossingPosition - this.distance;
      if (distanceToCross <= C.RISK_START && distanceToCross >= -C.RISK_END) {
        event.minSpeedInRisk = Math.min(event.minSpeedInRisk, this.speed);
        if (event.recorded30 && distanceToCross > 0) event.maxSpeedAfter30 = Math.max(event.maxSpeedAfter30, this.speed);
        // 向右微调，远离邻车道与来车方向
        event.maxLateralShift = Math.max(event.maxLateralShift, this.x - C.CAR_X);
      }

      if (!event.recorded30 && distanceToCross <= C.SLOW_CHECK) {
        event.recorded30 = true;
        event.speedAt30 = this.speed;
        event.maxSpeedAfter30 = Math.max(event.maxSpeedAfter30, this.speed);
      }
      if (!event.recorded15 && distanceToCross <= C.LATE_CHECK) {
        event.recorded15 = true;
        event.speedAt15 = this.speed;
      }
    }

    predictConflict(event, input) {
      const pedestrian = event.pedestrian;
      if (!pedestrian.active || pedestrian.cleared || this.speed < 0.5) return false;
      const pedestrianY = event.crossingPosition;
      const carHalfWidth = C.CAR_WIDTH_M * C.PIXELS_PER_METER / 2;
      let distance = this.distance;
      let velocity = this.speed / 3.6;
      let pedestrianX = pedestrian.x;
      const horizon = Math.max(0.8, Math.min(1.2, velocity * 0.12));
      const substep = 0.025;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = this.acceleration;

      for (let time = 0; time < horizon - 0.000001; time += substep) {
        const slice = Math.min(substep, horizon - time);
        const nextVelocity = M.clamp(velocity + acceleration * slice, 0, C.MAX_SPEED / 3.6);
        const nextDistance = distance + (velocity + nextVelocity) * 0.5 * slice;
        const nextPedestrianX = pedestrianX + event.runSpeed * slice;
        const carFront = nextDistance + C.CAR_LENGTH_M / 2 + 0.25;
        const carRear = distance - C.CAR_LENGTH_M / 2 - 0.25;
        const horizontal = Math.max(pedestrianX, nextPedestrianX) + 3.2 > this.x - carHalfWidth &&
          Math.min(pedestrianX, nextPedestrianX) - 3.2 < this.x + carHalfWidth;
        const vertical = pedestrianY > carRear && pedestrianY < carFront;
        if (horizontal && vertical) return true;
        distance = nextDistance;
        velocity = nextVelocity;
        pedestrianX = nextPedestrianX;
        if (velocity <= 0) break;
      }
      return false;
    }

    freeze(event) {
      event.failed = true;
      event.attempts += 1;
      this.retryCount += 1;
      this.status = 'frozen';
      this.freezeInfo = {
        eventId: event.id,
        speed: this.speed,
        distanceToCross: Math.max(0, event.crossingPosition - this.distance),
        stoppingDistance: M.stoppingDistance(this.speed)
      };
    }

    resolveEvent(event) {
      event.resolved = true;
      event.earlySlow = event.speedAt30 != null && event.speedAt30 <= C.SAFE_SPEED &&
        event.maxSpeedAfter30 <= C.RISK_MAX_SPEED;
      event.lateSlow = !event.earlySlow && event.speedAt15 != null && event.speedAt15 <= C.RISK_MAX_SPEED;
      this.justResolved = event;
    }

    retryEvent() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.demoEventId != null ? this.demoEventId : (this.currentEvent ? this.currentEvent.id : 0));
      const event = this.events[eventId];
      if (!event) return;
      this.distance = Math.max(0, event.crossingPosition - 55);
      this.speed = 30;
      this.previousSpeed = 30;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.necessaryBraking = false;
      this.x = C.CAR_X;
      resetEventRuntime(event);
      this.freezeInfo = null;
      this.demo = null;
      this.demoEventId = null;
      this.demoTime = 0;
      this.justResolved = null;
      this.status = 'driving';
    }

    startDemo() {
      if (!this.freezeInfo) return;
      const eventId = this.freezeInfo.eventId;
      const demo = new Simulation(this.seed);
      for (let index = 0; index < eventId; index += 1) {
        demo.events[index].resolved = true;
        demo.events[index].earlySlow = true;
        demo.events[index].maxLateralShift = C.LATERAL_SHIFT;
      }
      const event = demo.events[eventId];
      demo.distance = Math.max(0, event.crossingPosition - 55);
      demo.speed = 45;
      demo.previousSpeed = 45;
      demo.status = 'driving';
      this.demo = demo;
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.status = 'demonstrating';
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      const demo = this.demo;
      const event = demo.events[this.demoEventId];
      demo.step(defensiveInput(demo), dt);
      if (demo.status === 'frozen' || demo.status === 'timeout' ||
        (event.resolved && (event.neighbor.state === 'recovering' || event.neighbor.state === 'gone')) ||
        this.demoTime >= 20) {
        this.retryEvent();
      }
    }
  }

  // ---- 评分：效率与急刹复用公交曲线，观察分与建议为本场景规则 ----

  const Scoring = {
    getRiskEvent: function (simulation) {
      return simulation.events.find(function (event) {
        return !event.resolved &&
          simulation.distance >= event.crossingPosition - C.RISK_START &&
          simulation.distance <= event.crossingPosition + C.RISK_END;
      }) || null;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || !event.active || simulation.speed >= 1.2) return false;
      const bumperRemaining = event.crossingPosition - (simulation.distance + C.CAR_LENGTH_M / 2);
      if (bumperRemaining < C.YIELD_ZONE_NEAR || bumperRemaining > C.YIELD_ZONE_FAR) return false;
      return event.neighbor.braking || event.neighbor.stopped ||
        (event.pedestrian.visible && actorBlocking(simulation, event));
    },

    recordStep: function (state, simulation, dt) {
      const event = Scoring.getRiskEvent(simulation);
      if (!Scoring.isYieldExempt(simulation)) {
        const quality = Game.Scoring.speedQuality(simulation.speed, Boolean(event));
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);

      const harsh = simulation.lastDeceleration > C.HARD_BRAKE &&
        simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED && !simulation.necessaryBraking;
      if (harsh && state.hardBrakeCooldown <= 0) {
        state.hardBrakeDuration += dt;
        if (state.hardBrakeDuration >= 0.15) {
          state.hardBrakes += 1;
          state.hardBrakeDuration = 0;
          state.hardBrakeCooldown = 1.2;
          simulation.justHardBrake = true;
        }
      } else if (!harsh) {
        state.hardBrakeDuration = 0;
      }
    },

    eventObservation: function (event) {
      const speedScore = event.earlySlow ? 8 : (event.lateSlow ? 4 : 0);
      const lateralScore = event.maxLateralShift >= C.LATERAL_SHIFT ? 2 : 0;
      return speedScore + lateralScore;
    },

    summarize: function (simulation, timedOut) {
      const state = simulation.scoring;
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(function (event) { return !event.failed; });
      const observation = simulation.events.reduce(function (sum, event) {
        return sum + (event.resolved ? Scoring.eventObservation(event) : 0);
      }, 0);
      const safety = Math.round(clean.length * (40 / 3));
      const efficiency = state.efficiencyTime > 0
        ? 20 * state.efficiencyIntegral / state.efficiencyTime
        : 0;
      const smooth = Math.max(0, 10 - state.hardBrakes * 2);
      const failed = simulation.events.some(function (event) { return event.failed; });
      let total = safety + observation + efficiency + smooth;
      if (failed) total = Math.min(total, 59);
      if (timedOut) total = Math.min(total, 69);
      total = Math.round(total);

      let grade = 'C';
      let titleKey = 'result.title.c';
      let summaryKey = 'result.summary.c';
      if (total >= 85 && !timedOut) {
        grade = 'A';
        titleKey = 'result.title.a';
        summaryKey = 'result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }

      const earlySlowCount = simulation.events.filter(function (event) { return event.earlySlow; }).length;
      let adviceKey = 'scene.crosswalk.result.advice.default';
      if (failed) {
        adviceKey = 'scene.crosswalk.result.advice.failed';
      } else if (earlySlowCount < 3) {
        adviceKey = 'scene.crosswalk.result.advice.early';
      } else if (state.hardBrakes > 0) {
        adviceKey = 'result.advice.braking';
      } else if (timedOut || efficiency < 12) {
        adviceKey = 'result.advice.efficiency';
      } else if (observation < 28) {
        adviceKey = 'scene.crosswalk.result.advice.observation';
      }

      return {
        total: total,
        grade: grade,
        titleKey: titleKey,
        summaryKey: summaryKey,
        safety: safety,
        observation: Math.round(observation),
        efficiency: Math.round(efficiency),
        efficiencyRaw: efficiency,
        smooth: smooth,
        hardBrakes: state.hardBrakes,
        earlySlowCount: earlySlowCount,
        passedCount: clean.length,
        timedOut: Boolean(timedOut),
        failed: failed,
        adviceKey: adviceKey
      };
    }
  };

  // ---- 渲染 ----

  function worldY(simulation, worldPosition) {
    return Draw.worldY(C, simulation, worldPosition);
  }

  function drawCrosswalk(ctx, simulation, event) {
    const y = worldY(simulation, event.crossingPosition);
    if (y < -30 || y > C.HEIGHT + 30) return;
    for (let x = 92; x < 288; x += 16) {
      Draw.rect(ctx, '#d8dcd2', x, y - 8, 9, 16);
    }
    // 两条同向车道共用前置停止线，蓝车车头在线后停车。
    const stopY = worldY(simulation, event.crossingPosition - C.NEIGHBOR_STOP_LINE_GAP);
    Draw.rect(ctx, '#e8e4cf', 96, stopY, 80, 3);
    Draw.rect(ctx, '#e8e4cf', 196, stopY, 92, 3);
  }

  function drawRiskZone(ctx, simulation, event) {
    const top = worldY(simulation, event.crossingPosition + C.RISK_END);
    const bottom = worldY(simulation, event.crossingPosition - C.RISK_START);
    if (bottom < 0 || top > C.HEIGHT) return;
    const y = Math.max(0, top);
    const height = Math.min(C.HEIGHT, bottom) - y;
    ctx.save();
    ctx.globalAlpha = 0.13;
    Draw.rect(ctx, '#f4c75b', 196, y, 96, height);
    ctx.restore();

    const markerY = worldY(simulation, event.crossingPosition - C.SLOW_CHECK);
    if (markerY > 100 && markerY < C.HEIGHT - 20) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ffe292';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(196, markerY);
      ctx.lineTo(292, markerY);
      ctx.stroke();
      ctx.restore();
      const markerText = t('canvas.slowMarker');
      ctx.font = '8px sans-serif';
      const markerWidth = Math.min(92, Math.max(70, Math.ceil(ctx.measureText(markerText).width) + 10));
      Draw.rect(ctx, '#142630dd', 198, markerY - 14, markerWidth, 12);
      ctx.fillStyle = '#ffe6a4';
      Draw.fillFittedText(ctx, markerText, 202, markerY - 5, markerWidth - 10, 8, 'sans-serif');
    }
  }

  function drawNeighbor(ctx, simulation, event, demo) {
    const neighbor = event.neighbor;
    if (!event.active || neighbor.state === 'gone') return;
    const y = worldY(simulation, neighbor.distance);
    if (y < -40 || y > C.HEIGHT + 40) return;
    Draw.drawCar(ctx, C.NEIGHBOR_X, y, demo ? '#65d6a1' : '#5b8dc9', Boolean(demo));
    // 刹车灯：制动或停止让行时点亮
    if (neighbor.braking || neighbor.stopped) {
      Draw.rect(ctx, '#ff5b4d', C.NEIGHBOR_X - 11, y + 20, 6, 4);
      Draw.rect(ctx, '#ff5b4d', C.NEIGHBOR_X + 5, y + 20, 6, 4);
    }
  }

  function drawEventPedestrian(ctx, simulation, event, demo) {
    const pedestrian = event.pedestrian;
    if (!event.occupied || !pedestrian.active || pedestrian.cleared) return;
    if (!pedestrian.visible && simulation.status !== 'frozen') return;
    const y = worldY(simulation, event.crossingPosition);
    Draw.drawPedestrian(ctx, C, pedestrian.x, y, event, !pedestrian.visible, Boolean(demo));
  }

  function drawFreeze(ctx, simulation) {
    Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
    const event = simulation.events[simulation.freezeInfo.eventId];
    // 展示行人横穿路径
    if (event.pedestrian.active) {
      const y = worldY(simulation, event.crossingPosition);
      ctx.save();
      ctx.strokeStyle = '#fff0a8';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(event.pedestrian.x, y);
      ctx.lineTo(C.PEDESTRIAN_CLEAR_X, y);
      ctx.stroke();
      ctx.restore();
    }
    const x = simulation.x + 21;
    const y = C.CAR_Y - 30;
    Draw.rect(ctx, '#fff0b0', x, y, 22, 24);
    Draw.rect(ctx, '#3b2a0e', x + 9, y + 4, 4, 10);
    Draw.rect(ctx, '#3b2a0e', x + 9, y + 17, 4, 4);
  }

  function drawDemo(ctx, simulation) {
    const demo = simulation.demo;
    Draw.drawEnvironment(ctx, demo, C, C.LANE_LINE_X);
    demo.events.forEach(function (event) {
      drawRiskZone(ctx, demo, event);
    });
    demo.events.forEach(function (event) {
      drawCrosswalk(ctx, demo, event);
      drawNeighbor(ctx, demo, event, true);
      drawEventPedestrian(ctx, demo, event, true);
    });
    Draw.drawCar(ctx, demo.x, C.CAR_Y, '#65d6a1', true);
    Draw.rect(ctx, '#0e202ddd', 212, 552, 126, 47);
    ctx.fillStyle = '#a6f0c8';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(Math.round(demo.speed) + ' km/h', 220, 575);
    ctx.fillStyle = '#d4e3db';
    const demoText = t(demo.speed < 1 ? 'canvas.wait' : 'canvas.principles');
    Draw.fillFittedText(ctx, demoText, 220, 590, 110, 9, 'sans-serif');
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        drawDemo(ctx, simulation);
        return;
      }

      Draw.drawEnvironment(ctx, simulation, C, C.LANE_LINE_X);
      simulation.events.forEach(function (event) {
        drawRiskZone(ctx, simulation, event);
      });
      simulation.events.forEach(function (event) {
        drawCrosswalk(ctx, simulation, event);
        drawNeighbor(ctx, simulation, event, false);
        drawEventPedestrian(ctx, simulation, event, false);
      });
      Draw.drawCar(ctx, simulation.x, C.CAR_Y, '#e7685b', false);
      if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
    }
  };

  // ---- 场景 UI 文案 ----

  Scenes['crosswalk-occlusion'] = {
    id: 'crosswalk-occlusion',
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    Constants: C,
    Geometry: {
      segmentIntersectsAABB: segmentIntersectsAABB,
      neighborStopPosition: neighborStopPosition,
      neighborRect: neighborRect,
      visibilityFor: visibilityFor
    },
    defensiveInput: defensiveInput,
    actorBlocking: actorBlocking,
    yieldRequired: yieldRequired,
    ui: {
      progress: function (simulation) {
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.crosswalk.hud.progress', { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && !event.failed; }).length
        ];
      },
      coach: function (simulation, displaySpeed) {
        if (simulation.status === 'demonstrating' && simulation.demo) simulation = simulation.demo;
        const event = simulation.getRiskEvent();
        const upcomingEvent = simulation.currentEvent;
        const approachDistance = upcomingEvent ? upcomingEvent.crossingPosition - simulation.distance : Infinity;
        const pedestrian = event && event.occupied && event.pedestrian.active && !event.pedestrian.cleared
          ? event.pedestrian : null;
        let coach = 'scene.crosswalk.hud.cruise';
        let status = displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : 'hud.speedUp';
        let tone = '';
        let coachTone = '';

        if (displaySpeed < 25 && !event) {
          status = 'hud.tooSlow';
          tone = 'warn';
        } else if (displaySpeed > 55 && !event) {
          status = 'hud.nearLimit';
          tone = 'danger';
        }

        // 邻车制动/停车是提前信号，不局限于风险区内
        const signaling = upcomingEvent && upcomingEvent.active &&
          !upcomingEvent.resolved && (upcomingEvent.neighbor.braking || upcomingEvent.neighbor.stopped) &&
          approachDistance > 0;
        if (event) {
          coachTone = 'risk';
          if (pedestrian && event.pedestrian.visible) {
            coach = 'scene.crosswalk.hud.pedestrian';
            status = displaySpeed < 1 ? 'hud.yielding' : 'hud.prepareStop';
            tone = displaySpeed < 1 ? '' : 'warn';
          } else if (displaySpeed > C.RISK_MAX_SPEED) {
            coach = 'scene.crosswalk.hud.brakeNow';
            status = 'hud.tooFast';
            tone = 'danger';
          } else if (displaySpeed > C.SAFE_SPEED) {
            coach = 'hud.keepSlowing';
            status = 'hud.slowing';
            tone = 'warn';
          } else {
            coach = 'scene.crosswalk.hud.controlled';
            status = displaySpeed < 8 ? 'hud.tooSlowRisk' : 'hud.defensive';
            tone = displaySpeed < 8 ? 'warn' : '';
            coachTone = displaySpeed < 8 ? 'risk' : 'good';
          }
        } else if (signaling && approachDistance <= C.EVENT_ACTIVATE) {
          coach = 'scene.crosswalk.hud.neighborSignal';
          status = 'hud.prepareSlow';
          coachTone = 'risk';
        } else if (upcomingEvent && approachDistance <= C.APPROACH_START && approachDistance > C.RISK_START) {
          coach = 'scene.crosswalk.hud.approach';
          status = 'hud.prepareSlow';
          coachTone = 'risk';
        } else if (simulation.currentEvent && simulation.distance > simulation.currentEvent.crossingPosition + C.RISK_END) {
          coach = 'hud.resumeSpeed';
        }

        return {
          text: t(coach),
          coachTone: coachTone,
          status: t(simulation.status === 'ready' ? 'hud.ready' : status),
          tone: tone
        };
      },
      eventToast: function (event) {
        const observation = Scoring.eventObservation(event);
        if (event.earlySlow) {
          return {
            key: 'toast.safeOccupied',
            params: { score: observation },
            neutral: false
          };
        }
        if (event.lateSlow) return { key: 'toast.late', params: {}, neutral: true };
        return { key: 'toast.fast', params: {}, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.crosswalk.failure.reason', {
          speed: Math.round(info.speed),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo.events[simulation.demoEventId];
        const pedestrian = event.pedestrian;
        let key = 'scene.crosswalk.demo.slow';
        if (demo.speed < 1 && yieldRequired(demo, event)) key = 'scene.crosswalk.demo.wait';
        else if (pedestrian.visible && pedestrian.active && !pedestrian.cleared) key = 'scene.crosswalk.demo.yield';
        else if (event.neighbor.state === 'recovering' || demo.distance > event.crossingPosition - 24) {
          key = 'scene.crosswalk.demo.pass';
        }
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
