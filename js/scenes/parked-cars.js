(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;

  function t(key, params) {
    return Game.I18N.t(key, params);
  }

  // 纵向世界坐标使用米，横向沿用 Canvas 像素；所有遮挡和冲突共用这份几何。
  const C = Object.assign({}, Game.C, {
    GROUP_STARTS: [95, 265, 435],
    PARKED_X: 270,
    PARKED_LEFT: 256,
    PARKED_RIGHT: 284,
    PARKED_LENGTH_M: 44 / Game.C.PIXELS_PER_METER,
    PEDESTRIAN_START_X: 294,
    PEDESTRIAN_EDGE_X: 248,
    PEDESTRIAN_CLEAR_X: 156,
    PEDESTRIAN_EMERGE_SPEED: 30,
    EVENT_ACTIVATE: 48,
    CROSS_TRIGGER: 17,
    APPROACH_START: 55,
    RISK_START: 35,
    SLOW_CHECK: 30,
    LATE_CHECK: 12,
    RISK_END: 3,
    FINISH_BUFFER: 24,
    LATERAL_SHIFT_PIXELS: 6,
    LATERAL_HOLD_TIME: 0.6,
    YIELD_ZONE_NEAR: 1,
    YIELD_ZONE_FAR: 18
  });

  function freezeRect(rect) {
    return Object.freeze(rect);
  }

  // 布局与外观使用不同的随机流，新增车漆不会改变危险出口或行人时序。
  function createPlan(seed) {
    const layoutRandom = M.mulberry32(M.hashSeed('parked-layout:' + seed));
    const paintRandom = M.mulberry32(M.hashSeed('parked-paint:' + seed));
    const occupiedCount = layoutRandom() < 0.5 ? 1 : 2;
    const patterns = occupiedCount === 1
      ? [[true, false, false], [false, true, false], [false, false, true]]
      : [[true, true, false], [false, true, true], [true, false, true]];
    const pattern = patterns[Math.floor(layoutRandom() * patterns.length)];
    const colors = ['#d7a84b', '#648db5', '#a7a9a2', '#8b6ca8', '#c8725c', '#5d927c'];
    const parkedCars = [];
    const gaps = [];

    const groups = C.GROUP_STARTS.map(function (start, groupId) {
      const count = 4 + Math.floor(layoutRandom() * 2);
      let cursor = start;
      const carIds = [];
      const gapIds = [];
      for (let index = 0; index < count; index += 1) {
        const carId = parkedCars.length;
        const car = freezeRect({
          id: carId,
          groupId: groupId,
          position: cursor + C.PARKED_LENGTH_M / 2,
          left: C.PARKED_LEFT,
          right: C.PARKED_RIGHT,
          bottom: cursor,
          top: cursor + C.PARKED_LENGTH_M,
          lowLeft: C.PARKED_LEFT + 2,
          lowRight: C.PARKED_RIGHT - 2,
          lowBottom: cursor + 0.32,
          lowTop: cursor + C.PARKED_LENGTH_M - 0.32,
          color: colors[Math.floor(paintRandom() * colors.length)]
        });
        parkedCars.push(car);
        carIds.push(carId);
        cursor = car.top;
        if (index < count - 1) {
          const width = 2 + layoutRandom() * 1.6;
          const gap = Object.freeze({
            id: gaps.length,
            groupId: groupId,
            beforeCarId: carId,
            afterCarId: carId + 1,
            position: cursor + width / 2,
            bottom: cursor,
            top: cursor + width,
            width: width
          });
          gaps.push(gap);
          gapIds.push(gap.id);
          cursor += width;
        }
      }
      const hazardGapId = gapIds[Math.floor(layoutRandom() * gapIds.length)];
      return Object.freeze({
        id: groupId,
        start: start,
        end: cursor,
        occupied: pattern[groupId],
        carIds: Object.freeze(carIds),
        gapIds: Object.freeze(gapIds),
        hazardGapId: hazardGapId,
        crossSpeed: 23 + layoutRandom() * 5,
        coatColor: ['#f4d35e', '#ee6c72', '#7fd1ed'][Math.floor(paintRandom() * 3)],
        skinColor: paintRandom() > 0.5 ? '#efb489' : '#c88760'
      });
    });

    return Object.freeze({
      groups: Object.freeze(groups),
      parkedCars: Object.freeze(parkedCars),
      gaps: Object.freeze(gaps)
    });
  }

  // Slab/Liang-Barsky：平行、端点、车角和近 miss 都使用同一 epsilon。
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

  function visibilityFor(simulation, event) {
    const pedestrian = event.pedestrian;
    const eye = { x: simulation.x, y: simulation.distance + 0.8 };
    const bodyPoint = { x: pedestrian.x, y: event.gapPosition };
    const footPoint = { x: pedestrian.x, y: event.gapPosition - 0.34 };
    const shadowPoint = { x: pedestrian.x + 3, y: event.gapPosition - 0.48 };
    let visible = true;
    let footVisible = true;
    let shadowVisible = true;
    let occluderId = null;

    for (let index = 0; index < simulation.parkedCars.length; index += 1) {
      const car = simulation.parkedCars[index];
      if (visible && segmentIntersectsAABB(eye, bodyPoint, car, 0.000001)) {
        visible = false;
        occluderId = car.id;
      }
      const lowRect = {
        left: car.lowLeft,
        right: car.lowRight,
        bottom: car.lowBottom,
        top: car.lowTop
      };
      if (footVisible && segmentIntersectsAABB(eye, footPoint, lowRect, 0.000001)) footVisible = false;
      if (shadowVisible && segmentIntersectsAABB(eye, shadowPoint, lowRect, 0.000001)) shadowVisible = false;
    }
    return {
      visible: visible,
      footVisible: footVisible,
      shadowVisible: shadowVisible,
      occluderId: occluderId
    };
  }

  function createRuntimeEvent(group, plan) {
    const gap = plan.gaps[group.hazardGapId];
    return {
      id: group.id,
      groupId: group.id,
      groupStart: group.start,
      groupEnd: group.end,
      startPosition: group.start,
      endPosition: group.end,
      gapId: gap.id,
      gapPosition: gap.position,
      hazardPosition: gap.position,
      occupied: group.occupied,
      runSpeed: group.crossSpeed,
      crossSpeed: group.crossSpeed,
      coatColor: group.coatColor,
      skinColor: group.skinColor,
      resolved: false,
      attempts: 0,
      failed: false,
      recorded30: false,
      recorded15: false,
      speedAt30: null,
      speedAt15: null,
      maxSpeedAfter30: 0,
      minSpeedInRisk: Infinity,
      maxLateralShift: 0,
      lateralTime: 0,
      earlySlow: false,
      lateSlow: false,
      earlyLateral: false,
      firstVisibleDistance: null,
      firstVisibleSpeed: null,
      pedestrian: null
    };
  }

  function resetEventRuntime(event) {
    event.recorded30 = false;
    event.recorded15 = false;
    event.speedAt30 = null;
    event.speedAt15 = null;
    event.maxSpeedAfter30 = 0;
    event.minSpeedInRisk = Infinity;
    event.maxLateralShift = 0;
    event.lateralTime = 0;
    event.earlySlow = false;
    event.lateSlow = false;
    event.earlyLateral = false;
    event.firstVisibleDistance = null;
    event.firstVisibleSpeed = null;
    event.pedestrian = {
      state: 'waiting',
      active: false,
      x: C.PEDESTRIAN_START_X,
      visible: false,
      footVisible: false,
      shadowVisible: false,
      cleared: false
    };
  }

  function pedestrianBlocking(simulation, event) {
    const pedestrian = event.pedestrian;
    return event.occupied && pedestrian.state === 'crossing' &&
      pedestrian.x > simulation.x - 19 && !pedestrian.cleared;
  }

  // 示范和测试共用同一个普通驾驶控制器，不使用简化物理或专用碰撞规则。
  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    let target = 47;
    let left = false;
    if (event) {
      const remaining = event.gapPosition - simulation.distance;
      if (remaining <= C.APPROACH_START && simulation.distance <= event.groupEnd + C.RISK_END) {
        target = 18;
        left = true;
      }
      const bumperRemaining = event.gapPosition - (simulation.distance + C.CAR_LENGTH_M / 2);
      if (pedestrianBlocking(simulation, event) && bumperRemaining < 14 && bumperRemaining > -1) {
        target = 0;
      }
    }
    return {
      throttle: simulation.speed < target - 0.45,
      brake: simulation.speed > target + 0.45,
      left: left,
      right: false
    };
  }

  class Simulation {
    constructor(seed) {
      this.seed = seed;
      this.plan = createPlan(seed);
      this.groups = this.plan.groups;
      this.parkedCars = this.plan.parkedCars;
      this.gaps = this.plan.gaps;
      this.events = this.groups.map(function (group) {
        const event = createRuntimeEvent(group, this.plan);
        resetEventRuntime(event);
        return event;
      }, this);
      this.distance = 0;
      this.speed = C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.x = C.CAR_X;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
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
      return this.groups[this.groups.length - 1].end + C.FINISH_BUFFER;
    }

    getRiskEvent() {
      return Scoring.getRiskEvent(this);
    }

    updateVisibility(event) {
      if (!event.occupied || event.pedestrian.state === 'waiting' || event.pedestrian.cleared) return;
      const visibility = visibilityFor(this, event);
      const pedestrian = event.pedestrian;
      pedestrian.visible = visibility.visible;
      pedestrian.footVisible = visibility.footVisible;
      pedestrian.shadowVisible = visibility.shadowVisible;
      if (visibility.visible && event.firstVisibleDistance == null) {
        event.firstVisibleDistance = Math.max(0, event.gapPosition - (this.distance + C.CAR_LENGTH_M / 2));
        event.firstVisibleSpeed = this.speed;
      }
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      if (dt <= 0) return;
      input = input || {};
      this.justHardBrake = false;
      this.justResolved = null;
      this.previousSpeed = this.speed;

      const approachingEvent = this.currentEvent;
      const remaining = approachingEvent ? approachingEvent.gapPosition - this.distance : Infinity;
      const emergencyBrake = approachingEvent && approachingEvent.occupied &&
        approachingEvent.pedestrian.state === 'crossing' && this.speed > C.HARD_BRAKE_MIN_SPEED &&
        remaining < 10 && remaining > -2;
      let acceleration = -C.NATURAL_DECELERATION;
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

      const event = this.currentEvent;
      if (event) {
        this.updateEvent(event, dt);
        Scoring.recordStep(this.scoring, this, dt);
        if (event.occupied && !event.resolved && this.predictConflict(event, input)) {
          this.freeze(event);
          return;
        }
        // 必须驶过整个车阵，而不是只通过有人的那条缝。
        if (!event.resolved && this.distance > event.groupEnd + C.RISK_END) {
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

    updateEvent(event, dt) {
      const distanceToGap = event.gapPosition - this.distance;
      if (distanceToGap <= C.RISK_START && this.distance <= event.groupEnd + C.RISK_END) {
        event.minSpeedInRisk = Math.min(event.minSpeedInRisk, this.speed);
        if (event.recorded30 && distanceToGap > 0) {
          event.maxSpeedAfter30 = Math.max(event.maxSpeedAfter30, this.speed);
        }
        event.maxLateralShift = Math.max(event.maxLateralShift, C.CAR_X - this.x);
        if (distanceToGap > C.LATE_CHECK && this.x <= C.CAR_X - C.LATERAL_SHIFT_PIXELS) {
          event.lateralTime += dt;
          if (event.lateralTime >= C.LATERAL_HOLD_TIME) event.earlyLateral = true;
        }
      }
      if (!event.recorded30 && distanceToGap <= C.SLOW_CHECK) {
        event.recorded30 = true;
        event.speedAt30 = this.speed;
        event.maxSpeedAfter30 = Math.max(event.maxSpeedAfter30, this.speed);
      }
      if (!event.recorded15 && distanceToGap <= C.LATE_CHECK) {
        event.recorded15 = true;
        event.speedAt15 = this.speed;
      }

      if (!event.occupied || event.resolved) return;
      const pedestrian = event.pedestrian;
      if (pedestrian.state === 'waiting' && distanceToGap <= C.EVENT_ACTIVATE) {
        pedestrian.state = 'emerging';
        pedestrian.active = true;
      }
      if (pedestrian.state === 'emerging') {
        pedestrian.x = Math.max(C.PEDESTRIAN_EDGE_X, pedestrian.x - C.PEDESTRIAN_EMERGE_SPEED * dt);
        if (pedestrian.x <= C.PEDESTRIAN_EDGE_X + 0.0001) pedestrian.state = 'atEdge';
      } else if (pedestrian.state === 'atEdge' && distanceToGap <= C.CROSS_TRIGGER) {
        pedestrian.state = 'crossing';
      } else if (pedestrian.state === 'crossing') {
        pedestrian.x = Math.max(C.PEDESTRIAN_CLEAR_X, pedestrian.x - event.crossSpeed * dt);
        if (pedestrian.x <= C.PEDESTRIAN_CLEAR_X + 0.0001) {
          pedestrian.state = 'cleared';
          pedestrian.cleared = true;
          pedestrian.active = false;
          pedestrian.visible = false;
          pedestrian.footVisible = false;
          pedestrian.shadowVisible = false;
        }
      }
      this.updateVisibility(event);
    }

    // 用本帧真实输入外推，并以 25ms 细分扫掠，充分制动能停住时不会误罚。
    predictConflict(event, input) {
      const pedestrian = event.pedestrian;
      if (!event.occupied || pedestrian.state !== 'crossing' || pedestrian.cleared || this.speed < 1) return false;
      const speedMps = this.speed / 3.6;
      const horizon = Math.max(0.55, Math.min(1.25, speedMps * 0.14));
      const substep = 0.025;
      const halfWidth = 14;
      const halfLength = C.CAR_LENGTH_M / 2;
      let distance = this.distance;
      let velocity = speedMps;
      let pedestrianX = pedestrian.x;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = this.acceleration;

      for (let time = 0; time < horizon - 0.000001; time += substep) {
        const slice = Math.min(substep, horizon - time);
        const nextVelocity = M.clamp(velocity + acceleration * slice, 0, C.MAX_SPEED / 3.6);
        const nextDistance = distance + (velocity + nextVelocity) * 0.5 * slice;
        const nextPedestrianX = Math.max(C.PEDESTRIAN_CLEAR_X, pedestrianX - event.crossSpeed * slice);
        const carLeft = this.x - halfWidth;
        const carRight = this.x + halfWidth;
        const pedestrianLeft = Math.min(pedestrianX, nextPedestrianX) - 3;
        const pedestrianRight = Math.max(pedestrianX, nextPedestrianX) + 3;
        const horizontal = pedestrianRight > carLeft && pedestrianLeft < carRight;
        const front = nextDistance + halfLength + 0.25;
        const rear = distance - halfLength - 0.25;
        const vertical = event.gapPosition < front && event.gapPosition > rear;
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
      const visibility = visibilityFor(this, event);
      this.freezeInfo = {
        eventId: event.id,
        speed: this.speed,
        remaining: Math.max(0, event.gapPosition - (this.distance + C.CAR_LENGTH_M / 2)),
        distanceToCross: Math.max(0, event.gapPosition - this.distance),
        stoppingDistance: M.stoppingDistance(this.speed),
        firstVisibleDistance: event.firstVisibleDistance,
        firstVisibleSpeed: event.firstVisibleSpeed,
        lateralMargin: Math.max(0, C.CAR_X - this.x),
        occluderId: visibility.occluderId
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
      const event = this.events[this.freezeInfo ? this.freezeInfo.eventId : (this.demoEventId || 0)];
      if (!event) return;
      this.distance = Math.max(0, event.groupStart - C.APPROACH_START);
      this.speed = 30;
      this.previousSpeed = 30;
      this.lastDeceleration = 0;
      this.acceleration = 0;
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
        demo.events[index].earlyLateral = true;
      }
      const event = demo.events[eventId];
      demo.distance = Math.max(0, event.groupStart - C.APPROACH_START);
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
        (event.resolved && demo.distance > event.groupEnd + 5) || this.demoTime >= 28) {
        this.retryEvent();
      }
    }
  }

  const Scoring = {
    getRiskEvent: function (simulation) {
      return simulation.events.find(function (event) {
        return !event.resolved && simulation.distance >= event.gapPosition - C.RISK_START &&
          simulation.distance <= event.groupEnd + C.RISK_END;
      }) || null;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || simulation.speed >= 1.2 || !pedestrianBlocking(simulation, event)) return false;
      const remaining = event.gapPosition - (simulation.distance + C.CAR_LENGTH_M / 2);
      return remaining >= C.YIELD_ZONE_NEAR && remaining <= C.YIELD_ZONE_FAR;
    },

    recordStep: function (state, simulation, dt) {
      const event = Scoring.getRiskEvent(simulation);
      const exempt = Scoring.isYieldExempt(simulation);
      // 必要让行既不计入效率分子，也不计入分母；清空后的停车不再豁免。
      if (!exempt) {
        const quality = Game.Scoring.speedQuality(simulation.speed, Boolean(event));
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const harsh = simulation.lastDeceleration > C.HARD_BRAKE &&
        simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED;
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
      return speedScore + (event.earlyLateral ? 2 : 0);
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
        ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
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
      let adviceKey = 'scene.parked.result.advice.default';
      if (failed) adviceKey = 'scene.parked.result.advice.failed';
      else if (earlySlowCount < 3) adviceKey = 'scene.parked.result.advice.early';
      else if (state.hardBrakes > 0) adviceKey = 'result.advice.braking';
      else if (timedOut || efficiency < 12) adviceKey = 'result.advice.efficiency';
      else if (observation < 28) adviceKey = 'scene.parked.result.advice.observation';

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

  function worldY(simulation, worldPosition) {
    return Draw.worldY(C, simulation, worldPosition);
  }

  function drawRiskZone(ctx, simulation, event) {
    const top = worldY(simulation, event.groupEnd + C.RISK_END);
    const bottom = worldY(simulation, event.gapPosition - C.RISK_START);
    if (bottom < 0 || top > C.HEIGHT) return;
    ctx.save();
    ctx.globalAlpha = 0.12;
    Draw.rect(ctx, '#f4c75b', 176, Math.max(0, top), 66, Math.min(C.HEIGHT, bottom) - Math.max(0, top));
    ctx.restore();

    const markerY = worldY(simulation, event.gapPosition - C.SLOW_CHECK);
    if (markerY > 105 && markerY < C.HEIGHT - 20) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ffe292';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(176, markerY);
      ctx.lineTo(244, markerY);
      ctx.stroke();
      ctx.restore();
      const markerText = t('scene.parked.canvas.slowMarker');
      Draw.rect(ctx, '#142630dd', 174, markerY - 14, 70, 12);
      ctx.fillStyle = '#ffe6a4';
      Draw.fillFittedText(ctx, markerText, 178, markerY - 5, 62, 8, 'sans-serif');
    }
  }

  function drawParkedCars(ctx, simulation) {
    simulation.parkedCars.forEach(function (car) {
      const y = worldY(simulation, car.position);
      if (y < -35 || y > C.HEIGHT + 35) return;
      Draw.drawCar(ctx, C.PARKED_X, y, car.color, false);
      // 违停车的驻车/警示标记，不增加另一套碰撞几何。
      Draw.rect(ctx, '#f2c14e', C.PARKED_X - 11, y + 18, 4, 3);
    });
  }

  function drawPedestrianAndClues(ctx, simulation, event, demo, xray) {
    if (!event.occupied) return;
    const pedestrian = event.pedestrian;
    if (pedestrian.state === 'waiting' || pedestrian.cleared) return;
    const visibility = xray ? {
      visible: pedestrian.visible,
      footVisible: pedestrian.footVisible,
      shadowVisible: pedestrian.shadowVisible
    } : visibilityFor(simulation, event);
    const y = worldY(simulation, event.gapPosition);
    if (y < -20 || y > C.HEIGHT + 20) return;

    if (visibility.visible) {
      Draw.drawPedestrian(ctx, C, pedestrian.x, y, event, false, demo);
    } else if (xray) {
      Draw.drawPedestrian(ctx, C, pedestrian.x, y, event, true, demo);
    } else {
      // 只画由同一行人位置和低轮廓 LOS 证实的线索，不泄露躯干。
      if (visibility.shadowVisible) {
        ctx.save();
        ctx.globalAlpha = 0.34;
        Draw.rect(ctx, '#101f26', pedestrian.x - 5, y + 5, 15, 5);
        ctx.restore();
      }
      if (visibility.footVisible) {
        Draw.rect(ctx, '#26333a', pedestrian.x - 3, y + 5, 2, 5);
        Draw.rect(ctx, '#26333a', pedestrian.x + 2, y + 5, 2, 5);
      }
    }
  }

  function drawWorld(ctx, simulation, demo) {
    Draw.drawEnvironment(ctx, simulation, C, 172);
    simulation.events.forEach(function (event) { drawRiskZone(ctx, simulation, event); });
    drawParkedCars(ctx, simulation);
    simulation.events.forEach(function (event) {
      drawPedestrianAndClues(ctx, simulation, event, demo, false);
    });
    Draw.drawCar(ctx, simulation.x, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    if (demo) {
      Draw.rect(ctx, '#0e202ddd', 204, 552, 138, 47);
      ctx.fillStyle = '#a6f0c8';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(Math.round(simulation.speed) + ' km/h', 212, 575);
      ctx.fillStyle = '#d4e3db';
      const key = Scoring.isYieldExempt(simulation) ? 'scene.parked.canvas.wait' : 'scene.parked.hud.controlled';
      Draw.fillFittedText(ctx, t(key), 212, 590, 122, 9, 'sans-serif');
    }
  }

  function drawFreeze(ctx, simulation) {
    const event = simulation.events[simulation.freezeInfo.eventId];
    // 只有教学定格允许透视；明确用虚线视线与正常画面区分。
    drawPedestrianAndClues(ctx, simulation, event, false, true);
    const pedestrian = event.pedestrian;
    if (pedestrian.state !== 'waiting' && !pedestrian.cleared) {
      const pedestrianY = worldY(simulation, event.gapPosition);
      ctx.save();
      ctx.strokeStyle = '#fff0a8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(simulation.x, C.CAR_Y - 5);
      ctx.lineTo(pedestrian.x, pedestrianY);
      ctx.stroke();
      ctx.restore();
    }
    Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
    const x = simulation.x + 21;
    const y = C.CAR_Y - 30;
    Draw.rect(ctx, '#fff0b0', x, y, 22, 24);
    Draw.rect(ctx, '#3b2a0e', x + 9, y + 4, 4, 10);
    Draw.rect(ctx, '#3b2a0e', x + 9, y + 17, 4, 4);
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        drawWorld(ctx, simulation.demo, true);
        return;
      }
      drawWorld(ctx, simulation, false);
      if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
    }
  };

  Scenes['parked-cars'] = {
    id: 'parked-cars',
    Constants: C,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    Geometry: {
      segmentIntersectsAABB: segmentIntersectsAABB,
      segmentAABB: segmentIntersectsAABB,
      visibilityFor: visibilityFor
    },
    defensiveInput: defensiveInput,
    pedestrianBlocking: pedestrianBlocking,
    ui: {
      progress: function (simulation) {
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.parked.hud.progress', { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && !event.failed; }).length
        ];
      },
      coach: function (simulation, displaySpeed) {
        const event = simulation.getRiskEvent();
        const upcoming = simulation.currentEvent;
        const approachDistance = upcoming ? upcoming.gapPosition - simulation.distance : Infinity;
        const pedestrian = upcoming && upcoming.occupied ? upcoming.pedestrian : null;
        const active = pedestrian && pedestrian.state !== 'waiting' && !pedestrian.cleared;
        let coach = 'scene.parked.hud.cruise';
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

        if (event) {
          coachTone = 'risk';
          if (active && pedestrian.visible && pedestrian.state === 'crossing') {
            coach = 'scene.parked.hud.pedestrian';
            status = displaySpeed < 1.2 ? 'hud.yielding' : 'hud.prepareStop';
            tone = displaySpeed < 1.2 ? '' : 'warn';
          } else if (active && !pedestrian.visible && (pedestrian.footVisible || pedestrian.shadowVisible)) {
            coach = 'scene.parked.hud.cue';
            status = 'hud.prepareSlow';
            coachTone = 'risk';
          } else if (displaySpeed > C.RISK_MAX_SPEED) {
            coach = 'scene.parked.hud.brakeNow';
            status = 'hud.tooFast';
            tone = 'danger';
          } else if (displaySpeed > C.SAFE_SPEED) {
            coach = 'hud.keepSlowing';
            status = 'hud.slowing';
            tone = 'warn';
          } else {
            coach = 'scene.parked.hud.controlled';
            status = displaySpeed < 8 ? 'hud.tooSlowRisk' : 'hud.defensive';
            tone = displaySpeed < 8 ? 'warn' : '';
            coachTone = displaySpeed < 8 ? 'risk' : 'good';
          }
        } else if (upcoming && approachDistance <= C.APPROACH_START && approachDistance > C.RISK_START) {
          coach = upcoming.id > 0 && simulation.x > C.CAR_X - C.LATERAL_SHIFT_PIXELS
            ? 'scene.parked.hud.lateral' : 'scene.parked.hud.approach';
          status = 'hud.prepareSlow';
          coachTone = 'risk';
        } else if (upcoming && simulation.distance > upcoming.groupEnd + C.RISK_END) {
          coach = 'hud.resumeSpeed';
        }

        return {
          text: t(coach),
          coachTone: coachTone,
          status: t(simulation.status === 'ready' ? 'hud.ready' : status),
          tone: tone
        };
      },
      retryToast: function () {
        return { key: 'scene.parked.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const observation = Scoring.eventObservation(event);
        if (event.earlySlow) {
          return {
            key: event.occupied ? 'toast.safeOccupied' : 'toast.safeEmpty',
            params: { score: observation },
            neutral: false
          };
        }
        if (event.lateSlow) return { key: 'toast.late', params: {}, neutral: true };
        return { key: 'scene.parked.toast.fast', params: {}, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.parked.failure.reason', {
          speed: Math.round(info.speed),
          remaining: Math.max(0, info.remaining).toFixed(1),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo.events[simulation.demoEventId];
        const pedestrian = event.pedestrian;
        let key = 'scene.parked.demo.slow';
        if (event.resolved || pedestrian.cleared) key = 'scene.parked.demo.pass';
        else if (Scoring.isYieldExempt(demo) || (demo.speed < 1.2 && pedestrian.state === 'crossing')) {
          key = 'scene.parked.demo.wait';
        } else if (event.gapPosition - demo.distance <= C.SLOW_CHECK + 5) {
          key = 'scene.parked.demo.space';
        }
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
