(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;

  function t(key, params) {
    return Game.I18N.t(key, params);
  }

  // 纵向距离以米计，横向位置以 Canvas 像素计；视线计算统一转换为像素。
  const C = Object.assign({}, Game.C, {
    EVENT_POSITIONS: [145, 365, 585],
    EVENT_ACTIVATE: 95,
    APPROACH_START: 92,
    RECOGNITION_CHECK: 65,
    SLOW_CHECK: 45,
    RISK_START: 70,
    RISK_END: 8,
    FINISH_BUFFER: 32,
    MAX_TIME: 125,
    CAR_X: 210,
    CAR_MIN_X: 194,
    CAR_MAX_X: 226,
    SIDE_ROAD_HALF_WIDTH_M: 4.4,
    OBSERVE_LINE_OFFSET_M: 5.4,
    OBSERVE_ZONE_DEPTH_M: 5,
    STOP_SPEED: 0.6,
    STOP_DWELL: 0.65,
    SCAN_DWELL: 0.45,
    YIELD_ZONE_FAR: 22,
    CROSS_CAR_HALF_WIDTH: 22,
    CROSS_CAR_HALF_LENGTH_M: 0.9,
    CONTACT_HALF_WIDTH: 36,
    CLOSE_PASS_MARGIN_PX: 4,
    CROSS_CLEAR_LEFT_X: 152,
    CROSS_CLEAR_RIGHT_X: 268,
    STEER_SPEED: 16
  });

  const CN_RULE_PACK = Object.freeze({
    id: 'CN',
    stopBeforeEntering: true,
    yieldToRight: true
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

  function pointVisible(event, eyeX, eyeDistance, targetX, targetPosition) {
    const scale = C.PIXELS_PER_METER;
    const eye = { x: eyeX, y: (eyeDistance + 0.8) * scale };
    const target = { x: targetX, y: targetPosition * scale };
    for (let index = 0; index < event.occluders.length; index += 1) {
      const source = event.occluders[index];
      const rect = {
        left: source.left,
        right: source.right,
        bottom: source.bottom * scale,
        top: source.top * scale
      };
      if (segmentIntersectsAABB(eye, target, rect)) {
        return { visible: false, occluderId: source.id };
      }
    }
    return { visible: true, occluderId: null };
  }

  function visibilityFor(simulation, event) {
    const actor = event.actor;
    if (!actor || !actor.active || actor.cleared) return { visible: false, occluderId: null };
    const samples = [actor.x, actor.x + event.direction * 18, actor.x - event.direction * 18];
    let blocked = null;
    for (let index = 0; index < samples.length; index += 1) {
      const result = pointVisible(event, simulation.x, simulation.distance, samples[index], event.position);
      if (result.visible) return { visible: true, occluderId: null, sampleX: samples[index] };
      blocked = result;
    }
    return blocked;
  }

  function scanSightlinesClear(simulation, event) {
    const left = pointVisible(event, simulation.x, simulation.distance, 170, event.position);
    const right = pointVisible(event, simulation.x, simulation.distance, 250, event.position);
    return left.visible && right.visible;
  }

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed('unsignalized-cross-traffic:' + seed));
    const paintRandom = M.mulberry32(M.hashSeed('cross-traffic-paint:' + seed));
    const behaviors = shuffle(['right-through', 'left-yields', 'left-late'], random);
    const colors = ['#e5b84f', '#6fa7bb', '#c6c9b8', '#d98568'];
    const events = C.EVENT_POSITIONS.map(function (basePosition, id) {
      const behavior = behaviors[id];
      const direction = behavior === 'right-through' ? -1 : 1;
      const speedKmh = behavior === 'left-yields' ? 30 + random() * 6 : 32 + random() * 6;
      const speed = speedKmh / 3.6;
      const position = basePosition + (random() - 0.5) * 6;
      const fastTime = (C.EVENT_ACTIVATE - 8) / (C.MAX_SPEED / 3.6);
      const contactTarget = direction > 0 ? C.CAR_X - C.CONTACT_HALF_WIDTH : C.CAR_X + C.CONTACT_HALF_WIDTH;
      const stopCenter = direction > 0 ? 134 : 286;
      let startX;
      if (behavior === 'left-yields') {
        startX = stopCenter - speed * C.PIXELS_PER_METER * (fastTime + 0.35);
      } else {
        startX = contactTarget - direction * speed * C.PIXELS_PER_METER * fastTime;
      }
      const nearBottom = position - (15 + random() * 2);
      const nearTop = position - 4.5;
      const occluder = direction > 0 ? {
        id: id + '-left-corner',
        type: random() < 0.45 ? 'hedge' : 'building',
        left: 20,
        right: 165,
        bottom: nearBottom,
        top: nearTop,
        color: ['#b98c62', '#82959a', '#b7a273'][Math.floor(paintRandom() * 3)]
      } : {
        id: id + '-right-corner',
        type: random() < 0.45 ? 'hedge' : 'building',
        left: 255,
        right: 350,
        bottom: nearBottom,
        top: nearTop,
        color: ['#b98c62', '#82959a', '#b7a273'][Math.floor(paintRandom() * 3)]
      };
      return Object.freeze({
        id: id,
        position: position,
        behavior: behavior,
        direction: direction,
        source: direction > 0 ? 'left' : 'right',
        startX: startX,
        speedKmh: speedKmh,
        initialSpeed: speed,
        rollingSpeed: (22 + random() * 4) / 3.6,
        crossingSpeed: (26 + random() * 4) / 3.6,
        stopCenter: stopCenter,
        cueX: 78 + random() * 8,
        brakingDeceleration: 2.2,
        color: colors[Math.floor(paintRandom() * colors.length)],
        occluders: Object.freeze([Object.freeze(occluder)])
      });
    });
    return Object.freeze({ events: Object.freeze(events), rulePack: CN_RULE_PACK.id });
  }

  function createActor(event) {
    return {
      active: false,
      state: 'waiting',
      x: event.startX,
      speed: event.initialSpeed,
      visible: false,
      occluderId: null,
      routeClear: false,
      cleared: false,
      stoppedTime: 0,
      brakeLights: false
    };
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
    event.recordedApproach = false;
    event.recordedSlow = false;
    event.speedAtApproach = null;
    event.speedAtSlow = null;
    event.maxSpeedAfterSlow = 0;
    event.earlyControlTime = 0;
    event.earlySlow = false;
    event.stoppedDwell = 0;
    event.stoppedScanTime = 0;
    event.stopScan = false;
    event.observedActorTime = 0;
    event.confirmedYieldTime = 0;
    event.waitedUntilClear = false;
    event.enteredBeforeClear = false;
    event.closePass = false;
    event.correctJudgment = false;
    event.firstVisibleDistance = null;
    event.actor = createActor(event);
  }

  function observationLine(event) {
    return event.position - C.OBSERVE_LINE_OFFSET_M;
  }

  function inObservationZone(simulation, event) {
    const front = simulation.distance + C.CAR_LENGTH_M / 2;
    const line = observationLine(event);
    return front <= line + 0.25 && front >= line - C.OBSERVE_ZONE_DEPTH_M;
  }

  function playerRearClear(simulation, event) {
    return simulation.distance - C.CAR_LENGTH_M / 2 > event.position + C.SIDE_ROAD_HALF_WIDTH_M + 0.8;
  }

  function actorRequired(event) {
    const actor = event.actor;
    return Boolean(actor && actor.active && !actor.cleared && !actor.routeClear);
  }

  function yieldConfirmed(event) {
    return event.behavior === 'left-yields' && event.actor.state === 'yield-stopped' &&
      event.confirmedYieldTime >= 0.25;
  }

  // 来车只由种子计划与自身状态机驱动；玩家踏板不会改变让行答案。
  function advanceActor(event, actor, dt, mayResume) {
    if (!actor.active || actor.cleared) return;
    if (actor.state === 'waiting') actor.state = 'approach';

    if (actor.state === 'yield-stopped') {
      actor.speed = 0;
      actor.brakeLights = true;
      actor.stoppedTime += dt;
      if (mayResume) actor.state = 'clearing';
      else return;
    }

    if (actor.state === 'approach') {
      actor.brakeLights = false;
      if (event.behavior === 'left-yields') {
        const remainingPx = Math.max(0, event.stopCenter - actor.x);
        const brakeDistance = actor.speed * actor.speed / (2 * event.brakingDeceleration) * C.PIXELS_PER_METER;
        if (remainingPx <= brakeDistance + 1) actor.state = 'slowing';
      } else if (event.behavior === 'left-late' && actor.x >= event.cueX) {
        actor.state = 'slowing';
      } else if (event.behavior === 'right-through' && actor.x <= event.stopCenter) {
        actor.state = 'crossing';
      }
    }

    if (actor.state === 'slowing') {
      actor.brakeLights = true;
      const target = event.behavior === 'left-yields' ? 0 : event.rollingSpeed;
      actor.speed = M.moveToward(actor.speed, target, event.brakingDeceleration * dt);
    } else if (actor.state === 'crossing' && event.behavior === 'left-late') {
      actor.brakeLights = false;
      actor.speed = M.moveToward(actor.speed, event.crossingSpeed, 0.8 * dt);
    } else if (actor.state === 'clearing') {
      actor.brakeLights = false;
      actor.speed = M.moveToward(actor.speed, event.initialSpeed, 1.4 * dt);
    }

    let nextX = actor.x + event.direction * actor.speed * C.PIXELS_PER_METER * dt;
    if (event.behavior === 'left-yields' && actor.state === 'slowing' &&
      (nextX >= event.stopCenter || actor.speed <= 0.01)) {
      nextX = Math.min(nextX, event.stopCenter);
      actor.speed = 0;
      actor.state = 'yield-stopped';
      actor.stoppedTime = 0;
    } else if (event.behavior === 'left-late' && actor.state === 'slowing' && nextX >= event.stopCenter) {
      actor.state = 'crossing';
    }
    actor.x = nextX;

    const clear = event.direction > 0 ? actor.x >= C.CROSS_CLEAR_RIGHT_X : actor.x <= C.CROSS_CLEAR_LEFT_X;
    if (clear && actor.state !== 'yield-stopped') {
      actor.routeClear = true;
      if (actor.state !== 'clearing') actor.state = 'clearing';
    }
    if (actor.routeClear && (actor.x < -75 || actor.x > 435)) {
      actor.cleared = true;
      actor.visible = false;
      actor.brakeLights = false;
    }
  }

  function rectanglesOverlap(distance, x, event, actor) {
    return Math.abs(actor.x - x) < C.CONTACT_HALF_WIDTH &&
      Math.abs(event.position - distance) < C.CAR_LENGTH_M / 2 + C.CROSS_CAR_HALF_LENGTH_M;
  }

  function estimateConflictTimes(simulation, event) {
    const actor = event.actor;
    const nearEdge = event.position - C.SIDE_ROAD_HALF_WIDTH_M;
    const playerDistance = Math.max(0, nearEdge - (simulation.distance + C.CAR_LENGTH_M / 2));
    const target = event.direction > 0 ? simulation.x - C.CONTACT_HALF_WIDTH : simulation.x + C.CONTACT_HALF_WIDTH;
    const actorDistance = Math.max(0, (target - actor.x) * event.direction);
    return {
      car: playerDistance / Math.max(0.1, simulation.speed / 3.6),
      cross: actor.state === 'yield-stopped' ? Infinity : actorDistance / Math.max(0.1, actor.speed * C.PIXELS_PER_METER)
    };
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    let target = 47;
    if (event) {
      const remaining = event.position - simulation.distance;
      if (remaining <= C.APPROACH_START && remaining > 50) target = 30;
      if (remaining <= 50) target = 22;
      if (remaining <= 16) {
        const mustWait = !event.stopScan || (actorRequired(event) && !yieldConfirmed(event));
        target = mustWait ? 0 : 47;
      }
    }
    return {
      throttle: simulation.speed < target - 0.35,
      brake: simulation.speed > target + 0.35,
      left: false,
      right: false
    };
  }

  class Simulation {
    constructor(seed, options) {
      this.seed = seed;
      this.rulePack = options && options.rulePack ? options.rulePack : CN_RULE_PACK;
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
      this.scoring.sharpSteers = 0;
      this.scoring.steeringReversals = 0;
      this.scoring.steeringCooldown = 0;
      this.lastSteering = 0;
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.necessaryBraking = false;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoMode = 'driver';
      this.replayReturnStatus = null;
      this.retryCount = 0;
    }

    start() {
      this.status = 'driving';
    }

    get currentEvent() {
      return this.events.find(function (event) { return !event.resolved; }) || null;
    }

    get finishDistance() {
      return this.events[this.events.length - 1].position + C.FINISH_BUFFER;
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

      const event = this.currentEvent;
      const frontRemaining = event ? observationLine(event) - (this.distance + C.CAR_LENGTH_M / 2) : Infinity;
      const emergencyBrake = event && actorRequired(event) && event.actor.state !== 'yield-stopped' &&
        this.speed > C.HARD_BRAKE_MIN_SPEED && frontRemaining < 16 && frontRemaining > -4;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = -(emergencyBrake ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);
      this.acceleration = acceleration;

      // 在推进本帧前做输入感知外推，避免画面先重叠再判罚。
      if (event && actorRequired(event) && this.predictConflict(event, input)) {
        this.freeze(event);
        return;
      }

      const oldSpeedMps = this.speed / 3.6;
      let nextSpeedMps = M.clamp(oldSpeedMps + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      if (!input.throttle && !input.brake && this.speed < 1) nextSpeedMps = 0;
      this.speed = nextSpeedMps * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeedMps - nextSpeedMps) / dt);
      this.distance += (oldSpeedMps + nextSpeedMps) * 0.5 * dt;
      this.elapsed += dt;

      const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      if (this.speed > 0.5) {
        this.x = M.clamp(this.x + steering * C.STEER_SPEED * dt, C.CAR_MIN_X, C.CAR_MAX_X);
      }

      this.necessaryBraking = Boolean(event && input.brake && event.earlySlow && this.previousSpeed <= 26 &&
        actorRequired(event) && frontRemaining < C.YIELD_ZONE_FAR);
      if (event) {
        this.updateEvent(event, dt, input);
        Scoring.recordStep(this.scoring, this, dt);
        if (!event.resolved && actorRequired(event) && rectanglesOverlap(this.distance, this.x, event, event.actor)) {
          this.freeze(event);
          return;
        }
        if (!event.resolved && playerRearClear(this, event)) this.resolveEvent(event);
      } else {
        this.necessaryBraking = false;
        this.advanceActors(dt);
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

    advanceActors(dt) {
      for (let index = 0; index < this.events.length; index += 1) {
        const event = this.events[index];
        if (event.actor.active && !event.actor.cleared) {
          advanceActor(event, event.actor, dt, playerRearClear(this, event));
        }
      }
    }

    updateEvent(event, dt, input) {
      const remaining = event.position - this.distance;
      if (!event.actor.active && !event.actor.cleared && remaining <= C.EVENT_ACTIVATE) {
        event.actor.active = true;
        event.actor.state = 'approach';
      }
      if (remaining <= 85 && remaining >= 35 && !input.throttle) event.earlyControlTime += dt;
      if (!event.recordedApproach && remaining <= C.RECOGNITION_CHECK) {
        event.recordedApproach = true;
        event.speedAtApproach = this.speed;
      }
      if (!event.recordedSlow && remaining <= C.SLOW_CHECK) {
        event.recordedSlow = true;
        event.speedAtSlow = this.speed;
      }
      if (event.recordedSlow && remaining > 0) {
        event.maxSpeedAfterSlow = Math.max(event.maxSpeedAfterSlow, this.speed);
      }
      event.earlySlow = event.speedAtSlow != null && event.speedAtSlow <= 28 &&
        event.earlyControlTime >= 0.25 && event.maxSpeedAfterSlow <= 32;

      this.advanceActors(dt);
      const visibility = visibilityFor(this, event);
      const actor = event.actor;
      actor.visible = visibility.visible;
      actor.occluderId = visibility.occluderId;
      if (actor.visible) {
        event.observedActorTime += dt;
        if (event.firstVisibleDistance == null) {
          event.firstVisibleDistance = Math.max(0, observationLine(event) - (this.distance + C.CAR_LENGTH_M / 2));
        }
        if (actor.state === 'yield-stopped') event.confirmedYieldTime += dt;
      }

      const stopped = this.speed < C.STOP_SPEED && inObservationZone(this, event);
      if (stopped) {
        event.stoppedDwell += dt;
        if (scanSightlinesClear(this, event)) event.stoppedScanTime += dt;
        else event.stoppedScanTime = 0;
      } else {
        event.stoppedDwell = 0;
        event.stoppedScanTime = 0;
      }
      if (event.stoppedDwell >= C.STOP_DWELL && event.stoppedScanTime >= C.SCAN_DWELL) event.stopScan = true;
      if (event.stopScan && actor.routeClear && this.speed < C.STOP_SPEED) event.waitedUntilClear = true;

      const front = this.distance + C.CAR_LENGTH_M / 2;
      if (!playerRearClear(this, event) && front > event.position - C.SIDE_ROAD_HALF_WIDTH_M &&
        actorRequired(event) && event.actor.state !== 'yield-stopped') {
        event.enteredBeforeClear = true;
      }
      this.measureSpace(event);
    }

    measureSpace(event) {
      const actor = event.actor;
      if (!actor.active || actor.cleared || actor.state === 'yield-stopped') return;
      const horizontal = Math.abs(actor.x - this.x) - C.CONTACT_HALF_WIDTH;
      const vertical = Math.abs(event.position - this.distance) -
        (C.CAR_LENGTH_M / 2 + C.CROSS_CAR_HALF_LENGTH_M);
      if (horizontal >= 0 && vertical >= 0 && horizontal < C.CLOSE_PASS_MARGIN_PX &&
        vertical < C.CLOSE_PASS_MARGIN_PX) {
        event.closePass = true;
      }
    }

    predictConflict(event, input) {
      const actor = event.actor;
      if (!actorRequired(event) || actor.state === 'yield-stopped') return false;
      const speedMps = this.speed / 3.6;
      const currentlyOverlappingVertically = Math.abs(event.position - this.distance) <
        C.CAR_LENGTH_M / 2 + C.CROSS_CAR_HALF_LENGTH_M + 0.5;
      if (speedMps < 0.15 && !currentlyOverlappingVertically) return false;
      const horizon = Math.max(0.8, Math.min(2.4, speedMps * 0.16));
      const substep = 0.025;
      const predictedActor = Object.assign({}, actor);
      let distance = this.distance;
      let velocity = speedMps;
      let x = this.x;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = this.acceleration;
      const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);

      for (let time = 0; time < horizon - 0.000001; time += substep) {
        const slice = Math.min(substep, horizon - time);
        const nextVelocity = M.clamp(velocity + acceleration * slice, 0, C.MAX_SPEED / 3.6);
        const nextDistance = distance + (velocity + nextVelocity) * 0.5 * slice;
        const nextX = M.clamp(x + steering * C.STEER_SPEED * slice, C.CAR_MIN_X, C.CAR_MAX_X);
        advanceActor(event, predictedActor, slice, false);
        if (!predictedActor.routeClear && !predictedActor.cleared &&
          rectanglesOverlap(nextDistance, nextX, event, predictedActor)) return true;
        distance = nextDistance;
        velocity = nextVelocity;
        x = nextX;
        if (velocity <= 0 && !currentlyOverlappingVertically) break;
      }
      return false;
    }

    freeze(event) {
      event.failed = true;
      event.attempts += 1;
      this.retryCount += 1;
      this.status = 'frozen';
      const times = estimateConflictTimes(this, event);
      this.freezeInfo = {
        eventId: event.id,
        behavior: event.behavior,
        source: event.source,
        speed: this.speed,
        remaining: Math.max(0, observationLine(event) - (this.distance + C.CAR_LENGTH_M / 2)),
        stoppingDistance: M.stoppingDistance(this.speed),
        firstVisibleDistance: event.firstVisibleDistance,
        visible: event.actor.visible,
        carTime: times.car,
        crossTime: times.cross,
        rulePack: this.rulePack.id
      };
    }

    resolveEvent(event) {
      event.resolved = true;
      if (event.stopScan && event.actor.routeClear) event.waitedUntilClear = true;
      if (event.behavior === 'left-yields') {
        event.correctJudgment = event.stopScan && event.confirmedYieldTime >= 0.25 &&
          !event.enteredBeforeClear && !event.closePass;
      } else {
        event.correctJudgment = event.stopScan && event.waitedUntilClear &&
          !event.enteredBeforeClear && !event.closePass;
      }
      this.justResolved = event;
    }

    retryEvent() {
      const event = this.events[this.freezeInfo ? this.freezeInfo.eventId : (this.demoEventId || 0)];
      if (!event) return;
      this.distance = Math.max(0, event.position - C.APPROACH_START);
      this.speed = 35;
      this.previousSpeed = 35;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.x = C.CAR_X;
      this.lastSteering = 0;
      this.necessaryBraking = false;
      resetEventRuntime(event);
      this.freezeInfo = null;
      this.demo = null;
      this.demoEventId = null;
      this.demoTime = 0;
      this.demoMode = 'driver';
      this.replayReturnStatus = null;
      this.justResolved = null;
      this.status = 'driving';
    }

    makeDemo(eventId) {
      const demo = new Simulation(this.seed, { rulePack: this.rulePack });
      for (let index = 0; index < eventId; index += 1) {
        demo.events[index].resolved = true;
        demo.events[index].earlySlow = true;
        demo.events[index].stopScan = true;
        demo.events[index].correctJudgment = true;
      }
      demo.distance = Math.max(0, demo.events[eventId].position - C.APPROACH_START);
      demo.speed = 45;
      demo.previousSpeed = 45;
      demo.status = 'driving';
      return demo;
    }

    startDemo() {
      if (!this.freezeInfo) return;
      this.demoEventId = this.freezeInfo.eventId;
      this.demo = this.makeDemo(this.demoEventId);
      this.demoTime = 0;
      this.demoMode = 'driver';
      this.status = 'demonstrating';
    }

    startPedestrianReplay() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.currentEvent ? this.currentEvent.id : this.events.length - 1);
      this.replayReturnStatus = this.status === 'complete' || this.status === 'timeout' ? this.status : 'frozen';
      this.demoEventId = eventId;
      this.demo = this.makeDemo(eventId);
      this.demoTime = 0;
      this.demoMode = 'cross';
      this.justResolved = null;
      this.status = 'demonstrating';
    }

    finishReplay() {
      if (this.demoMode !== 'cross') return;
      this.demo = null;
      this.demoTime = 0;
      this.demoMode = 'driver';
      this.status = this.replayReturnStatus || (this.freezeInfo ? 'frozen' : 'complete');
      this.replayReturnStatus = null;
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      const demo = this.demo;
      const event = demo.events[this.demoEventId];
      demo.step(defensiveInput(demo), dt);
      const replayDone = this.demoMode === 'cross' && event.resolved && this.demoTime > 3;
      if (demo.status === 'frozen' || demo.status === 'timeout' ||
        (this.demoMode === 'driver' && event.resolved && demo.distance > event.position + 12) ||
        this.demoTime >= 38 || replayDone) {
        if (this.demoMode === 'cross') this.finishReplay();
        else this.retryEvent();
      }
    }
  }

  const Scoring = {
    getRiskEvent: function (simulation) {
      return simulation.events.find(function (event) {
        return !event.resolved && simulation.distance >= event.position - C.RISK_START &&
          simulation.distance <= event.position + C.RISK_END;
      }) || null;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || simulation.speed >= 1.2 || !inObservationZone(simulation, event)) return false;
      if (!event.stopScan) return true;
      if (!actorRequired(event)) return false;
      if (event.actor.state === 'yield-stopped') return event.confirmedYieldTime < 0.25;
      return true;
    },

    recordStep: function (state, simulation, dt) {
      const event = Scoring.getRiskEvent(simulation);
      if (!Scoring.isYieldExempt(simulation)) {
        const quality = Game.Scoring.speedQuality(simulation.speed, Boolean(event));
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      state.steeringCooldown = Math.max(0, state.steeringCooldown - dt);
      state.reversalWindow = Math.max(0, (state.reversalWindow || 0) - dt);
      if (state.reversalWindow <= 0) state.steeringReversals = 0;
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

      const steering = simulation.x - (state.lastSteeringX == null ? simulation.x : state.lastSteeringX);
      state.lastSteeringX = simulation.x;
      const direction = Math.abs(steering) < 0.001 ? 0 : Math.sign(steering);
      if (direction && simulation.lastSteering && direction !== simulation.lastSteering &&
        simulation.speed > 20 && state.steeringCooldown <= 0) {
        state.steeringReversals += 1;
        state.reversalWindow = 1.2;
        if (state.steeringReversals >= 2) {
          state.sharpSteers += 1;
          state.steeringReversals = 0;
          state.steeringCooldown = 1.4;
        }
      }
      if (direction) simulation.lastSteering = direction;
    },

    eventObservation: function (event) {
      return (event.earlySlow ? 3 : 0) + (event.stopScan ? 3 : 0) + (event.correctJudgment ? 4 : 0);
    },

    eventSafe: function (event) {
      return !event.failed && !event.closePass;
    },

    smoothScore: function (state) {
      return Math.max(0, 10 - state.hardBrakes * 2 - state.sharpSteers * 2);
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
      const smooth = Scoring.smoothScore(state);
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
        summaryKey = 'scene.crossTraffic.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }

      let adviceKey = 'scene.crossTraffic.result.advice.default';
      if (failed) adviceKey = 'scene.crossTraffic.result.advice.failed';
      else if (simulation.events.some(function (event) { return event.closePass; })) adviceKey = 'scene.crossTraffic.result.advice.close';
      else if (simulation.events.some(function (event) { return !event.stopScan; })) adviceKey = 'scene.crossTraffic.result.advice.stop';
      else if (simulation.events.some(function (event) { return !event.correctJudgment; })) adviceKey = 'scene.crossTraffic.result.advice.judgment';
      else if (simulation.events.some(function (event) { return !event.earlySlow; })) adviceKey = 'scene.crossTraffic.result.advice.early';
      else if (state.hardBrakes > 0 || state.sharpSteers > 0) adviceKey = 'result.advice.braking';
      else if (timedOut || efficiency < 12) adviceKey = 'result.advice.efficiency';

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
        sharpSteers: state.sharpSteers,
        earlySlowCount: simulation.events.filter(function (event) { return event.earlySlow; }).length,
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

  function drawJunction(ctx, simulation, event, current) {
    const y = worldY(simulation, event.position);
    const half = C.SIDE_ROAD_HALF_WIDTH_M * C.PIXELS_PER_METER;
    if (y + half < -30 || y - half > C.HEIGHT + 30) return;
    Draw.rect(ctx, '#a6a895', 0, y - half - 6, C.WIDTH, 6);
    Draw.rect(ctx, '#a6a895', 0, y + half, C.WIDTH, 6);
    Draw.rect(ctx, '#3b484b', 0, y - half, C.WIDTH, half * 2);
    Draw.rect(ctx, '#334145', 0, y - half, C.WIDTH, 2);
    Draw.rect(ctx, '#334145', 0, y + half - 2, C.WIDTH, 2);
    for (let x = 8; x < C.WIDTH; x += 30) {
      if (x > 158 && x < 238) continue;
      Draw.rect(ctx, '#526064', x, y - 1, 15, 2);
    }

    ctx.save();
    ctx.globalAlpha = current ? 0.2 : 0.1;
    ctx.strokeStyle = '#ffd778';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(C.CAR_MIN_X - 14, y - half, C.CAR_MAX_X - C.CAR_MIN_X + 28, half * 2);
    ctx.restore();

    const lineY = worldY(simulation, observationLine(event));
    if (lineY > 90 && lineY < C.HEIGHT + 20) {
      ctx.save();
      ctx.strokeStyle = current ? '#ffe292' : '#a8a78666';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(C.CAR_MIN_X - 14, lineY);
      ctx.lineTo(C.CAR_MAX_X + 14, lineY);
      ctx.stroke();
      ctx.restore();
      if (current) {
        Draw.rect(ctx, '#142630dd', 178, lineY + 5, 66, 13);
        ctx.fillStyle = '#ffe6a4';
        Draw.fillFittedText(ctx, t('scene.crossTraffic.canvas.observe'), 182, lineY + 15, 58, 8, 'sans-serif');
      }
    }
  }

  function drawOccluder(ctx, simulation, rect) {
    const top = worldY(simulation, rect.top);
    const bottom = worldY(simulation, rect.bottom);
    const height = bottom - top;
    if (bottom < -25 || top > C.HEIGHT + 25) return;
    if (rect.type === 'hedge') {
      Draw.rect(ctx, '#183b32', rect.left - 2, top + 4, rect.right - rect.left + 4, height);
      Draw.rect(ctx, '#39704a', rect.left, top, rect.right - rect.left, height - 3);
      for (let y = top + 5; y < bottom - 5; y += 12) {
        for (let x = rect.left + 5; x < rect.right - 4; x += 14) {
          Draw.rect(ctx, ((x + y) % 3) ? '#4d8756' : '#65955f', x, y, 6, 5);
        }
      }
      return;
    }
    Draw.rect(ctx, '#172a3355', rect.left + 5, top + 5, rect.right - rect.left, height);
    Draw.rect(ctx, rect.color, rect.left, top, rect.right - rect.left, height);
    Draw.rect(ctx, '#d4c7a5', rect.left, top, rect.right - rect.left, 5);
    Draw.rect(ctx, '#665e54', rect.left, bottom - 5, rect.right - rect.left, 5);
    for (let y = top + 12; y < bottom - 9; y += 17) {
      for (let x = rect.left + 9; x < rect.right - 8; x += 22) {
        Draw.rect(ctx, '#294651', x, y, 10, 8);
        Draw.rect(ctx, '#80b9c1', x + 2, y + 1, 6, 2);
      }
    }
  }

  function drawCrossCar(ctx, simulation, event, actor, options) {
    if (!actor.active || actor.cleared) return;
    const y = worldY(simulation, event.position);
    if (y < -30 || y > C.HEIGHT + 30 || actor.x < -45 || actor.x > C.WIDTH + 45) return;
    const x = actor.x;
    const color = options.demo ? '#65d6a1' : event.color;
    ctx.save();
    if (options.hidden) ctx.globalAlpha = 0.38;
    Draw.rect(ctx, '#10232b55', x - 20, y - 12, 44, 28);
    Draw.rect(ctx, '#14232b', x - 15, y - 17, 10, 3);
    Draw.rect(ctx, '#14232b', x + 7, y - 17, 10, 3);
    Draw.rect(ctx, '#14232b', x - 15, y + 14, 10, 3);
    Draw.rect(ctx, '#14232b', x + 7, y + 14, 10, 3);
    Draw.rect(ctx, color, x - 22, y - 14, 44, 28);
    Draw.rect(ctx, '#294651', x - 10, y - 10, 20, 20);
    Draw.rect(ctx, '#80b9c1', x + event.direction * 5 - 4, y - 8, 8, 16);
    Draw.rect(ctx, '#1c343e', x - event.direction * 11 - 2, y - 9, 4, 18);
    const frontX = event.direction > 0 ? x + 20 : x - 23;
    const rearX = event.direction > 0 ? x - 23 : x + 20;
    Draw.rect(ctx, '#fff2bd', frontX, y - 10, 3, 6);
    Draw.rect(ctx, '#fff2bd', frontX, y + 4, 3, 6);
    Draw.rect(ctx, actor.brakeLights ? '#ff4d42' : '#a94442', rearX, y - 10, 3, 6);
    Draw.rect(ctx, actor.brakeLights ? '#ff4d42' : '#a94442', rearX, y + 4, 3, 6);
    if (actor.brakeLights) {
      ctx.globalAlpha = options.hidden ? 0.15 : 0.25;
      Draw.rect(ctx, '#ff6b59', rearX - 2, y - 13, 7, 26);
    }
    ctx.restore();
  }

  function drawActors(ctx, simulation, demo, xray) {
    simulation.events.forEach(function (event) {
      const actor = event.actor;
      if (!actor.active || actor.cleared) return;
      const visibility = visibilityFor(simulation, event);
      if (!visibility.visible && !xray) return;
      drawCrossCar(ctx, simulation, event, actor, { demo: demo, hidden: xray && !visibility.visible });
    });
  }

  function drawSightLine(ctx, x1, y1, x2, y2, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  function drawDemoGuide(ctx, simulation, replay) {
    const event = simulation.currentEvent;
    if (!event) return;
    const actor = event.actor;
    if (actor.active && !actor.cleared) {
      const actorY = worldY(simulation, event.position);
      const visible = visibilityFor(simulation, event).visible;
      drawSightLine(ctx, simulation.x, C.CAR_Y - 12, actor.x, actorY,
        visible ? '#a6f0c899' : '#ffd16699');
      if (replay) {
        const frontX = actor.x + event.direction * 18;
        drawSightLine(ctx, frontX, actorY + 12, simulation.x, C.CAR_Y + 8, '#7fd1ed99');
      }
    }
    Draw.rect(ctx, '#0e202ddd', 194, 548, 150, 51);
    ctx.fillStyle = '#a6f0c8';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(Math.round(simulation.speed) + ' km/h', 202, 571);
    ctx.fillStyle = '#d4e3db';
    Draw.fillFittedText(ctx, t(replay ? 'scene.crossTraffic.canvas.replay' : 'scene.crossTraffic.canvas.principles'),
      202, 589, 134, 9, 'sans-serif');
  }

  function drawWorld(ctx, simulation, demo, replay) {
    Draw.drawEnvironment(ctx, simulation, C, 172);
    const current = simulation.currentEvent;
    simulation.events.forEach(function (event) { drawJunction(ctx, simulation, event, event === current); });
    drawActors(ctx, simulation, demo, replay);
    simulation.events.forEach(function (event) {
      event.occluders.forEach(function (rect) { drawOccluder(ctx, simulation, rect); });
    });
    if (replay) drawActors(ctx, simulation, demo, true);
    Draw.drawCar(ctx, simulation.x, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    if (demo) drawDemoGuide(ctx, simulation, replay);
  }

  function drawFreeze(ctx, simulation) {
    const event = simulation.events[simulation.freezeInfo.eventId];
    drawCrossCar(ctx, simulation, event, event.actor, { demo: false, hidden: !event.actor.visible });
    if (event.actor.active && !event.actor.cleared) {
      drawSightLine(ctx, simulation.x, C.CAR_Y - 8, event.actor.x,
        worldY(simulation, event.position), '#fff0a8');
    }
    Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
    Draw.rect(ctx, '#fff0b0', simulation.x + 20, C.CAR_Y - 32, 22, 24);
    Draw.rect(ctx, '#3b2a0e', simulation.x + 29, C.CAR_Y - 28, 4, 10);
    Draw.rect(ctx, '#3b2a0e', simulation.x + 29, C.CAR_Y - 15, 4, 4);
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        drawWorld(ctx, simulation.demo, true, simulation.demoMode === 'cross');
        return;
      }
      drawWorld(ctx, simulation, false, false);
      if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
    }
  };

  Scenes['unsignalized-cross-traffic'] = {
    id: 'unsignalized-cross-traffic',
    Constants: C,
    RulePacks: { CN: CN_RULE_PACK },
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    Geometry: {
      segmentIntersectsAABB: segmentIntersectsAABB,
      pointVisible: pointVisible,
      visibilityFor: visibilityFor,
      scanSightlinesClear: scanSightlinesClear,
      rectanglesOverlap: rectanglesOverlap,
      inObservationZone: inObservationZone,
      observationLine: observationLine
    },
    createPlan: createPlan,
    defensiveInput: defensiveInput,
    advanceActor: advanceActor,
    actorRequired: actorRequired,
    yieldConfirmed: yieldConfirmed,
    estimateConflictTimes: estimateConflictTimes,
    ui: {
      progress: function (simulation) {
        if (simulation.status === 'demonstrating' && simulation.demoMode === 'cross') {
          return t('scene.crossTraffic.hud.replay', { number: simulation.demoEventId + 1 });
        }
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.crossTraffic.hud.progress', { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.stopScan; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && Scoring.eventSafe(event); }).length
        ];
      },
      smoothScore: function (simulation) {
        return Scoring.smoothScore(simulation.scoring);
      },
      updateControls: function (doc, simulation) {
        const replay = simulation.status === 'demonstrating' && simulation.demoMode === 'cross';
        const badge = doc.querySelector('#demo-screen .demo-badge');
        const skip = doc.getElementById('skip-demo-button');
        if (badge) badge.textContent = t(replay ? 'scene.crossTraffic.replay.badge' : 'game.demoBadge');
        if (skip) skip.textContent = t(replay ? 'scene.crossTraffic.replay.skip' : 'game.skipDemo');
      },
      coach: function (simulation, displaySpeed) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        const remaining = event ? event.position - current.distance : Infinity;
        let coach = 'scene.crossTraffic.hud.cruise';
        let status = displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : 'hud.speedUp';
        let tone = '';
        let coachTone = '';

        if (simulation.demoMode === 'cross' && simulation.status === 'demonstrating') {
          return {
            text: t('scene.crossTraffic.hud.replayCoach'),
            status: t('scene.crossTraffic.hud.replayStatus'),
            tone: '',
            coachTone: 'good'
          };
        }
        if (displaySpeed < 25 && (!event || remaining > C.RISK_START)) {
          status = 'hud.tooSlow';
          tone = 'warn';
        } else if (displaySpeed > 55 && (!event || remaining > C.RISK_START)) {
          status = 'hud.nearLimit';
          tone = 'danger';
        }

        if (event && remaining <= C.APPROACH_START && remaining > -C.RISK_END) {
          const actor = event.actor;
          const stopped = current.speed < C.STOP_SPEED && inObservationZone(current, event);
          coachTone = 'risk';
          if (actor.routeClear || (actor.cleared && !actorRequired(event))) {
            coach = 'scene.crossTraffic.hud.resume';
            coachTone = 'good';
            status = stopped ? 'hud.speedUp' : 'hud.cruiseGood';
            tone = stopped ? 'warn' : '';
          } else if (stopped) {
            status = 'hud.yielding';
            tone = '';
            if (!event.stopScan) coach = 'scene.crossTraffic.hud.scanning';
            else if (yieldConfirmed(event)) {
              coach = 'scene.crossTraffic.hud.yieldStopped';
              coachTone = 'good';
            } else if (actor.visible) coach = 'scene.crossTraffic.hud.waitVisible';
            else coach = 'scene.crossTraffic.hud.waitHidden';
          } else if (remaining <= 24) {
            coach = 'scene.crossTraffic.hud.fullStop';
            status = 'hud.prepareStop';
            tone = 'warn';
          } else {
            coach = 'scene.crossTraffic.hud.approach';
            status = 'hud.prepareSlow';
          }
        } else if (event && remaining <= C.RISK_START && remaining > -C.RISK_END) {
          coach = 'scene.crossTraffic.hud.resume';
          coachTone = 'good';
        }
        return {
          text: t(coach),
          coachTone: coachTone,
          status: t(simulation.status === 'ready' ? 'hud.ready' : status),
          tone: tone
        };
      },
      retryToast: function () {
        return { key: 'scene.crossTraffic.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        if (event.closePass) return { key: 'scene.crossTraffic.toast.close', params: { score: score }, neutral: true };
        if (score === 10) return { key: 'scene.crossTraffic.toast.safe', params: { score: score }, neutral: false };
        if (!event.stopScan) return { key: 'scene.crossTraffic.toast.noStop', params: { score: score }, neutral: true };
        return { key: 'scene.crossTraffic.toast.improve', params: { score: score }, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        const key = info.behavior === 'right-through' ? 'scene.crossTraffic.failure.right' :
          (info.behavior === 'left-late' ? 'scene.crossTraffic.failure.late' : 'scene.crossTraffic.failure.generic');
        return t(key, {
          speed: Math.round(info.speed),
          remaining: Math.max(0, info.remaining).toFixed(1),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo.events[simulation.demoEventId];
        if (simulation.demoMode === 'cross') {
          const phase = Math.floor(simulation.demoTime / 3) % 2;
          const suffix = phase ? 'Cross' : 'Driver';
          return {
            step: t('scene.crossTraffic.replay.' + event.behavior + suffix),
            substep: t('scene.crossTraffic.replay.neutral')
          };
        }
        let key = 'scene.crossTraffic.demo.slow';
        if (event.resolved || (event.actor.routeClear && event.stopScan)) key = 'scene.crossTraffic.demo.pass';
        else if (Scoring.isYieldExempt(demo) || (demo.speed < C.STOP_SPEED && inObservationZone(demo, event))) {
          if (!event.stopScan) key = 'scene.crossTraffic.demo.scan';
          else if (yieldConfirmed(event)) key = 'scene.crossTraffic.demo.yieldStopped';
          else key = 'scene.crossTraffic.demo.wait';
        } else if (event.behavior === 'left-yields' && event.actor.state === 'yield-stopped') {
          key = 'scene.crossTraffic.demo.yieldStopped';
        } else if (event.behavior === 'left-late' && event.actor.visible) {
          key = 'scene.crossTraffic.demo.late';
        }
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
