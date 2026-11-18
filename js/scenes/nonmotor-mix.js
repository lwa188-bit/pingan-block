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
    EVENT_POSITIONS: [125, 320, 515],
    EVENT_ACTIVATE: 65,
    APPROACH_START: 55,
    RECOGNITION_CHECK: 45,
    SLOW_CHECK: 25,
    LATE_CHECK: 12,
    RISK_START: 35,
    RISK_END: 5,
    FINISH_BUFFER: 60,
    MAX_TIME: 110,
    CAR_X: 210,
    CAR_MIN_X: 190,
    CAR_MAX_X: 230,
    BIKE_HALF_WIDTH: 5,
    BIKE_HALF_LENGTH: 0.85,
    CONTACT_HALF_WIDTH: 18,
    CLOSE_PASS_WIDTH: 22,
    YIELD_ZONE_FAR: 22,
    STEER_SPEED: 20
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
    const random = M.mulberry32(M.hashSeed('nonmotor-mix:' + seed));
    const behaviors = shuffle(['wrong-way', 'swerve', 'diagonal'], random);
    const coats = ['#f4d35e', '#ee8a72', '#7fd1ed'];
    const events = C.EVENT_POSITIONS.map(function (position, id) {
      const behavior = behaviors[id];
      const wrongWayOnRight = random() < 0.5;
      const diagonalDirection = random() < 0.5 ? 1 : -1;
      return Object.freeze({
        id: id,
        position: position,
        behavior: behavior,
        riderSpeedKmh: behavior === 'wrong-way' ? 18 + random() * 8 :
          (behavior === 'swerve' ? 16 + random() * 4 : 20 + random() * 5),
        riderX: wrongWayOnRight ? 216 + random() * 5 : 194 + random() * 5,
        diagonalDirection: diagonalDirection,
        diagonalSpeed: 27 + random() * 7,
        diagonalWorldSpeed: 0.9 + random() * 1.1,
        diagonalOffset: 8 + random() * 4,
        obstaclePosition: position + 28,
        coatColor: coats[Math.floor(random() * coats.length)],
        skinColor: random() > 0.5 ? '#efb489' : '#c88760'
      });
    });
    return Object.freeze({ events: Object.freeze(events) });
  }

  function createRider(event) {
    if (event.behavior === 'wrong-way') {
      return {
        active: false,
        state: 'wrong-way',
        x: event.riderX,
        position: event.position + 35,
        speed: event.riderSpeedKmh / 3.6,
        direction: -1,
        routeClear: false,
        cleared: false
      };
    }
    if (event.behavior === 'swerve') {
      return {
        active: false,
        state: 'approach',
        x: 232,
        position: event.position + 5,
        speed: event.riderSpeedKmh / 3.6,
        direction: 1,
        routeClear: false,
        cleared: false
      };
    }
    return {
      active: false,
      state: 'waiting',
      x: event.diagonalDirection > 0 ? 64 : 314,
      position: event.position + event.diagonalOffset,
      speed: event.diagonalSpeed,
      direction: event.diagonalDirection,
      routeClear: false,
      cleared: false
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
    event.recordedLate = false;
    event.speedAtApproach = null;
    event.speedAtSlow = null;
    event.speedAtLate = null;
    event.maxSpeedAfterSlow = 0;
    event.earlyControlTime = 0;
    event.correctSpaceTime = 0;
    event.minFollowingGap = Infinity;
    event.maxHorizontalSeparation = 0;
    event.closePass = false;
    event.waitedUntilClear = false;
    event.wasWaiting = false;
    event.earlySlow = false;
    event.recognized = false;
    event.spaceScore = false;
    event.rider = createRider(event);
  }

  // 只由种子计划和骑行者自身进度驱动。activation 之后不读取玩家踏板。
  function advanceRider(event, rider, dt, playerDistance) {
    if (!rider.active || rider.cleared) return;

    if (event.behavior === 'wrong-way') {
      rider.position -= rider.speed * dt;
      if (rider.position < playerDistance - C.CAR_LENGTH_M / 2 - 2) {
        rider.routeClear = true;
        rider.cleared = true;
      }
      return;
    }

    if (event.behavior === 'swerve') {
      const obstacleGap = event.obstaclePosition - rider.position;
      if (rider.state === 'approach' && obstacleGap <= 16) {
        rider.state = 'slowing';
      } else if (rider.state === 'slowing') {
        rider.speed = M.moveToward(rider.speed, 8 / 3.6, 1.6 * dt);
        if (obstacleGap <= 10) rider.state = 'swerving';
      } else if (rider.state === 'swerving') {
        rider.speed = M.moveToward(rider.speed, 11 / 3.6, 1.2 * dt);
        rider.x = M.moveToward(rider.x, 198, 19 * dt);
        if (rider.position >= event.obstaclePosition + 5) rider.state = 'returning';
      } else if (rider.state === 'returning') {
        rider.speed = M.moveToward(rider.speed, 15 / 3.6, 1.1 * dt);
        rider.x = M.moveToward(rider.x, 234, 20 * dt);
        if (rider.x >= 233.9 && rider.position >= event.obstaclePosition + 11) rider.state = 'clearing';
      } else if (rider.state === 'clearing') {
        rider.speed = M.moveToward(rider.speed, 12 / 3.6, 1.2 * dt);
        rider.x = M.moveToward(rider.x, 258, 22 * dt);
        if (rider.x >= 252) {
          rider.routeClear = true;
          rider.cleared = true;
          rider.state = 'cleared';
        }
      }
      rider.position += rider.speed * dt;
      return;
    }

    rider.state = 'crossing';
    rider.x += rider.direction * rider.speed * dt;
    rider.position -= event.diagonalWorldSpeed * dt;
    const clearOfPlayerLane = rider.direction > 0 ? rider.x >= 251 : rider.x <= 169;
    if (clearOfPlayerLane) rider.routeClear = true;
    const beyondFarCurb = rider.direction > 0 ? rider.x >= 316 : rider.x <= 62;
    if (beyondFarCurb) {
      rider.cleared = true;
      rider.state = 'cleared';
    }
  }

  function riderRequired(event) {
    return event.rider.active && !event.rider.routeClear && !event.rider.cleared;
  }

  function horizontalGap(simulation, rider, x) {
    return Math.abs(rider.x - (x == null ? simulation.x : x));
  }

  function verticalGap(simulation, rider, distance) {
    return Math.abs(rider.position - (distance == null ? simulation.distance : distance));
  }

  function estimateConflictTimes(simulation, event) {
    const rider = event.rider;
    const carSpeed = Math.max(0.1, simulation.speed / 3.6);
    const carDistance = Math.max(0, event.position - (simulation.distance + C.CAR_LENGTH_M / 2));
    const result = {
      car: carDistance / carSpeed,
      rider: Infinity,
      clear: Infinity
    };
    if (event.behavior === 'diagonal' && rider.active && !rider.routeClear) {
      const nearX = rider.direction > 0 ? C.CAR_X - 20 : C.CAR_X + 20;
      const farX = rider.direction > 0 ? 251 : 169;
      result.rider = Math.max(0, (nearX - rider.x) * rider.direction / rider.speed);
      result.clear = Math.max(0, (farX - rider.x) * rider.direction / rider.speed);
    } else if (rider.active && !rider.routeClear) {
      const relative = event.behavior === 'wrong-way' ? carSpeed + rider.speed : carSpeed - rider.speed;
      result.rider = Math.max(0, rider.position - simulation.distance) / Math.max(0.1, relative);
      result.clear = result.rider;
    }
    return result;
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    let target = 47;
    let targetX = C.CAR_X;
    if (event) {
      const remaining = event.position - simulation.distance;
      const rider = event.rider;
      if (remaining <= C.APPROACH_START && remaining > -C.RISK_END) {
        target = 20;
      }
      if (event.behavior === 'wrong-way' && rider.active && !rider.cleared) {
        targetX = rider.x >= C.CAR_X ? C.CAR_MIN_X : C.CAR_MAX_X;
        if (rider.position - simulation.distance < 11 && horizontalGap(simulation, rider) < 24) target = 0;
      } else if (event.behavior === 'swerve' && rider.active && !rider.routeClear) {
        targetX = C.CAR_MIN_X;
        target = Math.min(target, 20);
        const gap = rider.position - (simulation.distance + C.CAR_LENGTH_M / 2);
        if (gap < 26) target = 16;
        if (gap < 11) target = 8;
        if (gap < 5) target = 0;
      } else if (event.behavior === 'diagonal' && riderRequired(event)) {
        if (remaining < 21) target = 0;
        else target = 18;
      } else if (event.behavior === 'swerve' && remaining > -C.RISK_END) {
        targetX = C.CAR_MIN_X;
      }
    }
    return {
      throttle: simulation.speed < target - 0.4,
      brake: simulation.speed > target + 0.4,
      left: simulation.x > targetX + 0.5,
      right: simulation.x < targetX - 0.5
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
      this.scoring.sharpSteers = 0;
      this.scoring.steeringReversals = 0;
      this.scoring.steeringCooldown = 0;
      this.lastSteering = 0;
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
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
      const remaining = eventBefore ? eventBefore.position - this.distance : Infinity;
      const emergencyBrake = eventBefore && riderRequired(eventBefore) &&
        this.speed > C.HARD_BRAKE_MIN_SPEED && remaining < 12 && remaining > -2;
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

      const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      if (this.speed > 0.5) {
        this.x = M.clamp(this.x + steering * C.STEER_SPEED * dt, C.CAR_MIN_X, C.CAR_MAX_X);
      }

      const event = this.currentEvent;
      if (event) {
        this.updateEvent(event, dt, input);
        Scoring.recordStep(this.scoring, this, dt);
        if (!event.resolved && this.predictConflict(event, input)) {
          this.freeze(event);
          return;
        }
        if (!event.resolved && this.eventCanResolve(event)) this.resolveEvent(event);
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

    updateEvent(event, dt, input) {
      const remaining = event.position - this.distance;
      const rider = event.rider;
      if (!rider.active && !rider.cleared && remaining <= C.EVENT_ACTIVATE) {
        rider.active = true;
        if (event.behavior === 'diagonal') rider.state = 'crossing';
      }

      if (remaining <= C.APPROACH_START && remaining >= C.RISK_START - 5 && !input.throttle) {
        event.earlyControlTime += dt;
      }
      if (!event.recordedApproach && remaining <= C.RECOGNITION_CHECK) {
        event.recordedApproach = true;
        event.speedAtApproach = this.speed;
      }
      if (!event.recordedSlow && remaining <= C.SLOW_CHECK) {
        event.recordedSlow = true;
        event.speedAtSlow = this.speed;
      }
      if (!event.recordedLate && remaining <= C.LATE_CHECK) {
        event.recordedLate = true;
        event.speedAtLate = this.speed;
      }
      if (event.recordedSlow && riderRequired(event)) {
        event.maxSpeedAfterSlow = Math.max(event.maxSpeedAfterSlow, this.speed);
      }
      if (event.behavior === 'wrong-way' && rider.active && !rider.cleared && remaining < 45) {
        if (horizontalGap(this, rider) >= 22) event.correctSpaceTime += dt;
      }

      advanceRider(event, rider, dt, this.distance);
      this.measureSpace(event, dt);

      const waiting = riderRequired(event) && this.speed < 1.2 && remaining >= 3 && remaining <= C.YIELD_ZONE_FAR;
      if (waiting) event.wasWaiting = true;
      if (event.wasWaiting && rider.routeClear && this.speed < 1.2) event.waitedUntilClear = true;
    }

    measureSpace(event) {
      const rider = event.rider;
      if (!rider.active || rider.cleared) return;
      const horizontal = horizontalGap(this, rider);
      const vertical = verticalGap(this, rider);
      if (vertical < 8) event.maxHorizontalSeparation = Math.max(event.maxHorizontalSeparation, horizontal);
      if (event.behavior === 'swerve' && horizontal < 25 && rider.position > this.distance) {
        const gap = rider.position - (this.distance + C.CAR_LENGTH_M / 2);
        event.minFollowingGap = Math.min(event.minFollowingGap, gap);
      }
      if (vertical < C.CAR_LENGTH_M / 2 + C.BIKE_HALF_LENGTH + 0.7 &&
        horizontal >= C.CONTACT_HALF_WIDTH && horizontal < C.CLOSE_PASS_WIDTH) {
        event.closePass = true;
      }
    }

    eventCanResolve(event) {
      if (event.behavior === 'wrong-way') {
        return event.rider.cleared && this.distance >= event.position - 12;
      }
      if (event.behavior === 'swerve') {
        return event.rider.routeClear && this.distance >= event.obstaclePosition + 5;
      }
      return event.rider.routeClear && this.distance >= event.position + C.RISK_END;
    }

    // 用同一骑行者状态机和当前踏板外推，充分制动能避免接触时不提前误罚。
    predictConflict(event, input) {
      if (!riderRequired(event) || this.speed < 0.8) return false;
      const horizon = Math.max(0.55, Math.min(1.5, this.speed / 3.6 * 0.13));
      const substep = 0.025;
      const rider = Object.assign({}, event.rider);
      let distance = this.distance;
      let velocity = this.speed / 3.6;
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
        advanceRider(event, rider, slice, nextDistance);
        if (!rider.routeClear && !rider.cleared &&
          Math.abs(rider.x - nextX) < C.CONTACT_HALF_WIDTH &&
          Math.abs(rider.position - nextDistance) < C.CAR_LENGTH_M / 2 + C.BIKE_HALF_LENGTH) {
          return true;
        }
        distance = nextDistance;
        velocity = nextVelocity;
        x = nextX;
        if (velocity <= 0) break;
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
        speed: this.speed,
        remaining: Math.max(0, event.rider.position - (this.distance + C.CAR_LENGTH_M / 2)),
        stoppingDistance: M.stoppingDistance(this.speed),
        closingSpeed: event.behavior === 'wrong-way' ? this.speed + event.rider.speed * 3.6 :
          Math.abs(this.speed - event.rider.speed * 3.6),
        carTime: times.car,
        riderTime: times.rider
      };
    }

    resolveEvent(event) {
      event.resolved = true;
      event.recognized = event.speedAtApproach != null && event.speedAtApproach <= 36 &&
        event.earlyControlTime >= 0.2 &&
        (event.behavior !== 'wrong-way' || event.correctSpaceTime >= 0.15);
      event.earlySlow = event.speedAtSlow != null && event.speedAtSlow <= 24 &&
        (event.maxSpeedAfterSlow <= 28 || !event.recordedSlow);
      if (event.behavior === 'wrong-way') {
        event.spaceScore = event.maxHorizontalSeparation >= 22 && !event.closePass;
      } else if (event.behavior === 'swerve') {
        event.spaceScore = !event.closePass &&
          (event.minFollowingGap >= 5 || event.minFollowingGap === Infinity);
      } else {
        event.spaceScore = !event.closePass;
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
      const demo = new Simulation(this.seed);
      for (let index = 0; index < eventId; index += 1) {
        demo.events[index].resolved = true;
        demo.events[index].earlySlow = true;
        demo.events[index].recognized = true;
        demo.events[index].spaceScore = true;
      }
      demo.distance = Math.max(0, demo.events[eventId].position - C.APPROACH_START);
      demo.speed = 40;
      demo.previousSpeed = 40;
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
      this.demoMode = 'rider';
      this.justResolved = null;
      this.status = 'demonstrating';
    }

    finishReplay() {
      if (this.demoMode !== 'rider') return;
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
      const replayDone = this.demoMode === 'rider' && event.resolved && this.demoTime > 3;
      if (demo.status === 'frozen' || demo.status === 'timeout' ||
        (this.demoMode === 'driver' && event.resolved && demo.distance > event.position + 5) ||
        this.demoTime >= 35 || replayDone) {
        if (this.demoMode === 'rider') this.finishReplay();
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
      if (!event || simulation.speed >= 1.2 || !riderRequired(event)) return false;
      const remaining = event.behavior === 'wrong-way'
        ? event.rider.position - (simulation.distance + C.CAR_LENGTH_M / 2)
        : event.position - (simulation.distance + C.CAR_LENGTH_M / 2);
      return remaining >= 0 && remaining <= C.YIELD_ZONE_FAR;
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
      return (event.recognized ? 3 : 0) + (event.earlySlow ? 4 : 0) + (event.spaceScore ? 3 : 0);
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
        summaryKey = 'scene.nonmotor.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }

      const earlySlowCount = simulation.events.filter(function (event) { return event.earlySlow; }).length;
      let adviceKey = 'scene.nonmotor.result.advice.default';
      if (failed) adviceKey = 'scene.nonmotor.result.advice.failed';
      else if (simulation.events.some(function (event) { return event.closePass; })) adviceKey = 'scene.nonmotor.result.advice.close';
      else if (earlySlowCount < 3) adviceKey = 'scene.nonmotor.result.advice.early';
      else if (state.hardBrakes > 0 || state.sharpSteers > 0) adviceKey = 'scene.nonmotor.result.advice.smooth';
      else if (timedOut || efficiency < 12) adviceKey = 'result.advice.efficiency';
      else if (observation < 28) adviceKey = 'scene.nonmotor.result.advice.observation';

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

  function drawArrow(ctx, x, y, direction, color) {
    Draw.rect(ctx, color, x - 2, y - 7, 4, 14);
    if (direction > 0) {
      Draw.rect(ctx, color, x - 5, y - 7, 4, 4);
      Draw.rect(ctx, color, x + 2, y - 7, 4, 4);
      Draw.rect(ctx, color, x - 2, y - 11, 4, 4);
    } else {
      Draw.rect(ctx, color, x - 5, y + 4, 4, 4);
      Draw.rect(ctx, color, x + 2, y + 4, 4, 4);
      Draw.rect(ctx, color, x - 2, y + 8, 4, 4);
    }
  }

  function drawCyclist(ctx, event, rider, y, replay) {
    if (!rider.active && !rider.cleared) return;
    if (rider.cleared && event.behavior !== 'swerve') return;
    if (y < -25 || y > C.HEIGHT + 25) return;
    const x = rider.x;
    const direction = event.behavior === 'wrong-way' ? -1 : (event.behavior === 'diagonal' ? rider.direction : 1);
    const coat = replay ? '#80e0b1' : event.coatColor;
    Draw.rect(ctx, '#10232b88', x + 2, y + 3, 6, 18);
    Draw.rect(ctx, '#14232b', x - 2, y - 10, 5, 9);
    Draw.rect(ctx, '#14232b', x - 2, y + 5, 5, 9);
    Draw.rect(ctx, '#a9b7a7', x - 1, y - 9, 3, 5);
    Draw.rect(ctx, '#a9b7a7', x - 1, y + 7, 3, 5);
    Draw.rect(ctx, coat, x - 5, y - 3, 11, 10);
    Draw.rect(ctx, event.skinColor, x - 3, y + (direction < 0 ? 7 : -9), 6, 5);
    Draw.rect(ctx, '#314047', x - 3, y + (direction < 0 ? 11 : -11), 6, 2);
    if (event.behavior === 'wrong-way') drawArrow(ctx, x + 12, y + 8, -1, '#ffd166');
    if (event.behavior === 'diagonal') {
      Draw.rect(ctx, '#f4f0ddaa', x - rider.direction * 11, y - 2, 6, 2);
      Draw.rect(ctx, '#f4f0dd77', x - rider.direction * 18, y + 2, 8, 2);
    }
  }

  function drawObstacle(ctx, simulation, event) {
    const y = worldY(simulation, event.obstaclePosition);
    if (y < -30 || y > C.HEIGHT + 30) return;
    Draw.rect(ctx, '#1b2a2f66', 220, y + 8, 29, 8);
    Draw.rect(ctx, '#f0c85c', 220, y - 5, 27, 10);
    for (let x = 221; x < 246; x += 8) Draw.rect(ctx, '#d86654', x, y - 5, 4, 10);
    Draw.rect(ctx, '#27363b', 222, y + 5, 4, 7);
    Draw.rect(ctx, '#27363b', 241, y + 5, 4, 7);
    Draw.rect(ctx, '#ffe59a', 226, y - 13, 15, 6);
  }

  function drawAlley(ctx, simulation, event) {
    const y = worldY(simulation, event.position + 5);
    if (y < -45 || y > C.HEIGHT + 45) return;
    if (event.diagonalDirection > 0) {
      Draw.rect(ctx, '#7f877b', 0, y - 17, 83, 36);
      Draw.rect(ctx, '#52625d', 0, y - 12, 78, 25);
      Draw.rect(ctx, '#d6cfb4', 72, y - 19, 10, 4);
      Draw.rect(ctx, '#d6cfb4', 72, y + 17, 10, 4);
    } else {
      Draw.rect(ctx, '#7f877b', 295, y - 17, 65, 36);
      Draw.rect(ctx, '#52625d', 300, y - 12, 60, 25);
      Draw.rect(ctx, '#d6cfb4', 294, y - 19, 10, 4);
      Draw.rect(ctx, '#d6cfb4', 294, y + 17, 10, 4);
    }
  }

  function drawEventGuide(ctx, simulation, event) {
    const rider = event.rider;
    const y = worldY(simulation, rider.position);
    if (!rider.active || rider.cleared || y < -20 || y > C.HEIGHT + 20) return;
    ctx.save();
    ctx.strokeStyle = event.behavior === 'wrong-way' ? '#ffd16688' : '#80e0b166';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    if (event.behavior === 'wrong-way') {
      ctx.moveTo(rider.x, y + 13);
      ctx.lineTo(rider.x, Math.min(C.HEIGHT, y + 55));
    } else if (event.behavior === 'swerve' && rider.state !== 'approach') {
      ctx.moveTo(rider.x, y);
      ctx.lineTo(198, worldY(simulation, event.obstaclePosition + 3));
      ctx.lineTo(234, worldY(simulation, event.obstaclePosition + 12));
    } else if (event.behavior === 'diagonal') {
      ctx.moveTo(rider.x, y);
      ctx.lineTo(rider.direction > 0 ? 316 : 62,
        worldY(simulation, rider.position - 9));
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawWorld(ctx, simulation, demo, replay) {
    Draw.drawEnvironment(ctx, simulation, C, 172);
    const firstMarker = Math.floor((simulation.distance - 30) / 18);
    for (let index = firstMarker; index < firstMarker + 8; index += 1) {
      const y = worldY(simulation, index * 18);
      if (index % 2 === 0) drawArrow(ctx, 127, y, -1, '#aab5a644');
      else drawArrow(ctx, 209, y, 1, '#aab5a633');
    }
    simulation.events.forEach(function (event) {
      if (event.behavior === 'diagonal') drawAlley(ctx, simulation, event);
      if (event.behavior === 'swerve') drawObstacle(ctx, simulation, event);
      drawEventGuide(ctx, simulation, event);
      drawCyclist(ctx, event, event.rider, worldY(simulation, event.rider.position), replay);
    });
    Draw.drawCar(ctx, simulation.x, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);

    const current = simulation.currentEvent;
    if (current && current.behavior === 'wrong-way' && riderRequired(current)) {
      const closing = simulation.speed + current.rider.speed * 3.6;
      Draw.rect(ctx, '#132633dd', 96, 102, 168, 24);
      ctx.fillStyle = '#ffe6a4';
      Draw.fillFittedText(ctx, t('scene.nonmotor.canvas.closing', { speed: Math.round(closing) }), 104, 118, 152, 10, 'sans-serif');
    }
    if (demo) {
      Draw.rect(ctx, '#0e202ddd', 198, 552, 146, 48);
      ctx.fillStyle = '#a6f0c8';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(Math.round(simulation.speed) + ' km/h', 207, 575);
      ctx.fillStyle = '#d4e3db';
      Draw.fillFittedText(ctx, t(replay ? 'scene.nonmotor.canvas.replay' : 'scene.nonmotor.canvas.principles'),
        207, 591, 128, 9, 'sans-serif');
    }
  }

  function drawFreeze(ctx, simulation) {
    const event = simulation.events[simulation.freezeInfo.eventId];
    const rider = event.rider;
    if (rider.active) {
      ctx.save();
      ctx.strokeStyle = '#fff0a8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(rider.x, worldY(simulation, rider.position));
      ctx.lineTo(simulation.x, C.CAR_Y);
      ctx.stroke();
      ctx.restore();
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
        drawWorld(ctx, simulation.demo, true, simulation.demoMode === 'rider');
        return;
      }
      drawWorld(ctx, simulation, false, false);
      if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
    }
  };

  Scenes['nonmotor-mix'] = {
    id: 'nonmotor-mix',
    Constants: C,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    defensiveInput: defensiveInput,
    advanceRider: advanceRider,
    riderRequired: riderRequired,
    estimateConflictTimes: estimateConflictTimes,
    ui: {
      progress: function (simulation) {
        if (simulation.status === 'demonstrating' && simulation.demoMode === 'rider') {
          return t('scene.nonmotor.hud.replay', { number: simulation.demoEventId + 1 });
        }
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.nonmotor.hud.progress', { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && Scoring.eventSafe(event); }).length
        ];
      },
      smoothScore: function (simulation) {
        return Scoring.smoothScore(simulation.scoring);
      },
      updateControls: function (doc, simulation) {
        const replay = simulation.status === 'demonstrating' && simulation.demoMode === 'rider';
        const badge = doc.querySelector('#demo-screen .demo-badge');
        const skip = doc.getElementById('skip-demo-button');
        if (badge) badge.textContent = t(replay ? 'scene.nonmotor.replay.badge' : 'game.demoBadge');
        if (skip) skip.textContent = t(replay ? 'scene.nonmotor.replay.skip' : 'game.skipDemo');
      },
      coach: function (simulation, displaySpeed) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        const remaining = event ? event.position - current.distance : Infinity;
        const rider = event && event.rider.active && !event.rider.cleared ? event.rider : null;
        let coach = 'scene.nonmotor.hud.cruise';
        let status = displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : 'hud.speedUp';
        let tone = '';
        let coachTone = '';

        if (simulation.demoMode === 'rider' && simulation.status === 'demonstrating') {
          return { text: t('scene.nonmotor.hud.replayCoach'), status: t('scene.nonmotor.hud.replayStatus'), tone: '', coachTone: 'good' };
        }
        if (displaySpeed < 25 && !rider && (!event || remaining > C.RISK_START)) {
          status = 'hud.tooSlow';
          tone = 'warn';
        } else if (displaySpeed > 55 && (!event || remaining > C.RISK_START)) {
          status = 'hud.nearLimit';
          tone = 'danger';
        }
        if (rider && remaining <= C.APPROACH_START) {
          coachTone = displaySpeed < 1.2 ? 'good' : 'risk';
          status = displaySpeed < 1.2 ? 'hud.yielding' : 'hud.prepareSlow';
          tone = displaySpeed < 1.2 ? '' : 'warn';
          if (event.behavior === 'wrong-way') coach = 'scene.nonmotor.hud.wrongWay';
          else if (event.behavior === 'swerve') coach = rider.state === 'swerving' ? 'scene.nonmotor.hud.swerving' : 'scene.nonmotor.hud.obstacle';
          else coach = displaySpeed < 1.2 ? 'scene.nonmotor.hud.wait' : 'scene.nonmotor.hud.diagonal';
        } else if (event && remaining <= C.APPROACH_START && remaining > -C.RISK_END) {
          coach = 'scene.nonmotor.hud.scan';
          status = 'hud.prepareSlow';
          coachTone = 'risk';
        } else if (event && event.rider.routeClear && remaining > -C.RISK_END) {
          coach = 'scene.nonmotor.hud.resume';
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
        return { key: 'scene.nonmotor.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        if (event.closePass) return { key: 'scene.nonmotor.toast.close', params: { score: score }, neutral: true };
        if (score === 10) return { key: 'scene.nonmotor.toast.safe', params: { score: score }, neutral: false };
        return { key: 'scene.nonmotor.toast.improve', params: { score: score }, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        const key = info.behavior === 'wrong-way' ? 'scene.nonmotor.failure.wrongWay' :
          (info.behavior === 'swerve' ? 'scene.nonmotor.failure.swerve' : 'scene.nonmotor.failure.diagonal');
        return t(key, {
          speed: Math.round(info.speed),
          closing: Math.round(info.closingSpeed),
          remaining: Math.max(0, info.remaining).toFixed(1),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo.events[simulation.demoEventId];
        if (simulation.demoMode === 'rider') {
          const phase = Math.floor(simulation.demoTime / 3) % 2;
          const key = event.behavior + (phase ? 'Driver' : 'Rider');
          return { step: t('scene.nonmotor.replay.' + key), substep: t('scene.nonmotor.replay.neutral') };
        }
        let key = 'scene.nonmotor.demo.scan';
        if (event.resolved || event.rider.routeClear) key = 'scene.nonmotor.demo.pass';
        else if (event.behavior === 'wrong-way') key = 'scene.nonmotor.demo.wrongWay';
        else if (event.behavior === 'swerve') key = 'scene.nonmotor.demo.swerve';
        else if (demo.speed < 1.2) key = 'scene.nonmotor.demo.wait';
        else key = 'scene.nonmotor.demo.diagonal';
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
