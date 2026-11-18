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
    ROLE_ORDER: ['passenger', 'cyclist', 'driver'],
    PARKED_POSITION: 120,
    PARKED_X: 248,
    BIKE_X: 202,
    BIKE_MIN_X: 150,
    BIKE_MAX_X: 214,
    BIKE_AVOID_X: 166,
    MOTOR_X: 142,
    DRIVER_MIN_X: 126,
    DRIVER_MAX_X: 202,
    DOOR_HINGE_X: 234,
    DOOR_HINGE_OFFSET: 1.2,
    DOOR_LENGTH_PX: 38,
    DOOR_OPEN_TIME: 0.55,
    DOOR_CRACK_TIME: 0.45,
    DOOR_CRACK_ANGLE: 12,
    DOOR_MAX_ANGLE: 90,
    BIKE_RADIUS_PX: 9,
    CYCLIST_MAX_SPEED: 36,
    CYCLIST_ACCELERATION: 2.4,
    CYCLIST_BRAKE: 4.2,
    DRIVER_FINISH_GAP: 14,
    CYCLIST_FINISH_GAP: 14,
    MAX_TIME: 150,
    FIXED_STEP: 1 / 60
  });

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed('dooring:' + seed));
    return Object.freeze({
      seed: seed,
      parkedPosition: C.PARKED_POSITION,
      cyclistSpeed: 20 + random() * 4,
      trafficSpeed: 38 + random() * 4,
      driverCyclistSpeed: 20 + random() * 3,
      doorDelay: 3.4 + random() * 0.6,
      doorHold: 2.7 + random() * 0.6,
      cyclistAvoids: random() < 0.5,
      parkedColor: ['#d5b757', '#7ea6c9', '#c6806d'][Math.floor(random() * 3)],
      coatColor: ['#f4d35e', '#ee6c72', '#7fd1ed'][Math.floor(random() * 3)],
      skinColor: random() > 0.5 ? '#efb489' : '#c88760'
    });
  }

  function createDoor() {
    return {
      state: 'closed',
      stateTime: 0,
      angle: 0,
      hold: 0,
      holdDuration: 0,
      automatic: false,
      hasOpened: false,
      cycleComplete: false
    };
  }

  function setDoorState(door, state) {
    door.state = state;
    door.stateTime = 0;
  }

  function triggerDoor(door, holdDuration, automatic) {
    if (door.state !== 'closed' || door.cycleComplete) return;
    door.automatic = Boolean(automatic);
    door.holdDuration = holdDuration;
    setDoorState(door, automatic ? 'cracked' : 'opening');
    if (!automatic) door.hasOpened = true;
  }

  function updateDoor(door, dt) {
    if (!door) return;
    door.stateTime += dt;
    const openingRate = C.DOOR_MAX_ANGLE / C.DOOR_OPEN_TIME;
    if (door.state === 'cracked') {
      door.angle = M.moveToward(door.angle, C.DOOR_CRACK_ANGLE, openingRate * dt);
      if (door.automatic && door.stateTime >= C.DOOR_CRACK_TIME) {
        door.hasOpened = true;
        setDoorState(door, 'opening');
      }
    } else if (door.state === 'opening') {
      door.hasOpened = true;
      door.angle = Math.min(C.DOOR_MAX_ANGLE, door.angle + openingRate * dt);
      if (door.angle >= C.DOOR_MAX_ANGLE) {
        door.hold = door.holdDuration;
        setDoorState(door, 'open');
      }
    } else if (door.state === 'open') {
      door.hold = Math.max(0, door.hold - dt);
      if (door.hold <= 0) setDoorState(door, 'closing');
    } else if (door.state === 'closing') {
      door.angle = Math.max(0, door.angle - openingRate * dt);
      if (door.angle <= 0) {
        door.cycleComplete = true;
        door.automatic = false;
        setDoorState(door, 'closed');
      }
    }
  }

  function doorSegment(door) {
    const angle = door.angle * Math.PI / 180;
    const hinge = {
      x: C.DOOR_HINGE_X,
      y: (C.PARKED_POSITION + C.DOOR_HINGE_OFFSET) * C.PIXELS_PER_METER
    };
    return {
      start: hinge,
      end: {
        x: hinge.x - Math.sin(angle) * C.DOOR_LENGTH_PX,
        y: hinge.y - Math.cos(angle) * C.DOOR_LENGTH_PX
      }
    };
  }

  function pointSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0.000001) {
      return Math.hypot(point.x - start.x, point.y - start.y);
    }
    const amount = M.clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
    return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
  }

  function doorContact(door, x, distance) {
    if (!door || door.angle <= 0.001) return false;
    const segment = doorSegment(door);
    return pointSegmentDistance({ x: x, y: distance * C.PIXELS_PER_METER }, segment.start, segment.end) <= C.BIKE_RADIUS_PX;
  }

  function carBikeContact(carX, carDistance, bikeX, bikeDistance) {
    return Math.abs(carX - bikeX) < 22 &&
      Math.abs(carDistance - bikeDistance) * C.PIXELS_PER_METER < 32;
  }

  function createRole(role, id) {
    return {
      id: id,
      role: role,
      resolved: false,
      failed: false,
      attempts: 0,
      observation: 0,
      earlySlow: false,
      closePasses: 0,
      hardBrakeAtStart: 0
    };
  }

  class Simulation {
    constructor(seed) {
      this.seed = seed;
      this.plan = createPlan(seed);
      this.events = C.ROLE_ORDER.map(createRole);
      this.roleIndex = 0;
      this.elapsed = 0;
      this.status = 'ready';
      this.speed = 0;
      this.previousSpeed = 0;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.distance = 0;
      this.x = C.BIKE_X;
      this.scoring = Game.Scoring.createState();
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.retryCount = 0;
      this.setupRole(0);
    }

    get currentEvent() {
      return this.events[this.roleIndex] || null;
    }

    get currentRole() {
      return C.ROLE_ORDER[this.roleIndex];
    }

    start() {
      this.status = 'driving';
    }

    setupRole(index) {
      this.roleIndex = index;
      const role = this.events[index];
      role.observation = 0;
      role.earlySlow = false;
      role.lateSlow = false;
      role.closePasses = 0;
      role.closePassActive = false;
      role.lookDuration = 0;
      role.lookedBeforeOpen = false;
      role.usedCrack = false;
      role.openedAfterCrack = false;
      role.waitedForClear = false;
      role.unsafeOpen = false;
      role.firstOpen = false;
      role.necessaryStop = false;
      role.safePass = false;
      role.earlyGap = false;
      role.doorTriggered = false;
      role.aiTargetX = C.BIKE_X;
      role.roleTime = 0;
      role.previousInput = {};
      role.controlLock = 0.2;
      this.roleTime = 0;
      this.controlLock = 0.2;
      this.previousInput = {};
      this.door = createDoor();
      this.cyclist = null;
      this.traffic = null;
      this.justResolved = null;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      if (role.role === 'passenger') {
        this.distance = C.PARKED_POSITION;
        this.speed = 0;
        this.x = C.PARKED_X;
        this.cyclist = {
          x: C.BIKE_X,
          distance: C.PARKED_POSITION - 55,
          speed: this.plan.cyclistSpeed
        };
      } else if (role.role === 'cyclist') {
        this.distance = C.PARKED_POSITION - 55;
        this.speed = 24;
        this.x = C.BIKE_X;
        this.traffic = {
          x: C.MOTOR_X,
          distance: this.distance - 20,
          speed: this.plan.trafficSpeed
        };
      } else {
        this.distance = C.PARKED_POSITION - 70;
        this.speed = 34;
        this.x = C.MOTOR_X;
        this.cyclist = {
          x: C.BIKE_X,
          distance: C.PARKED_POSITION - 42,
          speed: this.plan.driverCyclistSpeed
        };
      }
      this.previousSpeed = this.speed;
    }

    brakingRate(cyclist) {
      if (cyclist) {
        const remaining = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - this.distance;
        return !this.door.cycleComplete && remaining < 14 && this.speed > 20 ? 6 : C.CYCLIST_BRAKE;
      }
      const gap = this.cyclist ? this.cyclist.distance - this.distance : Infinity;
      return gap < 12 && this.speed > 25 ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION;
    }

    movePlayer(input, dt, cyclist) {
      const previous = this.speed / 3.6;
      const maxSpeed = cyclist ? C.CYCLIST_MAX_SPEED : C.MAX_SPEED;
      const accelerationRate = cyclist ? C.CYCLIST_ACCELERATION : C.ACCELERATION;
      const brakeRate = input.brake ? this.brakingRate(cyclist) :
        (cyclist ? C.CYCLIST_BRAKE : C.BRAKE_DECELERATION);
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = accelerationRate;
      if (input.brake) acceleration = -brakeRate;
      this.acceleration = acceleration;
      let next = M.clamp(previous + acceleration * dt, 0, maxSpeed / 3.6);
      if (!input.throttle && !input.brake && this.speed < 1) next = 0;
      this.lastDeceleration = Math.max(0, (previous - next) / dt);
      this.speed = next * 3.6;
      this.distance += (previous + next) * 0.5 * dt;
      if (this.speed > 0.5) {
        const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        const minX = cyclist ? C.BIKE_MIN_X : C.DRIVER_MIN_X;
        const maxX = cyclist ? C.BIKE_MAX_X : C.DRIVER_MAX_X;
        this.x = M.clamp(this.x + steering * C.STEER_SPEED * dt, minX, maxX);
      }
    }

    recordStep(dt, quality, exempt, necessaryBraking) {
      const state = this.scoring;
      if (!exempt) {
        state.efficiencyIntegral += M.clamp(quality, 0, 1) * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const harsh = this.lastDeceleration > C.HARD_BRAKE &&
        this.previousSpeed > C.HARD_BRAKE_MIN_SPEED && !necessaryBraking;
      if (harsh && state.hardBrakeCooldown <= 0) {
        state.hardBrakeDuration += dt;
        if (state.hardBrakeDuration >= 0.15) {
          state.hardBrakes += 1;
          state.hardBrakeDuration = 0;
          state.hardBrakeCooldown = 1.2;
          this.justHardBrake = true;
        }
      } else if (!harsh) {
        state.hardBrakeDuration = 0;
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
      this.elapsed += dt;
      this.roleTime += dt;
      this.currentEvent.roleTime = this.roleTime;
      this.controlLock = Math.max(0, this.controlLock - dt);
      if (this.currentRole === 'passenger') this.stepPassenger(input, dt);
      else if (this.currentRole === 'cyclist') this.stepCyclist(input, dt);
      else this.stepDriver(input, dt);
      this.previousInput = {
        left: Boolean(input.left),
        right: Boolean(input.right),
        throttle: Boolean(input.throttle),
        brake: Boolean(input.brake)
      };
      if (this.status === 'driving' && this.elapsed >= C.MAX_TIME) {
        this.speed = 0;
        this.status = 'timeout';
      }
    }

    stepPassenger(input, dt) {
      const role = this.currentEvent;
      const door = this.door;
      this.cyclist.distance += this.cyclist.speed / 3.6 * dt;
      if (input.left && this.controlLock <= 0) role.lookDuration += dt;
      const crackPressed = input.brake;
      const openPressed = input.throttle;
      if (this.controlLock <= 0 && crackPressed && door.state === 'closed' && !role.firstOpen) {
        role.usedCrack = true;
        triggerDoor(door, this.plan.doorHold, false);
        door.state = 'cracked';
        door.hasOpened = false;
      }
      if (this.controlLock <= 0 && openPressed && !role.firstOpen &&
        (door.state === 'closed' || door.state === 'cracked')) {
        role.firstOpen = true;
        role.lookedBeforeOpen = role.lookDuration >= 0.45;
        role.openedAfterCrack = door.state === 'cracked';
        role.waitedForClear = this.cyclist.distance > C.PARKED_POSITION + 7;
        role.unsafeOpen = !role.waitedForClear && this.cyclist.distance > C.PARKED_POSITION - 32;
        door.automatic = false;
        door.holdDuration = this.plan.doorHold;
        door.hasOpened = true;
        setDoorState(door, 'opening');
      }
      updateDoor(door, dt);
      const waiting = !role.firstOpen && this.cyclist.distance <= C.PARKED_POSITION + 7;
      const idleAfterClear = !role.firstOpen && this.cyclist.distance > C.PARKED_POSITION + 7;
      this.recordStep(dt, idleAfterClear ? 0 : 1, waiting, true);
      if (door.angle > 0 && this.predictPassengerConflict()) {
        this.freeze('passenger');
        return;
      }
      if (role.firstOpen && door.cycleComplete) this.resolveRole();
    }

    predictPassengerConflict() {
      const door = Object.assign({}, this.door);
      let cyclistDistance = this.cyclist.distance;
      const velocity = this.cyclist.speed / 3.6;
      for (let time = 0; time < 1.2 - 0.000001; time += 0.025) {
        updateDoor(door, 0.025);
        cyclistDistance += velocity * 0.025;
        if (doorContact(door, this.cyclist.x, cyclistDistance)) return true;
      }
      return false;
    }

    maybeTriggerDoor() {
      const role = this.currentEvent;
      if (role.doorTriggered) return;
      const actorDistance = this.currentRole === 'driver' ? this.cyclist.distance : this.distance;
      const remaining = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - actorDistance;
      if (this.roleTime >= this.plan.doorDelay || remaining <= 22) {
        role.doorTriggered = true;
        triggerDoor(this.door, this.plan.doorHold, true);
      }
    }

    stepCyclist(input, dt) {
      const role = this.currentEvent;
      this.maybeTriggerDoor();
      this.movePlayer(input, dt, true);
      this.traffic.distance += this.traffic.speed / 3.6 * dt;
      updateDoor(this.door, dt);
      const remaining = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - this.distance;
      if (!role.earlySlow && remaining <= 40 && this.speed <= 18) role.earlySlow = true;
      if (!role.lateSlow && remaining <= 22 && this.speed <= 18) role.lateSlow = true;
      if (!this.door.cycleComplete && remaining > 3 && remaining < 32 && this.speed < 1.2) {
        role.necessaryStop = true;
      }
      const exempt = Scoring.isYieldExempt(this);
      let quality = 0;
      if (this.speed >= 14 && this.speed <= 30) quality = 1;
      else if (this.speed >= 8 && this.speed < 14) quality = (this.speed - 8) / 6;
      else if (this.speed > 30 && this.speed < 36) quality = (36 - this.speed) / 6;
      this.recordStep(dt, quality, exempt, exempt && input.brake);
      const conflict = this.predictCyclistConflict(input);
      if (conflict) {
        this.freeze(conflict);
        return;
      }
      if (this.distance >= C.PARKED_POSITION + C.DOOR_HINGE_OFFSET && !role.failed) {
        role.safePass = this.door.cycleComplete || this.x < C.DOOR_HINGE_X - C.DOOR_LENGTH_PX - 10;
      }
      if (this.door.cycleComplete && this.distance >= C.PARKED_POSITION + C.CYCLIST_FINISH_GAP) {
        this.resolveRole();
      }
    }

    predictCyclistConflict(input) {
      const door = Object.assign({}, this.door);
      let distance = this.distance;
      let velocity = this.speed / 3.6;
      let x = this.x;
      let trafficDistance = this.traffic.distance;
      const trafficVelocity = this.traffic.speed / 3.6;
      const acceleration = input.brake ? -this.brakingRate(true) :
        (input.throttle ? C.CYCLIST_ACCELERATION : -C.NATURAL_DECELERATION);
      for (let time = 0; time < 1.2 - 0.000001; time += 0.025) {
        const next = M.clamp(velocity + acceleration * 0.025, 0, C.CYCLIST_MAX_SPEED / 3.6);
        distance += (velocity + next) * 0.5 * 0.025;
        velocity = next;
        const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        if (velocity > 0.14) x = M.clamp(x + steering * C.STEER_SPEED * 0.025, C.BIKE_MIN_X, C.BIKE_MAX_X);
        trafficDistance += trafficVelocity * 0.025;
        updateDoor(door, 0.025);
        if (doorContact(door, x, distance)) return 'cyclistDoor';
        if (carBikeContact(this.traffic.x, trafficDistance, x, distance)) return 'cyclistTraffic';
        if (velocity <= 0 && !input.throttle) break;
      }
      return null;
    }

    driverCyclistTarget() {
      if (!this.door.hasOpened || this.door.cycleComplete) return this.plan.driverCyclistSpeed;
      const remaining = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - this.cyclist.distance;
      return remaining < 28 ? 0 : this.plan.driverCyclistSpeed;
    }

    stepDriver(input, dt) {
      const role = this.currentEvent;
      this.maybeTriggerDoor();
      const gapBefore = this.cyclist.distance - this.distance;
      if (!this.door.hasOpened && this.roleTime >= 0.8 && gapBefore >= 20 && this.speed <= 30) {
        role.earlyGap = true;
      }
      if (this.door.hasOpened && !this.door.cycleComplete && this.plan.cyclistAvoids &&
        gapBefore > 20 && this.speed < 25) {
        role.aiTargetX = C.BIKE_AVOID_X;
      } else {
        role.aiTargetX = C.BIKE_X;
      }
      const cyclistTarget = this.driverCyclistTarget();
      const cyclistVelocity = M.moveToward(this.cyclist.speed, cyclistTarget,
        (cyclistTarget < this.cyclist.speed ? 4 : 2.5) * dt);
      this.cyclist.speed = cyclistVelocity;
      this.cyclist.distance += cyclistVelocity / 3.6 * dt;
      if (this.cyclist.speed > 0.5) {
        this.cyclist.x = M.moveToward(this.cyclist.x, role.aiTargetX, 16 * dt);
      }
      updateDoor(this.door, dt);
      this.movePlayer(input, dt, false);
      const gap = this.cyclist.distance - this.distance;
      const nearCyclist = Math.abs(gap) < 4.5;
      const closeLaterally = Math.abs(this.x - this.cyclist.x) < 38;
      if (nearCyclist && (closeLaterally || this.speed > 32)) {
        if (!role.closePassActive) {
          role.closePasses += 1;
          role.closePassActive = true;
        }
      } else if (!nearCyclist) {
        role.closePassActive = false;
      }
      const exempt = Scoring.isYieldExempt(this);
      let quality = Game.Scoring.speedQuality(this.speed, false);
      this.recordStep(dt, quality, exempt, exempt && input.brake);
      if (this.predictDriverConflict(input)) {
        this.freeze('driver');
        return;
      }
      if (this.door.cycleComplete && this.distance >= C.PARKED_POSITION + C.DRIVER_FINISH_GAP) {
        this.resolveRole();
      }
    }

    predictDriverConflict(input) {
      let distance = this.distance;
      let velocity = this.speed / 3.6;
      let x = this.x;
      let cyclistDistance = this.cyclist.distance;
      let cyclistSpeed = this.cyclist.speed;
      let cyclistX = this.cyclist.x;
      const acceleration = input.brake ? -this.brakingRate(false) :
        (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
      const target = this.driverCyclistTarget();
      for (let time = 0; time < 1.2 - 0.000001; time += 0.025) {
        const next = M.clamp(velocity + acceleration * 0.025, 0, C.MAX_SPEED / 3.6);
        distance += (velocity + next) * 0.5 * 0.025;
        velocity = next;
        const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        if (velocity > 0.14) x = M.clamp(x + steering * C.STEER_SPEED * 0.025, C.DRIVER_MIN_X, C.DRIVER_MAX_X);
        cyclistSpeed = M.moveToward(cyclistSpeed, target, (target < cyclistSpeed ? 4 : 2.5) * 0.025);
        cyclistDistance += cyclistSpeed / 3.6 * 0.025;
        if (cyclistSpeed > 0.14) cyclistX = M.moveToward(cyclistX, this.currentEvent.aiTargetX, 16 * 0.025);
        if (carBikeContact(x, distance, cyclistX, cyclistDistance)) return true;
        if (velocity <= 0 && !input.throttle) break;
      }
      return false;
    }

    freeze(reason) {
      const role = this.currentEvent;
      role.failed = true;
      role.attempts += 1;
      this.retryCount += 1;
      this.status = 'frozen';
      this.freezeInfo = {
        eventId: role.id,
        role: role.role,
        reason: reason,
        speed: this.speed,
        distance: Math.max(0, C.PARKED_POSITION - this.distance)
      };
    }

    resolveRole() {
      const role = this.currentEvent;
      if (role.role === 'passenger') {
        role.observation = (role.lookedBeforeOpen ? 4 : 0) +
          (role.openedAfterCrack ? 3 : 0) + (role.waitedForClear ? 3 : 0);
        role.earlySlow = role.lookedBeforeOpen;
      } else if (role.role === 'cyclist') {
        role.observation = (role.earlySlow ? 5 : (role.lateSlow ? 2 : 0)) +
          (role.necessaryStop || role.safePass ? 5 : 0);
      } else {
        role.observation = (role.earlyGap ? 5 : 0) + (role.closePasses === 0 ? 5 : 0);
        role.earlySlow = role.earlyGap;
      }
      role.resolved = true;
      if (this.roleIndex < C.ROLE_ORDER.length - 1) {
        this.setupRole(this.roleIndex + 1);
      } else {
        this.speed = 0;
        this.status = 'complete';
      }
      this.justResolved = role;
    }

    retryEvent() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.demoEventId != null ? this.demoEventId : this.roleIndex);
      this.setupRole(eventId);
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
        demo.events[index].observation = this.events[index].observation;
      }
      demo.setupRole(eventId);
      demo.elapsed = this.elapsed;
      demo.status = 'driving';
      this.demo = demo;
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.status = 'demonstrating';
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      const event = this.demo.events[this.demoEventId];
      this.demo.step(defensiveInput(this.demo), dt);
      if (event.resolved || this.demo.status === 'frozen' || this.demo.status === 'timeout' || this.demoTime >= 45) {
        this.retryEvent();
      }
    }
  }

  function defensiveInput(simulation) {
    const role = simulation.currentEvent;
    if (!role) return {};
    if (role.role === 'passenger') {
      if (!role.firstOpen && simulation.cyclist.distance <= C.PARKED_POSITION + 7) {
        return { left: true, brake: false, throttle: false, right: false };
      }
      if (simulation.door.state === 'closed' && !role.firstOpen) {
        return { left: true, brake: true, throttle: false, right: false };
      }
      if (simulation.door.state === 'cracked') {
        return { left: true, brake: false, throttle: true, right: false };
      }
      return { left: true, brake: false, throttle: false, right: false };
    }
    if (role.role === 'cyclist') {
      const remaining = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - simulation.distance;
      let target = 28;
      if (!simulation.door.cycleComplete && remaining < 48) target = 16;
      if (!simulation.door.cycleComplete && remaining < 30) target = 0;
      return {
        throttle: simulation.speed < target - 0.5,
        brake: simulation.speed > target + 0.5,
        left: false,
        right: false
      };
    }
    const gap = simulation.cyclist.distance - simulation.distance;
    let target = 42;
    if (C.PARKED_POSITION - simulation.distance < 65) target = 25;
    if (gap < 30) target = Math.min(target, 24);
    if (gap < 23) target = Math.min(target, simulation.cyclist.speed);
    if (gap < 14) target = 0;
    return {
      throttle: simulation.speed < target - 0.5,
      brake: simulation.speed > target + 0.5,
      left: false,
      right: false
    };
  }

  const Scoring = {
    isYieldExempt: function (simulation) {
      const role = simulation.currentEvent;
      if (!role || role.resolved) return false;
      if (role.role === 'passenger') {
        return !role.firstOpen && simulation.cyclist.distance <= C.PARKED_POSITION + 7;
      }
      if (role.role === 'cyclist') {
        const remaining = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - simulation.distance;
        return !simulation.door.cycleComplete && remaining > 3 && remaining < 32 && simulation.speed < 1.2;
      }
      const gap = simulation.cyclist.distance - simulation.distance;
      const following = gap > 5 && gap < 28 && simulation.speed <= simulation.cyclist.speed + 2;
      const waiting = !simulation.door.cycleComplete && gap > 5 && gap < 32 && simulation.speed < 1.2;
      return following || waiting;
    },

    summarize: function (simulation, timedOut) {
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(function (event) { return !event.failed; });
      const closePasses = simulation.events.reduce(function (sum, event) { return sum + event.closePasses; }, 0);
      const safety = Math.max(0, Math.round(clean.length * 40 / 3) - closePasses * 6);
      const observation = resolved.reduce(function (sum, event) { return sum + event.observation; }, 0);
      const state = simulation.scoring;
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
        summaryKey = 'scene.dooring.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.dooring.result.advice.default';
      if (failed) adviceKey = 'scene.dooring.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.dooring.result.advice.observation';
      else if (state.hardBrakes > 0) adviceKey = 'result.advice.braking';
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
        earlySlowCount: simulation.events.filter(function (event) { return event.earlySlow; }).length,
        passedCount: resolved.filter(function (event) { return !event.failed && event.closePasses === 0; }).length,
        closePasses: closePasses,
        timedOut: Boolean(timedOut),
        failed: failed,
        adviceKey: adviceKey
      };
    }
  };

  function worldY(simulation, worldPosition) {
    return Draw.worldY(C, simulation, worldPosition);
  }

  function drawCyclist(ctx, x, y, color, demo) {
    Draw.rect(ctx, '#14232b', x - 2, y - 13, 4, 26);
    Draw.rect(ctx, '#14232b', x - 9, y - 10, 18, 3);
    Draw.rect(ctx, '#14232b', x - 7, y + 8, 14, 3);
    Draw.rect(ctx, color || '#66c7d9', x - 4, y - 4, 8, 11);
    Draw.rect(ctx, demo ? '#b8f4d4' : '#efb489', x - 3, y - 10, 6, 6);
    Draw.rect(ctx, '#d8e1d5', x - 1, y - 15, 2, 7);
  }

  function drawDoor(ctx, simulation, door, demo) {
    if (!door || door.angle <= 0.001) return;
    const segment = doorSegment(door);
    const startY = worldY(simulation, segment.start.y / C.PIXELS_PER_METER);
    const endY = worldY(simulation, segment.end.y / C.PIXELS_PER_METER);
    ctx.save();
    ctx.strokeStyle = demo ? '#80e0b1' : '#f4d35e';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(segment.start.x, startY);
    ctx.lineTo(segment.end.x, endY);
    ctx.stroke();
    ctx.restore();
  }

  function drawScene(ctx, simulation, demo) {
    Draw.drawEnvironment(ctx, simulation, C, 174);
    const parkedY = worldY(simulation, C.PARKED_POSITION);
    Draw.rect(ctx, '#d8d6bd55', 226, parkedY - 30, 60, 2);
    Draw.rect(ctx, '#d8d6bd55', 226, parkedY + 30, 60, 2);
    if (simulation.currentRole !== 'passenger' && !simulation.door.cycleComplete) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      Draw.rect(ctx, '#ffd166', 180, parkedY - 25, 54, 52);
      ctx.restore();
    }
    if (simulation.traffic) {
      Draw.drawCar(ctx, simulation.traffic.x, worldY(simulation, simulation.traffic.distance), '#8095a8', false);
    }
    if (simulation.cyclist) {
      drawCyclist(ctx, simulation.cyclist.x, worldY(simulation, simulation.cyclist.distance),
        demo ? '#80e0b1' : simulation.plan.coatColor, demo);
    }
    Draw.drawCar(ctx, C.PARKED_X, parkedY, demo ? '#65d6a1' : simulation.plan.parkedColor, demo);
    if (!simulation.door.cycleComplete) {
      Draw.rect(ctx, '#efb489', C.PARKED_X - 8, parkedY - 7, 5, 5);
    }
    drawDoor(ctx, simulation, simulation.door, demo);
    if (simulation.currentRole === 'cyclist') {
      drawCyclist(ctx, simulation.x, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    } else if (simulation.currentRole === 'driver') {
      Draw.drawCar(ctx, simulation.x, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    } else if (simulation.currentEvent && simulation.currentEvent.lookDuration > 0 && simulation.status === 'driving') {
      Draw.rect(ctx, '#142a34dd', 94, 548, 150, 26);
      Draw.fillFittedText(ctx, t('scene.dooring.canvas.looking'), 102, 565, 134, 10, 'sans-serif');
    }
    if (simulation.status === 'frozen') {
      Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
      Draw.rect(ctx, '#fff0b0', C.WIDTH / 2 - 12, C.CAR_Y - 42, 24, 26);
      ctx.fillStyle = '#3b2a0e';
      ctx.font = 'bold 18px monospace';
      ctx.fillText('!', C.WIDTH / 2 - 5, C.CAR_Y - 23);
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        drawScene(ctx, simulation.demo, true);
      } else {
        drawScene(ctx, simulation, false);
      }
    }
  };

  function standardControls() {
    return {
      left: { label: t('game.leftShort'), aria: t('game.left'), icon: '←', hidden: false },
      right: { label: t('game.rightShort'), aria: t('game.right'), icon: '→', hidden: false },
      throttle: { label: t('game.accelerate'), aria: t('game.accelerate'), icon: '▲', hidden: false },
      brake: { label: t('game.brake'), aria: t('game.brake'), icon: '▼', hidden: false }
    };
  }

  Scenes['dooring'] = {
    id: 'dooring',
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    Constants: C,
    Geometry: {
      doorSegment: doorSegment,
      pointSegmentDistance: pointSegmentDistance,
      doorContact: doorContact,
      carBikeContact: carBikeContact,
      updateDoor: updateDoor,
      triggerDoor: triggerDoor
    },
    createPlan: createPlan,
    defensiveInput: defensiveInput,
    ui: {
      progress: function (simulation) {
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.dooring.hud.progress.' + simulation.currentRole, { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && !event.failed && event.closePasses === 0; }).length
        ];
      },
      controls: function (simulation) {
        if (simulation.currentRole !== 'passenger') return standardControls();
        return {
          left: { label: t('scene.dooring.control.look'), aria: t('scene.dooring.control.lookAria'), icon: '◉', hidden: false },
          right: { label: '', aria: '', icon: '', hidden: true },
          throttle: { label: t('scene.dooring.control.open'), aria: t('scene.dooring.control.openAria'), icon: '↗', hidden: false },
          brake: { label: t('scene.dooring.control.crack'), aria: t('scene.dooring.control.crackAria'), icon: '▱', hidden: false }
        };
      },
      coach: function (simulation, displaySpeed) {
        if (simulation.status === 'demonstrating' && simulation.demo) simulation = simulation.demo;
        const role = simulation.currentEvent;
        let key = 'scene.dooring.hud.passenger.look';
        let status = 'scene.dooring.hud.parked';
        let tone = '';
        let coachTone = 'risk';
        if (role.role === 'passenger') {
          if (simulation.door.state !== 'closed' || role.firstOpen) key = 'scene.dooring.hud.passenger.door';
          else if (simulation.cyclist.distance > C.PARKED_POSITION + 7) key = 'scene.dooring.hud.passenger.clear';
          else if (role.lookDuration >= 0.45) key = 'scene.dooring.hud.passenger.wait';
        } else if (role.role === 'cyclist') {
          status = displaySpeed < 1 ? 'hud.yielding' : (displaySpeed <= 18 ? 'hud.defensive' : 'hud.tooFast');
          tone = displaySpeed > 18 ? 'warn' : '';
          if (simulation.door.cycleComplete) key = 'scene.dooring.hud.cyclist.clear';
          else if (simulation.door.hasOpened) key = 'scene.dooring.hud.cyclist.door';
          else key = 'scene.dooring.hud.cyclist.approach';
        } else {
          status = displaySpeed < 1 ? 'hud.yielding' : (displaySpeed <= 28 ? 'hud.defensive' : 'hud.tooFast');
          tone = displaySpeed > 32 ? 'warn' : '';
          if (simulation.door.cycleComplete) key = 'scene.dooring.hud.driver.clear';
          else if (simulation.door.hasOpened) key = 'scene.dooring.hud.driver.door';
          else key = 'scene.dooring.hud.driver.approach';
        }
        return { text: t(key), status: t(status), tone: tone, coachTone: coachTone };
      },
      eventToast: function (event) {
        return { key: 'scene.dooring.toast.' + event.role, params: { score: event.observation }, neutral: false };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.dooring.failure.' + info.reason, { speed: Math.round(info.speed) });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const role = demo.currentRole;
        let key = 'scene.dooring.demo.' + role;
        if (role === 'passenger' && demo.currentEvent.firstOpen) key = 'scene.dooring.demo.passengerOpen';
        if (role === 'cyclist' && demo.door.cycleComplete) key = 'scene.dooring.demo.cyclistPass';
        if (role === 'driver' && demo.door.cycleComplete) key = 'scene.dooring.demo.driverPass';
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
