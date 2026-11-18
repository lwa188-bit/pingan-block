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
    START_X: 154,
    START_Y: 540,
    STOP_REAR_Y: 400,
    WHEELBASE: 42,
    WHEELBASE_METERS: 6.2,
    TRUCK_WIDTH: 24,
    FRONT_OVERHANG: 12,
    REAR_OVERHANG: 10,
    MAX_STEER: 32 * Math.PI / 180,
    STEER_RATE: 30 * Math.PI / 180,
    MAX_SPEED: 42,
    ACCELERATION: 7,
    BRAKE_DECELERATION: 9,
    NATURAL_DECELERATION: 2,
    PIXELS_PER_KMH: 2,
    APPROACH_STEER_SPEED: 12,
    MAX_TIME: 105,
    SCAN_DWELL: 0.25,
    PREDICTION_STEP: 0.025,
    PREDICTION_HORIZON: 0.35
  });
  const VIEWS = ['front', 'window', 'mirror'];

  function localPoint(truck, forward, lateral) {
    const cos = Math.cos(truck.heading);
    const sin = Math.sin(truck.heading);
    return {
      x: truck.x + cos * forward - sin * lateral,
      y: truck.y + sin * forward + cos * lateral
    };
  }

  function localCoordinates(truck, point) {
    const dx = point.x - truck.x;
    const dy = point.y - truck.y;
    return {
      forward: dx * Math.cos(truck.heading) + dy * Math.sin(truck.heading),
      lateral: -dx * Math.sin(truck.heading) + dy * Math.cos(truck.heading)
    };
  }

  function bodyPolygon(truck) {
    return [
      localPoint(truck, -C.REAR_OVERHANG, -C.TRUCK_WIDTH / 2),
      localPoint(truck, C.WHEELBASE + C.FRONT_OVERHANG, -C.TRUCK_WIDTH / 2),
      localPoint(truck, C.WHEELBASE + C.FRONT_OVERHANG, C.TRUCK_WIDTH / 2),
      localPoint(truck, -C.REAR_OVERHANG, C.TRUCK_WIDTH / 2)
    ];
  }

  function actorClearance(truck, actor) {
    const point = localCoordinates(truck, actor);
    const closestForward = M.clamp(point.forward, -C.REAR_OVERHANG, C.WHEELBASE + C.FRONT_OVERHANG);
    const closestLateral = M.clamp(point.lateral, -C.TRUCK_WIDTH / 2, C.TRUCK_WIDTH / 2);
    return Math.hypot(point.forward - closestForward, point.lateral - closestLateral) - actor.radius;
  }

  function advanceTruck(truck, input, dt, turning) {
    input = input || {};
    const previousSteer = truck.steer;
    if (turning) {
      const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      if (steering) truck.steer += steering * C.STEER_RATE * dt;
      else truck.steer = M.moveToward(truck.steer, 0, 1.2 * Math.PI / 180 * dt);
      truck.steer = M.clamp(truck.steer, -C.MAX_STEER, C.MAX_STEER);
    } else {
      const lateral = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      truck.x = M.clamp(truck.x + lateral * C.APPROACH_STEER_SPEED * dt,
        C.START_X - 13, C.START_X + 13);
      truck.steer = 0;
    }
    if (input.brake) truck.speed = Math.max(0, truck.speed - C.BRAKE_DECELERATION * dt);
    else if (input.throttle) truck.speed = Math.min(C.MAX_SPEED, truck.speed + C.ACCELERATION * dt);
    else truck.speed = Math.max(0, truck.speed - C.NATURAL_DECELERATION * dt);
    const velocity = truck.speed * C.PIXELS_PER_KMH;
    if (turning) truck.heading += velocity / C.WHEELBASE * Math.tan(truck.steer) * dt;
    truck.x += Math.cos(truck.heading) * velocity * dt;
    truck.y += Math.sin(truck.heading) * velocity * dt;
    return previousSteer;
  }

  function innerWheelOffset(steer) {
    const magnitude = Math.abs(steer);
    if (magnitude < 0.005) return 0;
    const rearRadius = C.WHEELBASE_METERS / Math.tan(magnitude);
    return Math.sqrt(rearRadius * rearRadius + C.WHEELBASE_METERS * C.WHEELBASE_METERS) - rearRadius;
  }

  function projectSweep(truck, duration) {
    const copy = Object.assign({}, truck);
    if (copy.speed < 6) copy.speed = 6;
    const outer = [];
    const inner = [];
    const steps = Math.ceil((duration || 1.4) / 0.05);
    for (let index = 0; index <= steps; index += 1) {
      outer.push(localPoint(copy, C.WHEELBASE, -C.TRUCK_WIDTH / 2));
      inner.push(localPoint(copy, 0, C.TRUCK_WIDTH / 2));
      advanceTruck(copy, {}, 0.05, true);
    }
    return { outer: outer, inner: inner };
  }

  const Geometry = {
    localPoint: localPoint,
    localCoordinates: localCoordinates,
    bodyPolygon: bodyPolygon,
    actorClearance: actorClearance,
    advanceTruck: advanceTruck,
    innerWheelOffset: innerWheelOffset,
    projectSweep: projectSweep
  };

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed('truck-inner-wheel:' + seed));
    const pedestrianDirection = random() < 0.5 ? 1 : -1;
    const colors = ['#f4d35e', '#ee6c72', '#7fd1ed'];
    return Object.freeze({ events: Object.freeze([
      Object.freeze({
        id: 0, kind: 'pedestrian', direction: pedestrianDirection,
        x: pedestrianDirection > 0 ? 66 : 294, y: 310,
        speed: 19 + random() * 4, radius: 5,
        coatColor: colors[Math.floor(random() * colors.length)],
        skinColor: random() < 0.5 ? '#efb489' : '#c88760'
      }),
      Object.freeze({
        id: 1, kind: 'ebike', direction: -1,
        x: 196 + random() * 5, y: 500 + random() * 18,
        speed: 22 + random() * 4, radius: 6,
        coatColor: colors[Math.floor(random() * colors.length)],
        skinColor: random() < 0.5 ? '#efb489' : '#c88760'
      }),
      Object.freeze({
        id: 2, kind: 'cyclist', direction: -1,
        x: 196 + random() * 4, y: 448 + random() * 20,
        speed: 17 + random() * 3, radius: 6,
        coatColor: colors[Math.floor(random() * colors.length)],
        skinColor: random() < 0.5 ? '#efb489' : '#c88760'
      })
    ]) });
  }

  function createRuntimeEvent(plan) {
    return {
      id: plan.id,
      kind: plan.kind,
      actor: Object.assign({}, plan, {
        baseSpeed: plan.speed,
        waiting: false,
        cleared: false
      }),
      resolved: false,
      failed: false,
      attempts: 0,
      turning: false,
      initialObserved: false,
      rechecked: false,
      clearConfirmed: false,
      clearDwell: 0,
      scanView: null,
      scanStreak: 0,
      observedViews: { front: 0, window: 0, mirror: 0 },
      stoppedForActor: false,
      waitedUntilClear: false,
      earlyStart: false,
      unsafePass: false,
      minimumClearance: Infinity,
      rushAcceleration: false,
      rushedSteering: false,
      observation: 0,
      earlySlow: false
    };
  }

  function resetEventRuntime(event, plan) {
    const preserved = {
      resolved: event.resolved,
      failed: event.failed,
      attempts: event.attempts
    };
    Object.assign(event, createRuntimeEvent(plan), preserved);
  }

  function relevantView(event) {
    return event.kind === 'pedestrian' ? 'front' : 'right';
  }

  function actorCleared(event) {
    const actor = event.actor;
    if (event.kind === 'pedestrian') return actor.direction > 0 ? actor.x > 278 : actor.x < 108;
    return actor.y < 220;
  }

  function advanceActor(actor, truck, dt) {
    if (actor.cleared) return;
    const clearance = actorClearance(truck, actor);
    if (actor.waiting) {
      if (clearance > 22) actor.waiting = false;
      else return;
    }
    if (truck.speed < 0.45 && clearance < 13) {
      actor.waiting = true;
      actor.speed = 0;
      return;
    }
    actor.speed = actor.baseSpeed;
    if (actor.kind === 'pedestrian') actor.x += actor.direction * actor.speed * dt;
    else actor.y += actor.direction * actor.speed * dt;
  }

  function eyeFor(truck, view) {
    if (view === 'window') return localPoint(truck, 32, 14);
    if (view === 'mirror') return localPoint(truck, 43, 17);
    return localPoint(truck, 47, 0);
  }

  function coneFor(truck, view) {
    const eye = eyeFor(truck, view);
    const direction = truck.heading + (view === 'window' ? 80 : (view === 'mirror' ? 140 : 0)) * Math.PI / 180;
    return {
      x: eye.x, y: eye.y,
      dx: Math.cos(direction), dy: Math.sin(direction),
      cos: Math.cos((view === 'front' ? 50 : (view === 'window' ? 55 : 43)) * Math.PI / 180),
      range: view === 'front' ? 245 : 205
    };
  }

  const BUILDINGS = [{ x: 264, y: 146, w: 86, h: 82 }];

  function pointInBuilding(point) {
    return BUILDINGS.some(function (building) {
      return point.x > building.x && point.x < building.x + building.w &&
        point.y > building.y && point.y < building.y + building.h;
    });
  }

  function pointInCargo(truck, point) {
    const local = localCoordinates(truck, point);
    return local.forward > -8 && local.forward < 24 && Math.abs(local.lateral) < C.TRUCK_WIDTH / 2;
  }

  function visibilityFor(simulation, event, view) {
    const actor = event.actor;
    if (!actor || actor.cleared) return false;
    view = view || simulation.view;
    const cone = coneFor(simulation.truck, view);
    const dx = actor.x - cone.x;
    const dy = actor.y - cone.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.001 || distance > cone.range) return false;
    if ((dx * cone.dx + dy * cone.dy) / distance < cone.cos) return false;
    for (let index = 2; index < 28; index += 1) {
      const ratio = index / 28;
      const point = { x: cone.x + dx * ratio, y: cone.y + dy * ratio };
      if (pointInBuilding(point)) return false;
      if (view !== 'mirror' && pointInCargo(simulation.truck, point)) return false;
    }
    return true;
  }

  function cloneTruck(simulation) {
    return Object.assign({}, simulation.truck);
  }

  function predictConflict(simulation, input) {
    const event = simulation.currentEvent;
    if (!event || event.actor.cleared) return null;
    const truck = cloneTruck(simulation);
    const actor = Object.assign({}, event.actor);
    const steps = Math.ceil(C.PREDICTION_HORIZON / C.PREDICTION_STEP);
    for (let index = 0; index < steps; index += 1) {
      advanceTruck(truck, input, C.PREDICTION_STEP, event.turning);
      advanceActor(actor, truck, C.PREDICTION_STEP);
      if (actorClearance(truck, actor) <= 0) {
        return { eventId: event.id, time: (index + 1) * C.PREDICTION_STEP, kind: event.kind };
      }
    }
    return null;
  }

  class Simulation {
    constructor(seed, options) {
      options = options || {};
      this.seed = seed;
      this.plan = createPlan(seed);
      this.events = this.plan.events.map(createRuntimeEvent);
      this.eventIndex = options.eventId || 0;
      for (let index = 0; index < this.eventIndex; index += 1) this.events[index].resolved = true;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.scoring.steeringPenalties = 0;
      this.view = 'front';
      this.speed = 0;
      this.previousSpeed = 0;
      this.lastDeceleration = 0;
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.truck = null;
      this.resetTruck();
    }

    get currentEvent() {
      const event = this.events[this.eventIndex];
      return event && !event.resolved ? event : null;
    }

    get phase() {
      const event = this.currentEvent;
      return event && event.turning ? 'turning' : 'approach';
    }

    resetTruck() {
      this.truck = {
        x: C.START_X, y: C.START_Y, heading: -Math.PI / 2,
        steer: 0, speed: 0
      };
      this.speed = 0;
      this.previousSpeed = 0;
      this.lastDeceleration = 0;
      this.view = 'front';
    }

    start() {
      this.status = 'driving';
    }

    setView(view) {
      if (VIEWS.includes(view)) this.view = view;
    }

    updateObservation(dt) {
      const event = this.currentEvent;
      if (!event) return;
      const visible = visibilityFor(this, event, this.view);
      if (visible && event.scanView === this.view) event.scanStreak += dt;
      else {
        event.scanView = visible ? this.view : null;
        event.scanStreak = visible ? dt : 0;
      }
      if (visible) event.observedViews[this.view] += dt;
      const accepted = event.kind === 'pedestrian' ? this.view === 'front' : this.view !== 'front';
      if (visible && accepted && event.scanStreak >= C.SCAN_DWELL) {
        if (!event.initialObserved) event.initialObserved = true;
        else if (this.truck.y < 430) event.rechecked = true;
      }
      if (event.actor.cleared && this.truck.y < 430 && this.speed < 1.5) {
        const correctView = relevantView(event) === 'front' ? this.view === 'front' : this.view !== 'front';
        event.clearDwell = correctView ? event.clearDwell + dt : 0;
        if (event.clearDwell >= C.SCAN_DWELL) event.clearConfirmed = true;
      } else if (!event.actor.cleared) event.clearDwell = 0;
    }

    freeze(reason, prediction) {
      if (this.status !== 'driving') return;
      const event = this.currentEvent;
      if (event) {
        event.failed = true;
        event.attempts += 1;
      }
      this.freezeInfo = {
        eventId: event ? event.id : this.eventIndex,
        reason: reason,
        speed: this.speed,
        prediction: prediction || null,
        observed: event ? event.initialObserved : false,
        rechecked: event ? event.rechecked : false,
        rushed: event ? event.rushAcceleration : false
      };
      this.status = 'frozen';
    }

    resolveEvent() {
      const event = this.currentEvent;
      if (!event) return;
      event.observation = (event.initialObserved ? 4 : 0) + (event.rechecked ? 3 : 0) +
        (event.clearConfirmed && !event.earlyStart ? 3 : 0);
      event.earlySlow = event.initialObserved;
      event.resolved = true;
      this.justResolved = event;
      if (this.eventIndex === this.events.length - 1) {
        this.truck.speed = 0;
        this.speed = 0;
        this.status = 'complete';
        return;
      }
      this.eventIndex += 1;
      this.resetTruck();
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      if (dt <= 0) return;
      input = input || {};
      const event = this.currentEvent;
      if (!event) return;
      this.justHardBrake = false;
      this.justResolved = null;
      this.elapsed += dt;
      this.previousSpeed = this.speed;

      const prediction = predictConflict(this, input);
      if (prediction) {
        const avoidance = predictConflict(this, { brake: true, left: input.left, right: input.right });
        if (prediction.time <= 0.075 || avoidance) {
          const reason = event.rushAcceleration ? 'rush' :
            (event.kind === 'cyclist' ? 'innerWheel' :
              (!event.initialObserved ? 'unobserved' : (event.kind === 'pedestrian' ? 'pedestrian' : 'rightTraffic')));
          this.freeze(reason, prediction);
          return;
        }
      }

      if (!event.turning && this.truck.y <= C.STOP_REAR_Y) event.turning = true;
      const previousSteer = this.truck.steer;
      advanceTruck(this.truck, input, dt, event.turning);
      this.speed = this.truck.speed;
      this.lastDeceleration = Math.max(0, (this.previousSpeed - this.speed) / dt);
      if (event.turning && input.throttle && this.speed > 13 && this.truck.heading > -1.25) {
        event.rushAcceleration = true;
      }
      if (event.turning && Math.abs(this.truck.steer) > 24 * Math.PI / 180 &&
        Math.abs(previousSteer) <= 24 * Math.PI / 180 && this.speed > 15) {
        event.rushedSteering = true;
        this.scoring.steeringPenalties += 1;
      }

      advanceActor(event.actor, this.truck, dt);
      if (actorCleared(event)) event.actor.cleared = true;
      this.updateObservation(dt);
      const clearance = actorClearance(this.truck, event.actor);
      if (!event.actor.cleared) event.minimumClearance = Math.min(event.minimumClearance, clearance);
      if (!event.actor.cleared && clearance < 2.5 && this.speed > 0.5) event.unsafePass = true;

      if (this.truck.y < 430 && this.truck.y > 365 && this.speed < 0.45 && !event.actor.cleared) {
        event.stoppedForActor = true;
      }
      if (event.actor.cleared && event.stoppedForActor) event.waitedUntilClear = true;
      if (event.turning && Math.abs(this.truck.steer) > 0.05 && !event.actor.cleared) event.earlyStart = true;

      Scoring.recordStep(this.scoring, this, dt);

      if (event.turning && this.truck.y < 192 && this.truck.heading < -0.65) {
        this.freeze('missedTurn');
        return;
      }
      if (event.turning && (this.truck.heading > 0.52 || this.truck.x > 348 || this.truck.y > 590)) {
        this.freeze('oversteer');
        return;
      }
      if (event.turning && this.truck.x > 320 && Math.abs(this.truck.heading) < 0.25) this.resolveEvent();
      if (this.elapsed >= C.MAX_TIME && this.status === 'driving') {
        this.speed = 0;
        this.truck.speed = 0;
        this.status = 'timeout';
      }
    }

    retryEvent() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.demoEventId != null ? this.demoEventId : this.eventIndex);
      this.eventIndex = eventId;
      resetEventRuntime(this.events[eventId], this.plan.events[eventId]);
      this.resetTruck();
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.justResolved = null;
      this.status = 'driving';
    }

    startDemo() {
      if (!this.freezeInfo) return;
      const eventId = this.freezeInfo.eventId;
      const demo = new Simulation(this.seed, { eventId: eventId });
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
    const event = simulation.currentEvent;
    if (!event) return {};
    const truck = simulation.truck;
    const local = localCoordinates(truck, event.actor);
    let view = 'front';
    if (event.kind !== 'pedestrian') view = local.forward > 27 ? 'window' : 'mirror';
    simulation.setView(view);

    let target;
    if (!event.turning) {
      const remaining = truck.y - C.STOP_REAR_Y;
      target = remaining > 95 ? 28 : (remaining > 30 ? 15 : 10);
      if (remaining < 10 && (!event.actor.cleared || !event.clearConfirmed || !event.rechecked)) target = 0;
    } else {
      target = 10;
      if (!event.actor.cleared || !event.clearConfirmed || !event.rechecked) target = 0;
    }

    let desiredSteer = 0;
    if (event.turning && event.actor.cleared && event.clearConfirmed && event.rechecked) {
      desiredSteer = M.clamp((-truck.heading - 0.08) * 1.8, -0.35, C.MAX_STEER);
      if (truck.x > 292) desiredSteer = M.clamp(-truck.heading * 2, -0.35, 0.35);
    }
    return {
      throttle: simulation.speed < target - 0.35,
      brake: simulation.speed > target + 0.35,
      right: truck.steer < desiredSteer - 0.012,
      left: truck.steer > desiredSteer + 0.012
    };
  }

  const Scoring = {
    eventObservation: function (event) {
      return event.observation || ((event.initialObserved ? 4 : 0) + (event.rechecked ? 3 : 0) +
        (event.clearConfirmed && !event.earlyStart ? 3 : 0));
    },

    eventSafe: function (event) {
      return event.resolved && !event.failed && !event.unsafePass;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || simulation.speed >= 0.8) return false;
      if (simulation.truck.y > 435 || simulation.truck.y < 350) return false;
      return !event.actor.cleared || !event.initialObserved || !event.rechecked || !event.clearConfirmed;
    },

    recordStep: function (state, simulation, dt) {
      const event = simulation.currentEvent;
      if (!Scoring.isYieldExempt(simulation)) {
        let low;
        let high;
        if (simulation.phase === 'turning') {
          low = 7;
          high = 12;
        } else if (simulation.truck.y < 490) {
          low = 8;
          high = 15;
        } else {
          low = 23;
          high = 32;
        }
        let quality = 0;
        if (simulation.speed >= low && simulation.speed <= high) quality = 1;
        else if (simulation.speed > 1 && simulation.speed < low) quality = (simulation.speed - 1) / (low - 1);
        else if (simulation.speed > high) quality = Math.max(0, 1 - (simulation.speed - high) / 12);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const necessary = Scoring.isYieldExempt(simulation) || (event && event.initialObserved && simulation.previousSpeed < 16);
      const harsh = !necessary && simulation.lastDeceleration > 8.5 && simulation.previousSpeed > 17;
      if (harsh && state.hardBrakeCooldown <= 0) {
        state.hardBrakeDuration += dt;
        if (state.hardBrakeDuration >= 0.15) {
          state.hardBrakes += 1;
          state.hardBrakeDuration = 0;
          state.hardBrakeCooldown = 1.2;
          simulation.justHardBrake = true;
        }
      } else if (!harsh) state.hardBrakeDuration = 0;
    },

    summarize: function (simulation, timedOut) {
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(Scoring.eventSafe);
      const closePasses = resolved.filter(function (event) { return event.unsafePass; }).length;
      const safety = Math.max(0, Math.round(clean.length * 40 / 3) - closePasses * 4);
      const observation = resolved.reduce(function (sum, event) { return sum + Scoring.eventObservation(event); }, 0);
      const state = simulation.scoring;
      const efficiency = state.efficiencyTime > 0 ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
      const smooth = Math.max(0, 10 - state.hardBrakes * 2 - state.steeringPenalties);
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
        summaryKey = 'scene.truck.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.truck.result.advice.default';
      if (failed) adviceKey = 'scene.truck.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.truck.result.advice.observation';
      else if (state.hardBrakes || state.steeringPenalties) adviceKey = 'scene.truck.result.advice.smooth';
      else if (timedOut || efficiency < 12) adviceKey = 'scene.truck.result.advice.efficiency';
      return {
        total: total, grade: grade, titleKey: titleKey, summaryKey: summaryKey,
        safety: safety, observation: Math.round(observation), efficiency: Math.round(efficiency),
        efficiencyRaw: efficiency, smooth: smooth, hardBrakes: state.hardBrakes,
        earlySlowCount: simulation.events.filter(function (event) { return event.initialObserved; }).length,
        passedCount: clean.length, timedOut: Boolean(timedOut), failed: failed, adviceKey: adviceKey
      };
    }
  };

  function drawEnvironment(ctx) {
    Draw.rect(ctx, '#365647', 0, 0, C.WIDTH, C.HEIGHT);
    Draw.rect(ctx, '#a9aa96', 78, 0, 194, C.HEIGHT);
    Draw.rect(ctx, '#a9aa96', 0, 226, C.WIDTH, 158);
    Draw.rect(ctx, '#3b484b', 88, 0, 174, C.HEIGHT);
    Draw.rect(ctx, '#3b484b', 0, 236, C.WIDTH, 138);
    Draw.rect(ctx, '#526064', 128, 0, 3, 226);
    Draw.rect(ctx, '#526064', 128, 384, 3, 256);
    for (let y = 12; y < C.HEIGHT; y += 38) {
      if (y < 225 || y > 385) Draw.rect(ctx, '#8c9788', 176, y, 3, 17);
    }
    for (let x = 14; x < C.WIDTH; x += 42) Draw.rect(ctx, '#697773', x, 298, 22, 3);
    Draw.rect(ctx, '#d4ceb3', 186, 392, 2, 248);
    Draw.rect(ctx, '#91a18a55', 192, 402, 1, 220);
    Draw.rect(ctx, '#d8e8c8', 119, 360, 66, 3);
    for (let x = 98; x < 260; x += 18) Draw.rect(ctx, '#c5c1aa', x, 290, 10, 42);
    Draw.rect(ctx, '#ffd16622', 190, 234, 72, 140);
    Draw.rect(ctx, '#ffd16688', 190, 234, 2, 140);
    BUILDINGS.forEach(function (building) {
      Draw.rect(ctx, '#263d3c', building.x, building.y, building.w, building.h);
      Draw.rect(ctx, '#4c6a59', building.x + 5, building.y + 5, building.w - 10, 10);
      Draw.rect(ctx, '#26312f', building.x + 12, building.y + 30, 20, 18);
      Draw.rect(ctx, '#26312f', building.x + 48, building.y + 30, 20, 18);
    });
    Draw.fillFittedText(ctx, t('scene.truck.canvas.stop'), 122, 354, 60, 7, 'sans-serif');
    Draw.fillFittedText(ctx, t('scene.truck.canvas.priority'), 204, 266, 72, 7, 'sans-serif');
  }

  function drawSweep(ctx, simulation) {
    const event = simulation.currentEvent;
    if (!event || !event.turning || Math.abs(simulation.truck.steer) < 0.015) return;
    const sweep = projectSweep(simulation.truck, 1.6);
    ctx.save();
    ctx.fillStyle = '#ff7a6622';
    ctx.beginPath();
    sweep.outer.forEach(function (point, index) {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    sweep.inner.slice().reverse().forEach(function (point) { ctx.lineTo(point.x, point.y); });
    ctx.closePath();
    ctx.fill();
    [
      { points: sweep.outer, color: '#ffd166bb' },
      { points: sweep.inner, color: '#ff8b77cc' }
    ].forEach(function (line) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      line.points.forEach(function (point, index) {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawActor(ctx, simulation, event, force) {
    const actor = event.actor;
    if (actor.cleared || (!force && !visibilityFor(simulation, event, simulation.view))) return;
    ctx.save();
    if (actor.kind === 'pedestrian') {
      Draw.drawPedestrian(ctx, C, actor.x, actor.y, actor, false, false);
    } else {
      Draw.rect(ctx, '#14232b', actor.x - 2, actor.y - 10, 4, 22);
      Draw.rect(ctx, '#0e1c22', actor.x - 6, actor.y - 10, 12, 3);
      Draw.rect(ctx, '#0e1c22', actor.x - 6, actor.y + 9, 12, 3);
      Draw.rect(ctx, actor.coatColor, actor.x - 5, actor.y - 3, 10, 9);
      Draw.rect(ctx, actor.skinColor, actor.x - 3, actor.y - 8, 6, 5);
      if (actor.kind === 'ebike') Draw.rect(ctx, '#d8e8c8', actor.x - 1, actor.y - 13, 2, 3);
    }
    ctx.restore();
  }

  function drawTruck(ctx, simulation) {
    const truck = simulation.truck;
    ctx.save();
    ctx.translate(truck.x, truck.y);
    ctx.rotate(truck.heading + Math.PI / 2);
    Draw.rect(ctx, '#0b1a2055', -C.TRUCK_WIDTH / 2 + 4, -C.WHEELBASE - C.FRONT_OVERHANG + 5,
      C.TRUCK_WIDTH, C.WHEELBASE + C.FRONT_OVERHANG + C.REAR_OVERHANG);
    Draw.rect(ctx, '#c5c9b8', -12, -27, 24, 37);
    Draw.rect(ctx, '#8d998b', -9, -23, 2, 29);
    Draw.rect(ctx, '#8d998b', 0, -23, 2, 29);
    Draw.rect(ctx, '#8d998b', 9, -23, 2, 29);
    Draw.rect(ctx, '#d7b957', -12, -54, 24, 26);
    Draw.rect(ctx, '#29474d', -9, -51, 18, 8);
    Draw.rect(ctx, '#79a9ae', -7, -50, 14, 3);
    Draw.rect(ctx, '#fff0b5', -10, -55, 5, 3);
    Draw.rect(ctx, '#fff0b5', 5, -55, 5, 3);
    Draw.rect(ctx, '#d64e48', -10, 7, 5, 3);
    Draw.rect(ctx, '#d64e48', 5, 7, 5, 3);
    Draw.rect(ctx, '#15262e', -15, -3, 3, 12);
    Draw.rect(ctx, '#15262e', 12, -3, 3, 12);
    [-12, 12].forEach(function (x) {
      ctx.save();
      ctx.translate(x, -42);
      ctx.rotate(truck.steer);
      Draw.rect(ctx, '#15262e', -2, -6, 4, 12);
      ctx.restore();
    });
    Draw.rect(ctx, '#80e0b1', 13, -45, 5, 3);
    ctx.restore();

    const offset = innerWheelOffset(truck.steer);
    if (eventIsTurning(simulation) && offset > 0.1) {
      ctx.save();
      ctx.fillStyle = '#ffe2a6';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('scene.truck.canvas.offset', { value: offset.toFixed(1) }),
        M.clamp(truck.x + 40, 65, 290), M.clamp(truck.y + 35, 125, 590));
      ctx.restore();
    }
  }

  function eventIsTurning(simulation) {
    return Boolean(simulation.currentEvent && simulation.currentEvent.turning);
  }

  function drawInset(ctx, simulation) {
    if (simulation.view === 'front') return;
    const event = simulation.currentEvent;
    if (!event) return;
    const box = { x: 194, y: 116, w: 154, h: 132 };
    const cone = coneFor(simulation.truck, simulation.view);
    const center = { x: cone.x + cone.dx * 52, y: cone.y + cone.dy * 52 };
    ctx.save();
    Draw.rect(ctx, '#0c1b24ee', box.x - 3, box.y - 3, box.w + 6, box.h + 25);
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    ctx.scale(1.08, 1.08);
    ctx.translate(-center.x, -center.y);
    drawEnvironment(ctx);
    drawActor(ctx, simulation, event, false);
    drawTruck(ctx, simulation);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#8fd8bd';
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = '#dcebdd';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(t('scene.truck.view.' + simulation.view), box.x + 5, box.y + box.h + 14);
    ctx.textAlign = 'right';
    ctx.fillStyle = visibilityFor(simulation, event, simulation.view) ? '#80e0b1' : '#9bb0b5';
    ctx.fillText(t(visibilityFor(simulation, event, simulation.view) ? 'scene.truck.canvas.visible' : 'scene.truck.canvas.scanning'),
      box.x + box.w - 5, box.y + box.h + 14);
    ctx.restore();
  }

  function drawWorld(ctx, simulation) {
    drawEnvironment(ctx);
    drawSweep(ctx, simulation);
    const event = simulation.currentEvent;
    if (event) drawActor(ctx, simulation, event, simulation.status === 'frozen');
    drawTruck(ctx, simulation);
    drawInset(ctx, simulation);
    if (event && !event.turning) {
      ctx.save();
      ctx.fillStyle = '#dcebdd';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(t('scene.truck.canvas.approach'), 102, 414);
      ctx.restore();
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      drawWorld(ctx, simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation);
    }
  };

  const Scene = {
    id: 'truck-inner-wheel',
    Constants: C,
    Geometry: Geometry,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    createPlan: createPlan,
    defensiveInput: defensiveInput,
    visibilityFor: visibilityFor,
    predictConflict: predictConflict,
    coneFor: coneFor,
    ui: {
      progress: function (simulation) {
        return t('scene.truck.hud.progress', {
          resolved: simulation.events.filter(function (event) { return event.resolved; }).length
        });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.initialObserved; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(Scoring.eventSafe).length
        ];
      },
      coach: function (simulation) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (!event) return { text: t('scene.truck.hud.cruise'), status: t('hud.ready'), coachTone: '', tone: '' };
        if (!event.initialObserved) {
          return {
            text: t(event.kind === 'pedestrian' ? 'scene.truck.hud.lookFront' : 'scene.truck.hud.lookRight'),
            status: t('scene.truck.hud.observing'), coachTone: 'risk', tone: 'warn'
          };
        }
        if (!event.actor.cleared && current.truck.y < 455) {
          return {
            text: t(current.speed < 0.5 ? 'scene.truck.hud.wait' : 'scene.truck.hud.stop'),
            status: t(current.speed < 0.5 ? 'hud.yielding' : 'hud.prepareStop'),
            coachTone: current.speed < 0.5 ? 'good' : 'risk', tone: current.speed < 0.5 ? '' : 'warn'
          };
        }
        if (!event.clearConfirmed && current.truck.y < 440) {
          return { text: t('scene.truck.hud.confirm'), status: t('scene.truck.hud.confirmStatus'), coachTone: 'good', tone: '' };
        }
        if (event.turning) {
          return { text: t('scene.truck.hud.turn'), status: t('scene.truck.hud.turnStatus'), coachTone: 'risk', tone: 'warn' };
        }
        return { text: t('scene.truck.hud.approach'), status: t('scene.truck.hud.approachStatus'), coachTone: '', tone: '' };
      },
      retryToast: function () {
        return { key: 'scene.truck.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return {
          key: score === 10 ? 'scene.truck.toast.safe' : 'scene.truck.toast.improve',
          params: { score: score }, neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.truck.failure.' + info.reason, { speed: info.speed.toFixed(0) });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo && demo.currentEvent;
        if (!event) return { step: '', substep: '' };
        if (!event.initialObserved || !event.rechecked) {
          return { step: t('scene.truck.demo.observe'), substep: t('scene.truck.demo.observeSub') };
        }
        if (!event.actor.cleared || !event.clearConfirmed) {
          return { step: t('scene.truck.demo.wait'), substep: t('scene.truck.demo.waitSub') };
        }
        return { step: t('scene.truck.demo.turn'), substep: t('scene.truck.demo.turnSub') };
      },
      updateControls: function (doc, simulation) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        doc.querySelectorAll('[data-view]').forEach(function (button) {
          const active = button.dataset.view === current.view;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', String(active));
          button.disabled = simulation.status !== 'driving';
        });
      }
    },

    bindControls: function (doc, getSimulation) {
      doc.querySelectorAll('[data-view]').forEach(function (button) {
        button.addEventListener('click', function () { getSimulation().setView(button.dataset.view); });
      });
      doc.addEventListener('keydown', function (event) {
        const index = ['1', '2', '3'].indexOf(event.key);
        if (index >= 0 && getSimulation().status === 'driving') {
          getSimulation().setView(VIEWS[index]);
          event.preventDefault();
        }
      });
    }
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
