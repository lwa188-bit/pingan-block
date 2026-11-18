(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;

  function t(key, params) {
    return Game.I18N.t(key, params);
  }

  const C = Object.assign({}, Game.C, {
    EVENT_POSITIONS: [125, 325, 525],
    EVENT_ACTIVATE: 65,
    APPROACH_START: 55,
    RISK_START: 35,
    RISK_END: 4,
    FINISH_BUFFER: 18,
    MAX_TIME: 110,
    STOP_LINE_GAP: 4,
    STOP_CENTER_NEAR: 6.6,
    STOP_CENTER_FAR: 15.5,
    STOP_HOLD_TIME: 0.3,
    YIELD_ZONE_FAR: 22,
    PEDESTRIAN_LEFT_START: 76,
    PEDESTRIAN_RIGHT_START: 304,
    PEDESTRIAN_LEFT_CLEAR: 64,
    PEDESTRIAN_RIGHT_CLEAR: 316,
    SURGE_DURATION: 0.5,
    TURN_SLOW_DURATION: 0.35,
    TURN_DURATION: 0.55,
    CAR_X: 210
  });

  function shuffle(values, random) {
    const result = values.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      const swap = result[index];
      result[index] = result[other];
      result[other] = swap;
    }
    return result;
  }

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed('crosswalk-turnback:' + seed));
    const behaviors = shuffle(['normal', 'surge', 'turnback'], random);
    const coats = ['#f4d35e', '#ee6c72', '#7fd1ed'];
    const events = C.EVENT_POSITIONS.map(function (position, id) {
      const direction = random() < 0.5 ? 1 : -1;
      const behavior = behaviors[id];
      const startX = direction > 0 ? C.PEDESTRIAN_LEFT_START : C.PEDESTRIAN_RIGHT_START;
      const clearX = direction > 0 ? C.PEDESTRIAN_RIGHT_CLEAR : C.PEDESTRIAN_LEFT_CLEAR;
      // 折返点固定在玩家车道之后；是否折返由种子决定，不读取玩家输入。
      const changeX = direction > 0
        ? (behavior === 'turnback' ? 226 + random() * 18 : behavior === 'surge' ? 264 + random() * 16 : 192 + random() * 24)
        : (behavior === 'turnback' ? 176 - random() * 18 : behavior === 'surge' ? 116 - random() * 16 : 204 - random() * 24);
      return Object.freeze({
        id: id,
        crossingPosition: position,
        behavior: behavior,
        direction: direction,
        startX: startX,
        clearX: clearX,
        changeX: changeX,
        walkSpeed: 22 + random() * 4,
        surgeSpeed: 29 + random() * 5,
        returnSpeed: 30 + random() * 5,
        coatColor: coats[Math.floor(random() * coats.length)],
        skinColor: random() > 0.5 ? '#efb489' : '#c88760'
      });
    });
    return Object.freeze({ events: Object.freeze(events) });
  }

  function createRuntimeEvent(plan) {
    const event = Object.assign({}, plan);
    event.resolved = false;
    event.attempts = 0;
    event.failed = false;
    resetEventRuntime(event);
    return event;
  }

  function resetEventRuntime(event) {
    event.recordedSlow = false;
    event.recordedLate = false;
    event.speedAtSlow = null;
    event.speedAtLate = null;
    event.maxSpeedAfterSlow = 0;
    event.earlySlow = false;
    event.lateSlow = false;
    event.stopDuration = 0;
    event.properStop = false;
    event.waitedUntilClear = false;
    event.earlyStart = false;
    event.lineViolation = false;
    event.occupiedPass = false;
    event.stoppedDistance = null;
    event.pedestrian = {
      state: 'waiting',
      active: false,
      x: event.startX,
      direction: event.direction,
      speed: event.walkSpeed,
      surgeElapsed: 0,
      turnTimer: 0,
      cleared: false
    };
  }

  function pedestrianAtChangePoint(event, pedestrian) {
    return event.direction > 0 ? pedestrian.x >= event.changeX : pedestrian.x <= event.changeX;
  }

  function pedestrianAtClearPoint(event, pedestrian) {
    const target = pedestrian.state === 'returning' ? event.startX : event.clearX;
    return pedestrian.direction > 0 ? pedestrian.x >= target : pedestrian.x <= target;
  }

  // 只由固定事件计划和行人自身进度驱动；正式模拟与碰撞预测共用。
  function advancePedestrian(event, pedestrian, dt) {
    if (!pedestrian.active || pedestrian.cleared) return;
    if (pedestrian.state === 'waiting') pedestrian.state = 'walking';

    if (pedestrian.state === 'slowing') {
      pedestrian.turnTimer = Math.max(0, pedestrian.turnTimer - dt);
      pedestrian.speed = event.walkSpeed * (pedestrian.turnTimer / C.TURN_SLOW_DURATION);
      if (pedestrian.turnTimer <= 0) {
        pedestrian.state = 'turning';
        pedestrian.turnTimer = C.TURN_DURATION;
        pedestrian.speed = 0;
        return;
      }
    } else if (pedestrian.state === 'turning') {
      pedestrian.turnTimer -= dt;
      if (pedestrian.turnTimer <= 0) {
        pedestrian.state = 'returning';
        pedestrian.direction = -event.direction;
        pedestrian.speed = event.returnSpeed;
      }
      return;
    }

    if (event.behavior === 'turnback' && pedestrian.state === 'walking' && pedestrianAtChangePoint(event, pedestrian)) {
      pedestrian.x = event.changeX;
      pedestrian.state = 'slowing';
      pedestrian.turnTimer = C.TURN_SLOW_DURATION;
    }
    if (event.behavior === 'surge' && pedestrian.state === 'walking' && pedestrianAtChangePoint(event, pedestrian)) {
      pedestrian.state = 'surging';
      pedestrian.surgeElapsed = 0;
    }
    if (pedestrian.state === 'surging') {
      pedestrian.surgeElapsed = Math.min(C.SURGE_DURATION, pedestrian.surgeElapsed + dt);
      const progress = pedestrian.surgeElapsed / C.SURGE_DURATION;
      pedestrian.speed = event.walkSpeed + (event.surgeSpeed - event.walkSpeed) * progress;
    }

    pedestrian.x += pedestrian.direction * pedestrian.speed * dt;
    if (pedestrianAtClearPoint(event, pedestrian)) {
      pedestrian.x = pedestrian.state === 'returning' ? event.startX : event.clearX;
      pedestrian.state = 'cleared';
      pedestrian.cleared = true;
      pedestrian.active = false;
      pedestrian.speed = 0;
    }
  }

  function pedestrianRequired(event) {
    const pedestrian = event.pedestrian;
    return pedestrian.active && !pedestrian.cleared;
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    let target = 47;
    if (event) {
      const remaining = event.crossingPosition - simulation.distance;
      if (remaining <= C.APPROACH_START && simulation.distance <= event.crossingPosition + C.RISK_END) {
        target = 18;
      }
      if (pedestrianRequired(event) && remaining <= 15.5 && remaining > -C.RISK_END) {
        target = 0;
      }
    }
    return {
      throttle: simulation.speed < target - 0.45,
      brake: simulation.speed > target + 0.45
    };
  }

  class Simulation {
    constructor(seed) {
      this.seed = seed;
      this.plan = createPlan(seed);
      this.events = this.plan.events.map(createRuntimeEvent);
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
      return C.EVENT_POSITIONS[C.EVENT_POSITIONS.length - 1] + C.FINISH_BUFFER;
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

      const eventBefore = this.currentEvent;
      const remaining = eventBefore ? eventBefore.crossingPosition - this.distance : Infinity;
      const emergencyBrake = eventBefore && pedestrianRequired(eventBefore) &&
        this.speed > C.HARD_BRAKE_MIN_SPEED && remaining < 10 && remaining > -2;
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

      const event = this.currentEvent;
      if (event) {
        this.updateEvent(event, dt);
        Scoring.recordStep(this.scoring, this, dt);
        if (!event.resolved && event.lineViolation && this.speed > C.RISK_MAX_SPEED && pedestrianRequired(event)) {
          this.freeze(event);
          return;
        }
        if (!event.resolved && this.predictConflict(event, input)) {
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

    updateEvent(event, dt) {
      const distanceToCross = event.crossingPosition - this.distance;
      if (distanceToCross <= C.RISK_START && distanceToCross >= -C.RISK_END) {
        if (event.recordedSlow && distanceToCross > 0 && !event.pedestrian.cleared) {
          event.maxSpeedAfterSlow = Math.max(event.maxSpeedAfterSlow, this.speed);
        }
      }
      if (!event.recordedSlow && distanceToCross <= C.SLOW_CHECK) {
        event.recordedSlow = true;
        event.speedAtSlow = this.speed;
        if (!event.pedestrian.cleared) event.maxSpeedAfterSlow = Math.max(event.maxSpeedAfterSlow, this.speed);
      }
      if (!event.recordedLate && distanceToCross <= C.LATE_CHECK) {
        event.recordedLate = true;
        event.speedAtLate = this.speed;
      }

      const pedestrian = event.pedestrian;
      if (!pedestrian.active && !pedestrian.cleared && distanceToCross <= C.EVENT_ACTIVATE) {
        pedestrian.active = true;
        pedestrian.state = 'walking';
      }
      const wasCleared = pedestrian.cleared;
      advancePedestrian(event, pedestrian, dt);

      const stopLine = event.crossingPosition - C.STOP_LINE_GAP;
      const carFront = this.distance + C.CAR_LENGTH_M / 2;
      if (pedestrianRequired(event) && carFront > stopLine + 0.15) event.lineViolation = true;

      const stopOffset = event.crossingPosition - this.distance;
      const inStopZone = stopOffset >= C.STOP_CENTER_NEAR && stopOffset <= C.STOP_CENTER_FAR;
      if (pedestrianRequired(event) && inStopZone && this.speed < 1) {
        event.stopDuration += dt;
        if (event.stopDuration >= C.STOP_HOLD_TIME && !event.properStop) {
          event.properStop = true;
          event.stoppedDistance = this.distance;
        }
      } else {
        event.stopDuration = 0;
      }
      if (event.properStop && pedestrianRequired(event) &&
        (this.speed > 2 || this.distance > event.stoppedDistance + 0.25)) {
        event.earlyStart = true;
      }
      if (!wasCleared && pedestrian.cleared && event.properStop && !event.earlyStart && this.speed < 1.2) {
        event.waitedUntilClear = true;
      }
    }

    // 外推当前踏板输入与同一种行人状态机，充分制动能避免接触时不提前判罚。
    predictConflict(event, input) {
      const pedestrian = event.pedestrian;
      if (!pedestrianRequired(event) || this.speed < 0.8) return false;
      const speedMps = this.speed / 3.6;
      const horizon = Math.max(0.6, Math.min(1.8, speedMps * 0.16));
      const substep = 0.025;
      const halfLength = C.CAR_LENGTH_M / 2;
      let distance = this.distance;
      let velocity = speedMps;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = this.acceleration;
      const predictedPedestrian = Object.assign({}, pedestrian);

      for (let time = 0; time < horizon - 0.000001; time += substep) {
        const slice = Math.min(substep, horizon - time);
        const nextVelocity = M.clamp(velocity + acceleration * slice, 0, C.MAX_SPEED / 3.6);
        const nextDistance = distance + (velocity + nextVelocity) * 0.5 * slice;
        const previousX = predictedPedestrian.x;
        advancePedestrian(event, predictedPedestrian, slice);
        const pedestrianLeft = Math.min(previousX, predictedPedestrian.x) - 4;
        const pedestrianRight = Math.max(previousX, predictedPedestrian.x) + 4;
        const horizontal = pedestrianRight > this.x - 14 && pedestrianLeft < this.x + 14;
        const front = nextDistance + halfLength + 0.2;
        const rear = distance - halfLength - 0.2;
        const vertical = event.crossingPosition < front && event.crossingPosition > rear;
        if (!predictedPedestrian.cleared && horizontal && vertical) return true;
        distance = nextDistance;
        velocity = nextVelocity;
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
        remaining: Math.max(0, event.crossingPosition - (this.distance + C.CAR_LENGTH_M / 2)),
        stoppingDistance: M.stoppingDistance(this.speed),
        behavior: event.pedestrian.state,
        cause: event.lineViolation && this.speed > C.RISK_MAX_SPEED ? 'noStop' : (event.earlyStart ? 'earlyStart' : 'conflict'),
        earlyStart: event.earlyStart
      };
    }

    resolveEvent(event) {
      event.resolved = true;
      event.occupiedPass = !event.pedestrian.cleared;
      event.earlySlow = event.speedAtSlow != null && event.speedAtSlow <= C.SAFE_SPEED &&
        event.maxSpeedAfterSlow <= C.RISK_MAX_SPEED;
      event.lateSlow = !event.earlySlow && event.speedAtLate != null && event.speedAtLate <= C.RISK_MAX_SPEED;
      this.justResolved = event;
    }

    retryEvent() {
      const event = this.events[this.freezeInfo ? this.freezeInfo.eventId : (this.demoEventId || 0)];
      if (!event) return;
      this.distance = Math.max(0, event.crossingPosition - C.APPROACH_START);
      this.speed = 30;
      this.previousSpeed = 30;
      this.lastDeceleration = 0;
      this.acceleration = 0;
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
        demo.events[index].properStop = true;
        demo.events[index].waitedUntilClear = true;
      }
      demo.distance = Math.max(0, demo.events[eventId].crossingPosition - C.APPROACH_START);
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
        (event.resolved && demo.distance > event.crossingPosition + 5) || this.demoTime >= 35) {
        this.retryEvent();
      }
    }
  }

  const Scoring = {
    getRiskEvent: function (simulation) {
      return simulation.events.find(function (event) {
        return !event.resolved && simulation.distance >= event.crossingPosition - C.RISK_START &&
          simulation.distance <= event.crossingPosition + C.RISK_END;
      }) || null;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || simulation.speed >= 1.2 || !pedestrianRequired(event)) return false;
      const bumperRemaining = event.crossingPosition - (simulation.distance + C.CAR_LENGTH_M / 2);
      return bumperRemaining >= 0 && bumperRemaining <= C.YIELD_ZONE_FAR;
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
      const speedScore = event.earlySlow ? 3 : (event.lateSlow ? 1 : 0);
      const stopScore = event.properStop ? 4 : 0;
      const waitScore = event.properStop && event.waitedUntilClear && !event.earlyStart && !event.lineViolation ? 3 : 0;
      return speedScore + stopScore + waitScore;
    },

    eventSafe: function (event) {
      return !event.failed && !event.lineViolation && !event.occupiedPass;
    },

    summarize: function (simulation, timedOut) {
      const state = simulation.scoring;
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(Scoring.eventSafe);
      const observation = simulation.events.reduce(function (sum, event) {
        return sum + (event.resolved ? Scoring.eventObservation(event) : 0);
      }, 0);
      const safety = Math.round(clean.length * (40 / 3));
      const efficiency = state.efficiencyTime > 0 ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
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
        summaryKey = 'scene.turnback.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }

      const earlySlowCount = simulation.events.filter(function (event) { return event.earlySlow; }).length;
      let adviceKey = 'scene.turnback.result.advice.default';
      if (failed) adviceKey = 'scene.turnback.result.advice.failed';
      else if (simulation.events.some(function (event) { return event.earlyStart; })) adviceKey = 'scene.turnback.result.advice.earlyStart';
      else if (earlySlowCount < 3) adviceKey = 'scene.turnback.result.advice.early';
      else if (state.hardBrakes > 0) adviceKey = 'result.advice.braking';
      else if (timedOut || efficiency < 12) adviceKey = 'result.advice.efficiency';
      else if (observation < 28) adviceKey = 'scene.turnback.result.advice.observation';

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

  function drawCrosswalk(ctx, simulation, event) {
    const y = worldY(simulation, event.crossingPosition);
    if (y < -40 || y > C.HEIGHT + 40) return;
    for (let x = 88; x < 292; x += 18) Draw.rect(ctx, '#d8dcd2', x, y - 9, 10, 18);
    const stopY = worldY(simulation, event.crossingPosition - C.STOP_LINE_GAP);
    Draw.rect(ctx, '#f0ead2', 176, stopY, 114, 3);

    if (pedestrianRequired(event)) {
      const nearY = worldY(simulation, event.crossingPosition - C.STOP_CENTER_NEAR);
      const farY = worldY(simulation, event.crossingPosition - C.STOP_CENTER_FAR);
      ctx.save();
      ctx.globalAlpha = 0.12;
      Draw.rect(ctx, '#80e0b1', 180, farY, 58, nearY - farY);
      ctx.restore();
    }
    ctx.fillStyle = '#e9e3c9';
    Draw.fillFittedText(ctx, t('scene.turnback.canvas.stop'), 181, stopY + 15, 52, 9, 'sans-serif');
  }

  function drawRiskZone(ctx, simulation, event) {
    const top = worldY(simulation, event.crossingPosition + C.RISK_END);
    const bottom = worldY(simulation, event.crossingPosition - C.RISK_START);
    if (bottom < 0 || top > C.HEIGHT) return;
    ctx.save();
    ctx.globalAlpha = 0.09;
    Draw.rect(ctx, '#f4c75b', 176, Math.max(0, top), 66, Math.min(C.HEIGHT, bottom) - Math.max(0, top));
    ctx.restore();
    const markerY = worldY(simulation, event.crossingPosition - C.SLOW_CHECK);
    if (markerY > 108 && markerY < C.HEIGHT - 20) {
      Draw.rect(ctx, '#142630dd', 178, markerY - 14, 64, 12);
      ctx.fillStyle = '#ffe6a4';
      Draw.fillFittedText(ctx, t('scene.turnback.canvas.slowMarker'), 182, markerY - 5, 56, 8, 'sans-serif');
    }
  }

  function drawPedestrian(ctx, simulation, event, demo) {
    const pedestrian = event.pedestrian;
    if (!pedestrian.active || pedestrian.cleared) return;
    const y = worldY(simulation, event.crossingPosition);
    Draw.drawPedestrian(ctx, C, pedestrian.x, y, event, false, demo);
    if (pedestrian.state === 'surging') {
      const behind = pedestrian.direction > 0 ? -1 : 1;
      Draw.rect(ctx, '#f4f0dd99', pedestrian.x + behind * 9, y - 3, 5, 1);
      Draw.rect(ctx, '#f4f0dd77', pedestrian.x + behind * 13, y + 2, 7, 1);
    } else if (pedestrian.state === 'slowing' || pedestrian.state === 'turning' || pedestrian.state === 'returning') {
      ctx.save();
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(pedestrian.x, y, 10, -Math.PI * 0.8, Math.PI * 0.35);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawFreeze(ctx, simulation) {
    const event = simulation.events[simulation.freezeInfo.eventId];
    const pedestrian = event.pedestrian;
    if (pedestrian.active && !pedestrian.cleared) {
      const y = worldY(simulation, event.crossingPosition);
      const target = pedestrian.state === 'returning' || pedestrian.state === 'turning' || pedestrian.state === 'slowing' ? event.startX : event.clearX;
      ctx.save();
      ctx.strokeStyle = '#fff0a8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(pedestrian.x, y);
      ctx.lineTo(target, y);
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

  function drawWorld(ctx, simulation, demo) {
    Draw.drawEnvironment(ctx, simulation, C, 172);
    simulation.events.forEach(function (event) { drawRiskZone(ctx, simulation, event); });
    simulation.events.forEach(function (event) {
      drawCrosswalk(ctx, simulation, event);
      drawPedestrian(ctx, simulation, event, demo);
    });
    Draw.drawCar(ctx, simulation.x, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    if (demo) {
      Draw.rect(ctx, '#0e202ddd', 204, 552, 138, 47);
      ctx.fillStyle = '#a6f0c8';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(Math.round(simulation.speed) + ' km/h', 212, 575);
      ctx.fillStyle = '#d4e3db';
      const key = Scoring.isYieldExempt(simulation) ? 'scene.turnback.canvas.wait' : 'scene.turnback.canvas.principles';
      Draw.fillFittedText(ctx, t(key), 212, 590, 122, 9, 'sans-serif');
    }
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

  Scenes['crosswalk-turnback'] = {
    id: 'crosswalk-turnback',
    Constants: C,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    defensiveInput: defensiveInput,
    pedestrianRequired: pedestrianRequired,
    ui: {
      progress: function (simulation) {
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.turnback.hud.progress', { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && Scoring.eventSafe(event); }).length
        ];
      },
      coach: function (simulation, displaySpeed) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        const remaining = event ? event.crossingPosition - current.distance : Infinity;
        const pedestrian = event && pedestrianRequired(event) ? event.pedestrian : null;
        let coach = 'scene.turnback.hud.cruise';
        let status = displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : 'hud.speedUp';
        let tone = '';
        let coachTone = '';

        if (displaySpeed < 25 && !pedestrian && (!event || remaining > C.RISK_START)) {
          status = 'hud.tooSlow';
          tone = 'warn';
        } else if (displaySpeed > 55 && (!event || remaining > C.RISK_START)) {
          status = 'hud.nearLimit';
          tone = 'danger';
        }

        if (pedestrian && remaining <= C.APPROACH_START) {
          coachTone = displaySpeed < 1.2 ? 'good' : 'risk';
          status = displaySpeed < 1.2 ? 'hud.yielding' : 'hud.prepareStop';
          tone = displaySpeed < 1.2 ? '' : 'warn';
          if (pedestrian.state === 'slowing' || pedestrian.state === 'turning' || pedestrian.state === 'returning') coach = 'scene.turnback.hud.turnback';
          else if (pedestrian.state === 'surging') coach = 'scene.turnback.hud.surge';
          else if (displaySpeed < 1.2) coach = 'scene.turnback.hud.wait';
          else coach = 'scene.turnback.hud.stop';
        } else if (event && event.pedestrian.cleared && current.distance <= event.crossingPosition + C.RISK_END) {
          coach = 'scene.turnback.hud.resume';
          status = 'hud.speedUp';
          coachTone = 'good';
        } else if (event && remaining <= C.APPROACH_START && remaining > C.RISK_START) {
          coach = 'scene.turnback.hud.approach';
          status = 'hud.prepareSlow';
          coachTone = 'risk';
        }

        return {
          text: t(coach),
          coachTone: coachTone,
          status: t(simulation.status === 'ready' ? 'hud.ready' : status),
          tone: tone
        };
      },
      retryToast: function () {
        return { key: 'scene.turnback.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const observation = Scoring.eventObservation(event);
        if (observation === 10) return { key: 'scene.turnback.toast.safe', params: { score: observation }, neutral: false };
        if (event.earlyStart) return { key: 'scene.turnback.toast.earlyStart', params: {}, neutral: true };
        if (!event.properStop) return { key: 'scene.turnback.toast.noStop', params: {}, neutral: true };
        return { key: 'scene.turnback.toast.late', params: { score: observation }, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t(info.cause === 'noStop' ? 'scene.turnback.failure.noStop' :
          (info.earlyStart ? 'scene.turnback.failure.earlyStart' : 'scene.turnback.failure.reason'), {
          speed: Math.round(info.speed),
          remaining: Math.max(0, info.remaining).toFixed(1),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo.events[simulation.demoEventId];
        const pedestrian = event.pedestrian;
        const remaining = event.crossingPosition - demo.distance;
        let key = 'scene.turnback.demo.slow';
        if (event.resolved || pedestrian.cleared) key = 'scene.turnback.demo.pass';
        else if (pedestrianRequired(event) && demo.speed < 1.2) {
          key = pedestrian.state === 'slowing' || pedestrian.state === 'turning' || pedestrian.state === 'returning'
            ? 'scene.turnback.demo.turnback' : 'scene.turnback.demo.wait';
        } else if (pedestrianRequired(event) && remaining <= 20) key = 'scene.turnback.demo.stop';
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
