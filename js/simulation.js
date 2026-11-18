(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const C = Game.C;
  const M = Game.Model;

  class Simulation {
    constructor(seed) {
      this.seed = seed;
      this.distance = 0;
      this.speed = C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.x = C.CAR_X;
      this.elapsed = 0;
      this.status = 'ready';
      this.events = M.createEvents(seed);
      this.scoring = Game.Scoring.createState();
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demoTime = 0;
      this.demo = null;
      this.retryCount = 0;
    }

    start() {
      this.status = 'driving';
    }

    get currentEvent() {
      return this.events.find(function (event) { return !event.resolved; }) || null;
    }

    get finishDistance() {
      return C.BUS_POSITIONS[C.BUS_POSITIONS.length - 1] + C.FINISH_BUFFER;
    }

    getRiskEvent() {
      return Game.Scoring.getRiskEvent(this);
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      this.justHardBrake = false;
      this.justResolved = null;
      this.previousSpeed = this.speed;

      let acceleration = -C.NATURAL_DECELERATION;
      const approachingEvent = this.currentEvent;
      const emergencyBrake = approachingEvent && this.speed > C.HARD_BRAKE_MIN_SPEED &&
        approachingEvent.busPosition - this.distance < C.REVEAL_DISTANCE &&
        approachingEvent.busPosition - this.distance > -2;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = -(emergencyBrake ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);

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
        Game.Scoring.recordStep(this.scoring, this, dt);
        if (event.occupied && !event.resolved && this.predictConflict(event)) {
          this.freeze(event);
          return;
        }
        if (!event.resolved && this.distance > event.busPosition + C.RISK_END) {
          this.resolveEvent(event);
        }
      } else {
        Game.Scoring.recordStep(this.scoring, this, dt);
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
      const distanceToBus = event.busPosition - this.distance;
      if (distanceToBus <= C.RISK_START && distanceToBus >= -C.RISK_END) {
        event.minSpeedInRisk = Math.min(event.minSpeedInRisk, this.speed);
        // 驶过公交车头后即可加速，不再计入“通过速度”判定
        if (event.recorded30 && distanceToBus > 0) event.maxSpeedAfter30 = Math.max(event.maxSpeedAfter30, this.speed);
        event.maxLateralShift = Math.max(event.maxLateralShift, C.CAR_X - this.x);
      }

      if (!event.recorded30 && distanceToBus <= C.SLOW_CHECK) {
        event.recorded30 = true;
        event.speedAt30 = this.speed;
        event.maxSpeedAfter30 = Math.max(event.maxSpeedAfter30, this.speed);
      }
      if (!event.recorded15 && distanceToBus <= C.LATE_CHECK) {
        event.recorded15 = true;
        event.speedAt15 = this.speed;
      }

      if (event.occupied && !event.pedestrian.active && distanceToBus <= C.PEDESTRIAN_TRIGGER) {
        event.pedestrian.active = true;
        event.pedestrian.visible = true;
      }

      if (event.pedestrian.active && !event.pedestrian.waiting) {
        const pedestrian = event.pedestrian;
        pedestrian.x = Math.max(C.PEDESTRIAN_WAIT_X,
          pedestrian.x - event.runSpeed * dt);
        pedestrian.visible = true;
        if (pedestrian.x <= C.PEDESTRIAN_WAIT_X) pedestrian.waiting = true;
      }
    }

    predictConflict(event) {
      const pedestrian = event.pedestrian;
      if (!pedestrian.active || pedestrian.waiting || this.speed < 1.5) return false;

      const pedestrianY = event.busPosition + 1.8;
      const carHalfWidth = C.CAR_WIDTH_M * C.PIXELS_PER_METER / 2;
      const speedMps = this.speed / 3.6;
      const horizon = Math.max(0.48, Math.min(1.1, speedMps * 0.16));

      for (let t = 0; t <= horizon; t += 0.06) {
        const centerDistance = this.distance + speedMps * t;
        const carFront = centerDistance + C.CAR_LENGTH_M / 2;
        const carRear = centerDistance - C.CAR_LENGTH_M / 2;
        const pedestrianX = Math.max(C.PEDESTRIAN_WAIT_X,
          pedestrian.x - event.runSpeed * t);
        const horizontal = Math.abs(pedestrianX - this.x) < carHalfWidth + 3.2;
        const vertical = pedestrianY > carRear - 0.4 && pedestrianY < carFront + 0.5;
        if (horizontal && vertical) return true;
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
        distanceToBus: Math.max(0, event.busPosition - this.distance),
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
      const event = this.events[this.freezeInfo ? this.freezeInfo.eventId : 0];
      if (!event) return;
      this.distance = event.busPosition - 55;
      this.speed = 30;
      this.previousSpeed = 30;
      this.lastDeceleration = 0;
      this.x = C.CAR_X;
      event.recorded30 = false;
      event.recorded15 = false;
      event.speedAt30 = null;
      event.speedAt15 = null;
      event.minSpeedInRisk = Infinity;
      event.maxSpeedAfter30 = 0;
      event.maxLateralShift = 0;
      event.earlySlow = false;
      event.lateSlow = false;
      event.pedestrian = {
        active: false,
        x: C.PEDESTRIAN_START_X,
        visible: false,
        waiting: false,
        hiddenAgain: false
      };
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.status = 'driving';
    }

    startDemo() {
      if (!this.freezeInfo) return;
      this.status = 'demonstrating';
      this.demoTime = 0;
      this.demo = {
        eventId: this.freezeInfo.eventId,
        distance: this.events[this.freezeInfo.eventId].busPosition - 58,
        speed: 45,
        x: C.CAR_X,
        pedestrianX: C.PEDESTRIAN_START_X,
        pedestrianActive: false
      };
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      const demo = this.demo;
      const event = this.events[demo.eventId];
      const distanceToBus = event.busPosition - demo.distance;

      let targetSpeed = distanceToBus > 24 ? 45 : 18;
      if (demoTimeSafe(this.demoTime)) targetSpeed = 18;
      demo.speed = M.moveToward(demo.speed, targetSpeed, 8 * dt);
      demo.x = M.moveToward(demo.x, C.CAR_MIN_X + 5, 7 * dt);
      demo.distance += demo.speed / 3.6 * dt;
      if (!demo.pedestrianActive && distanceToBus <= C.PEDESTRIAN_TRIGGER) demo.pedestrianActive = true;
      if (demo.pedestrianActive) {
        demo.pedestrianX = Math.max(C.PEDESTRIAN_WAIT_X, demo.pedestrianX - event.runSpeed * dt);
      }

      const willMeet = event.busPosition - demo.distance < 8 && demo.pedestrianX > this.x - 20;
      if (willMeet) demo.speed = M.moveToward(demo.speed, 0, 14 * dt);

      if (this.demoTime >= 5.5 || demo.distance > event.busPosition + C.RISK_END) {
        this.retryEvent();
      }
    }
  }

  function demoTimeSafe(time) {
    return time > 1.4;
  }

  Game.Simulation = Simulation;
})(typeof window !== 'undefined' ? window : globalThis);
