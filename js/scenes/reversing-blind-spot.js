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
    CAR_X: 180,
    CAR_START_Y: 218,
    ACTOR_Y: 345,
    REVERSE_DISTANCE: 14,
    REVERSE_SCALE: 10,
    MAX_SPEED: 6,
    START_SPEED: 0,
    MAX_TIME: 115,
    ACCELERATION: 1.4,
    BRAKE_DECELERATION: 3,
    NATURAL_DECELERATION: 0.5,
    STEER_SPEED: 18,
    CAR_MIN_X: 154,
    CAR_MAX_X: 206,
    INSPECTION_DURATION: 3,
    SCAN_DWELL: 0.25,
    STOP_HOLD: 0.25,
    HARD_BRAKE: 2.6,
    HARD_BRAKE_MIN_SPEED: 4.8
  });
  const VIEWS = ['direct', 'camera', 'left', 'right'];

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
    const random = M.mulberry32(M.hashSeed('reversing-blind-spot:' + seed));
    const kinds = shuffle(['child', 'elder', 'cyclist'], random);
    const events = kinds.map(function (kind, id) {
      const direction = random() < 0.5 ? 1 : -1;
      const baseSpeed = kind === 'child' ? 36 : (kind === 'elder' ? 22 : 52);
      return Object.freeze({
        id: id,
        kind: kind,
        direction: direction,
        startX: direction > 0 ? 55 : 305,
        clearX: direction > 0 ? 310 : 50,
        actorY: C.ACTOR_Y + Math.floor(random() * 7) - 3,
        speed: baseSpeed * (0.92 + random() * 0.16),
        activateDistance: kind === 'cyclist' ? 4.2 : 1,
        coatColor: ['#f4d35e', '#ee6c72', '#7fd1ed'][Math.floor(random() * 3)],
        skinColor: random() > 0.5 ? '#efb489' : '#c88760'
      });
    });
    return Object.freeze({ events: Object.freeze(events) });
  }

  function resetRuntime(event) {
    event.resolved = false;
    event.inspected = false;
    event.skippedInspection = false;
    event.scans = { direct: 0, camera: 0, left: 0, right: 0 };
    event.stopDuration = 0;
    event.properStop = false;
    event.waitedUntilClear = false;
    event.earlyStart = false;
    event.unsafePass = false;
    event.pedestrian = {
      active: false,
      cleared: false,
      x: event.startX,
      y: event.actorY,
      direction: event.direction,
      speed: event.speed
    };
  }

  function createRuntimeEvent(plan) {
    const event = Object.assign({}, plan);
    event.failed = false;
    event.attempts = 0;
    resetRuntime(event);
    return event;
  }

  function obstaclesFor(event) {
    if (event.kind === 'child') {
      return [
        { x: 0, y: 245, w: 104, h: 145, type: 'wall' },
        { x: 256, y: 245, w: 104, h: 145, type: 'wall' }
      ];
    }
    if (event.kind === 'elder') {
      return [
        { x: 42, y: 225, w: 94, h: 104, type: 'vehicle' },
        { x: 224, y: 225, w: 94, h: 104, type: 'vehicle' }
      ];
    }
    return [
      { x: 0, y: 238, w: 116, h: 92, type: 'fence' },
      { x: 244, y: 238, w: 116, h: 92, type: 'fence' }
    ];
  }

  function scanComplete(event) {
    return event.scans.left >= C.SCAN_DWELL && event.scans.right >= C.SCAN_DWELL &&
      (event.scans.direct >= C.SCAN_DWELL || event.scans.camera >= C.SCAN_DWELL);
  }

  function inspectionPosition(progress) {
    const points = [
      { x: 144, y: 174 }, { x: 216, y: 174 }, { x: 216, y: 262 },
      { x: 144, y: 262 }, { x: 144, y: 174 }
    ];
    const lengths = points.slice(1).map(function (point, index) {
      const previous = points[index];
      return Math.hypot(point.x - previous.x, point.y - previous.y);
    });
    const total = lengths.reduce(function (sum, length) { return sum + length; }, 0);
    let remaining = M.clamp(progress, 0, 1) * total;
    for (let index = 0; index < lengths.length; index += 1) {
      if (remaining <= lengths[index]) {
        const ratio = lengths[index] ? remaining / lengths[index] : 0;
        return {
          x: M.lerp(points[index].x, points[index + 1].x, ratio),
          y: M.lerp(points[index].y, points[index + 1].y, ratio)
        };
      }
      remaining -= lengths[index];
    }
    return points[0];
  }

  function carY(simulation) {
    return C.CAR_START_Y + simulation.distance * C.REVERSE_SCALE;
  }

  function coneFor(simulation, view) {
    const y = carY(simulation) + 16;
    if (view === 'camera') return { x: simulation.x, y: y, dx: 0, dy: 1, cos: Math.cos(42 * Math.PI / 180), range: 115 };
    if (view === 'left') return { x: simulation.x - 13, y: y - 8, dx: -0.65, dy: 0.76, cos: Math.cos(38 * Math.PI / 180), range: 260 };
    if (view === 'right') return { x: simulation.x + 13, y: y - 8, dx: 0.65, dy: 0.76, cos: Math.cos(38 * Math.PI / 180), range: 260 };
    return { x: simulation.x, y: y, dx: 0, dy: 1, cos: Math.cos(55 * Math.PI / 180), range: 300 };
  }

  function pointInObstacle(x, y, obstacle) {
    return x > obstacle.x && x < obstacle.x + obstacle.w && y > obstacle.y && y < obstacle.y + obstacle.h;
  }

  function visibilityFor(simulation, event, view) {
    const pedestrian = event.pedestrian;
    if (!pedestrian.active || pedestrian.cleared) return false;
    if (simulation.role === 'pedestrian' || simulation.phase === 'walkaround') return true;
    const cone = coneFor(simulation, view || simulation.view);
    const dx = pedestrian.x - cone.x;
    const dy = pedestrian.y - cone.y;
    const length = Math.hypot(dx, dy);
    if (length > cone.range || length < 0.001) return false;
    const norm = Math.hypot(cone.dx, cone.dy);
    const dot = (dx * cone.dx + dy * cone.dy) / (length * norm);
    if (dot < cone.cos) return false;
    const obstacles = obstaclesFor(event);
    for (let step = 2; step < 24; step += 1) {
      const ratio = step / 24;
      const x = cone.x + dx * ratio;
      const y = cone.y + dy * ratio;
      if (obstacles.some(function (obstacle) { return pointInObstacle(x, y, obstacle); })) return false;
    }
    return true;
  }

  function defensiveInput(simulation) {
    if (simulation.phase === 'walkaround') return { throttle: true, brake: false, left: false, right: false };
    const views = ['direct', 'left', 'camera', 'right'];
    simulation.setView(views[Math.floor(simulation.elapsed / 0.6) % views.length]);
    const event = simulation.currentEvent;
    let target = 4;
    if (event && !scanComplete(event) && simulation.distance < 0.05) target = 0;
    if (event && event.pedestrian.active && !event.pedestrian.cleared) target = 0;
    return {
      throttle: simulation.speed < target - 0.15,
      brake: simulation.speed > target + 0.15,
      left: false,
      right: false
    };
  }

  function replayDriverInput(simulation) {
    const views = ['direct', 'left', 'camera', 'right'];
    simulation.setView(views[Math.floor(simulation.elapsed / 0.6) % views.length]);
    const event = simulation.currentEvent;
    const pedestrian = event && event.pedestrian;
    const near = pedestrian && pedestrian.active && !pedestrian.cleared && Math.abs(pedestrian.x - simulation.x) < 100;
    const target = near ? 0 : 4;
    return {
      throttle: simulation.speed < target - 0.15,
      brake: simulation.speed > target + 0.15,
      left: false,
      right: false
    };
  }

  class Simulation {
    constructor(seed, options) {
      options = options || {};
      this.seed = seed;
      this.role = options.role === 'pedestrian' ? 'pedestrian' : 'driver';
      this.plan = createPlan(seed);
      this.events = this.plan.events.map(createRuntimeEvent);
      this.eventIndex = options.eventId || 0;
      for (let index = 0; index < this.eventIndex; index += 1) this.events[index].resolved = true;
      this.distance = 0;
      this.speed = 0;
      this.previousSpeed = 0;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.x = C.CAR_X;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.view = 'direct';
      this.scanView = null;
      this.scanStreak = 0;
      this.inspection = this.role === 'pedestrian' ? 1 : 0;
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoMode = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.replayReturn = 'retry';
      this.replayCursor = 0;
      this.retryCount = 0;
      if (this.role === 'pedestrian') {
        const pedestrian = this.currentEvent.pedestrian;
        pedestrian.active = true;
        this.events[this.eventIndex].skippedInspection = true;
      }
    }

    get currentEvent() {
      const event = this.events[this.eventIndex];
      return event && !event.resolved ? event : null;
    }

    get phase() {
      return this.inspection < 1 ? 'walkaround' : 'reverse';
    }

    start() {
      this.status = 'driving';
    }

    setView(view) {
      if (VIEWS.includes(view) && this.phase === 'reverse') this.view = view;
    }

    skipInspection() {
      if (this.phase !== 'walkaround') return;
      this.inspection = 1;
      const event = this.currentEvent;
      if (event) event.skippedInspection = true;
    }

    prepareNextEvent() {
      this.eventIndex += 1;
      this.distance = 0;
      this.speed = 0;
      this.previousSpeed = 0;
      this.x = C.CAR_X;
      this.inspection = 0;
      this.view = 'direct';
      this.scanView = null;
      this.scanStreak = 0;
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
      const event = this.currentEvent;
      if (!event) return;

      if (this.phase === 'walkaround') {
        if (input.throttle) this.inspection = Math.min(1, this.inspection + dt / C.INSPECTION_DURATION);
        if (this.inspection >= 1) event.inspected = !event.skippedInspection;
        Scoring.recordSmooth(this.scoring, this, dt, false);
        if (this.elapsed >= C.MAX_TIME) {
          this.speed = 0;
          this.status = 'timeout';
        }
        return;
      }

      const oldSpeed = this.speed / 3.6;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = -C.BRAKE_DECELERATION;
      this.acceleration = acceleration;
      let nextSpeed = M.clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      if (!input.throttle && !input.brake && this.speed < 0.2) nextSpeed = 0;
      this.speed = nextSpeed * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeed - nextSpeed) / dt);
      this.distance += (oldSpeed + nextSpeed) * 0.5 * dt;
      const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      this.x = M.clamp(this.x + steering * C.STEER_SPEED * dt, C.CAR_MIN_X, C.CAR_MAX_X);

      this.updateEvent(event, input, dt);
      Scoring.recordStep(this.scoring, this, dt);
      if (this.predictConflict(event, input)) {
        this.freeze(event);
        return;
      }
      if (this.distance >= C.REVERSE_DISTANCE) {
        this.distance = C.REVERSE_DISTANCE;
        this.speed = 0;
        this.resolveEvent(event);
        if (this.eventIndex === this.events.length - 1) this.status = 'complete';
        else this.prepareNextEvent();
      } else if (this.elapsed >= C.MAX_TIME) {
        this.speed = 0;
        this.status = 'timeout';
      }
    }

    updateEvent(event, input, dt) {
      if (this.distance <= 4.5 && this.role === 'driver') {
        if (this.scanView === this.view) this.scanStreak += dt;
        else {
          this.scanView = this.view;
          this.scanStreak = dt;
        }
        event.scans[this.view] = Math.max(event.scans[this.view], this.scanStreak);
      }
      const pedestrian = event.pedestrian;
      if (!pedestrian.active && !pedestrian.cleared && this.distance >= event.activateDistance) pedestrian.active = true;
      const wasCleared = pedestrian.cleared;
      if (pedestrian.active && !pedestrian.cleared) {
        if (this.role === 'pedestrian') {
          if (input.personLeft) pedestrian.x -= 55 * dt;
          if (input.personRight) pedestrian.x += 55 * dt;
          if (input.personThrottle) pedestrian.x += pedestrian.direction * pedestrian.speed * dt;
        } else {
          pedestrian.x += pedestrian.direction * pedestrian.speed * dt;
        }
        const reachedClear = pedestrian.direction > 0 ? pedestrian.x >= event.clearX : pedestrian.x <= event.clearX;
        const returnedToCurb = pedestrian.direction > 0 ? pedestrian.x <= event.startX - 8 : pedestrian.x >= event.startX + 8;
        if (reachedClear || (this.role === 'pedestrian' && returnedToCurb)) {
          pedestrian.cleared = true;
          pedestrian.active = false;
        }
      }

      if (pedestrian.active && this.distance > 0.5 && this.distance < 12 && this.speed < 0.3) {
        event.stopDuration += dt;
        if (event.stopDuration >= C.STOP_HOLD) event.properStop = true;
      } else {
        event.stopDuration = 0;
      }
      if (event.properStop && pedestrian.active && this.speed > 1) event.earlyStart = true;
      if (!wasCleared && pedestrian.cleared && event.properStop && this.speed < 0.5 && !event.earlyStart) {
        event.waitedUntilClear = true;
      }
      if (this.distance >= 8 && pedestrian.active && (!event.properStop || event.earlyStart)) event.unsafePass = true;
    }

    predictConflict(event, input) {
      const pedestrian = event.pedestrian;
      if (!pedestrian.active || pedestrian.cleared || this.speed < 0.15) return false;
      let distance = this.distance;
      let velocity = this.speed / 3.6;
      let x = pedestrian.x;
      const acceleration = input.brake ? -C.BRAKE_DECELERATION : (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
      const horizon = 1.5;
      const substep = 0.025;
      for (let time = 0; time < horizon; time += substep) {
        const nextVelocity = M.clamp(velocity + acceleration * substep, 0, C.MAX_SPEED / 3.6);
        const nextDistance = distance + (velocity + nextVelocity) * 0.5 * substep;
        if (this.role !== 'pedestrian' || input.personThrottle) x += pedestrian.direction * pedestrian.speed * substep;
        const currentY = C.CAR_START_Y + distance * C.REVERSE_SCALE;
        const nextY = C.CAR_START_Y + nextDistance * C.REVERSE_SCALE;
        const vertical = pedestrian.y >= Math.min(currentY, nextY) - 27 && pedestrian.y <= Math.max(currentY, nextY) + 27;
        if (vertical && Math.abs(x - this.x) < 22) return true;
        distance = nextDistance;
        velocity = nextVelocity;
        if (velocity <= 0) break;
      }
      if (this.speed > 4.8 && this.distance > 7.2 && this.distance < 12 && !event.properStop &&
        Math.abs(pedestrian.x - this.x) < 58 && Math.abs(pedestrian.y - carY(this)) < 68) return true;
      return false;
    }

    freeze(event) {
      if (this.role === 'pedestrian') {
        this.status = 'frozen';
        this.freezeInfo = { eventId: event.id, speed: this.speed, pedestrianReplay: true };
        return;
      }
      event.failed = true;
      event.attempts += 1;
      this.retryCount += 1;
      this.status = 'frozen';
      this.freezeInfo = {
        eventId: event.id,
        speed: this.speed,
        kind: event.kind,
        skippedInspection: event.skippedInspection,
        cameraOnly: event.scans.camera > 0 && event.scans.direct < C.SCAN_DWELL &&
          event.scans.left < C.SCAN_DWELL && event.scans.right < C.SCAN_DWELL
      };
    }

    resolveEvent(event) {
      event.resolved = true;
      event.earlySlow = scanComplete(event);
      this.justResolved = event;
    }

    resetCurrentEvent(keepFailure) {
      const event = this.currentEvent || this.events[this.eventIndex];
      const failed = event.failed;
      const attempts = event.attempts;
      resetRuntime(event);
      if (keepFailure) {
        event.failed = failed;
        event.attempts = attempts;
      }
      this.distance = 0;
      this.speed = 0;
      this.previousSpeed = 0;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.x = C.CAR_X;
      this.inspection = 0;
      this.view = 'direct';
      this.scanView = null;
      this.scanStreak = 0;
      this.freezeInfo = null;
      this.demo = null;
      this.demoMode = null;
      this.demoTime = 0;
      this.justResolved = null;
      this.status = 'driving';
    }

    retryEvent() {
      this.resetCurrentEvent(true);
    }

    startDemo() {
      if (!this.freezeInfo) return;
      const eventId = this.freezeInfo.eventId;
      const demo = new Simulation(this.seed, { eventId: eventId });
      demo.status = 'driving';
      this.demo = demo;
      this.demoMode = 'driver';
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.status = 'demonstrating';
    }

    startPedestrianReplay() {
      if (this.status !== 'frozen' && this.status !== 'complete') return;
      const fromResult = this.status === 'complete';
      const eventId = fromResult ? this.replayCursor % this.events.length : this.freezeInfo.eventId;
      if (fromResult) this.replayCursor += 1;
      const demo = new Simulation(this.seed, { eventId: eventId, role: 'pedestrian' });
      demo.status = 'driving';
      this.demo = demo;
      this.demoMode = 'pedestrian';
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.replayFrozenAt = null;
      this.replayReturn = fromResult ? 'complete' : 'retry';
      this.status = 'demonstrating';
    }

    finishReplay() {
      if (this.replayReturn === 'complete') {
        const cursor = this.replayCursor;
        this.demo = null;
        this.demoMode = null;
        this.status = 'complete';
        this.replayCursor = cursor;
      } else {
        this.retryEvent();
      }
    }

    stepDemo(dt, input) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      if (this.demoMode === 'pedestrian') {
        const source = input || {};
        const controls = replayDriverInput(this.demo);
        controls.personThrottle = Boolean(source.throttle);
        controls.personLeft = Boolean(source.left);
        controls.personRight = Boolean(source.right);
        this.demo.step(controls, dt);
        if (this.demo.status === 'frozen') {
          if (this.replayFrozenAt == null) this.replayFrozenAt = this.demoTime;
          if (this.demoTime - this.replayFrozenAt >= 2) this.finishReplay();
          return;
        }
        if (this.demo.status === 'complete' || this.demo.events[this.demoEventId].resolved || this.demoTime >= 22) {
          this.finishReplay();
        }
        return;
      }
      this.demo.step(defensiveInput(this.demo), dt);
      if (this.demo.status === 'frozen' || this.demo.status === 'timeout' ||
        this.demo.events[this.demoEventId].resolved || this.demoTime >= 45) {
        this.retryEvent();
      }
    }
  }

  const Scoring = {
    eventObservation: function (event) {
      const inspection = event.inspected && !event.skippedInspection ? 3 : 0;
      const scans = scanComplete(event) ? 3 : 0;
      const response = event.properStop && event.waitedUntilClear && !event.earlyStart ? 4 : 0;
      return inspection + scans + response;
    },

    eventSafe: function (event) {
      return event.resolved && !event.failed && !event.unsafePass;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || simulation.phase === 'walkaround' || simulation.speed >= 0.4) return false;
      if (!scanComplete(event) && simulation.distance < 0.05) return true;
      return event.pedestrian.active && !event.pedestrian.cleared && simulation.distance < 14;
    },

    recordSmooth: function (state, simulation, dt, necessary) {
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const harsh = !necessary && simulation.lastDeceleration > C.HARD_BRAKE &&
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

    recordStep: function (state, simulation, dt) {
      const event = simulation.currentEvent;
      if (!Scoring.isYieldExempt(simulation)) {
        let quality = 0;
        if (simulation.speed >= 2.5 && simulation.speed <= 5) quality = 1;
        else if (simulation.speed > 0.4 && simulation.speed < 2.5) quality = (simulation.speed - 0.4) / 2.1;
        else if (simulation.speed > 5) quality = Math.max(0, (6.2 - simulation.speed) / 1.2);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      Scoring.recordSmooth(state, simulation, dt, Boolean(event && event.pedestrian.active));
    },

    summarize: function (simulation, timedOut) {
      const state = simulation.scoring;
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(Scoring.eventSafe);
      const observation = resolved.reduce(function (sum, event) { return sum + Scoring.eventObservation(event); }, 0);
      const safety = Math.round(clean.length * 40 / 3);
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
        summaryKey = 'scene.reversing.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.reversing.result.advice.default';
      if (failed) adviceKey = 'scene.reversing.result.advice.failed';
      else if (observation < 30) adviceKey = 'scene.reversing.result.advice.observation';
      else if (timedOut || efficiency < 12) adviceKey = 'scene.reversing.result.advice.efficiency';
      return {
        total: total, grade: grade, titleKey: titleKey, summaryKey: summaryKey,
        safety: safety, observation: Math.round(observation), efficiency: Math.round(efficiency),
        efficiencyRaw: efficiency, smooth: smooth, hardBrakes: state.hardBrakes,
        earlySlowCount: simulation.events.filter(function (event) { return event.inspected; }).length,
        passedCount: clean.length, timedOut: Boolean(timedOut), failed: failed, adviceKey: adviceKey
      };
    }
  };

  function drawViewCone(ctx, simulation) {
    if (simulation.phase === 'walkaround') return;
    const cone = coneFor(simulation, simulation.view);
    const base = Math.atan2(cone.dy, cone.dx);
    const angle = Math.acos(cone.cos);
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = simulation.view === 'camera' ? '#7fd1ed' : '#b7efc4';
    ctx.beginPath();
    ctx.moveTo(cone.x, cone.y);
    ctx.lineTo(cone.x + Math.cos(base - angle) * cone.range, cone.y + Math.sin(base - angle) * cone.range);
    ctx.lineTo(cone.x + Math.cos(base + angle) * cone.range, cone.y + Math.sin(base + angle) * cone.range);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawEnvironment(ctx, simulation, event) {
    Draw.rect(ctx, '#365647', 0, 0, C.WIDTH, C.HEIGHT);
    Draw.rect(ctx, '#3b484b', 132, 158, 96, 310);
    Draw.rect(ctx, '#c5c1aa', 0, event.actorY - 16, C.WIDTH, 32);
    Draw.rect(ctx, '#a5a58f', 0, event.actorY - 18, C.WIDTH, 2);
    Draw.rect(ctx, '#a5a58f', 0, event.actorY + 16, C.WIDTH, 2);
    Draw.rect(ctx, '#3b484b', 0, 405, C.WIDTH, 235);
    for (let x = 10; x < C.WIDTH; x += 42) Draw.rect(ctx, '#526064', x, 510, 22, 3);
    Draw.rect(ctx, '#80e0b122', 139, C.CAR_START_Y + 50, 82, 32);
    Draw.rect(ctx, '#d8e8c8', 139, C.CAR_START_Y + 78, 82, 2);
    Draw.fillFittedText(ctx, t('scene.reversing.canvas.stop'), 142, C.CAR_START_Y + 73, 74, 7, 'sans-serif');
    obstaclesFor(event).forEach(function (obstacle) {
      if (obstacle.type === 'vehicle') {
        Draw.rect(ctx, '#20343e', obstacle.x, obstacle.y, obstacle.w, obstacle.h);
        Draw.rect(ctx, '#668894', obstacle.x + 5, obstacle.y + 6, obstacle.w - 10, obstacle.h - 12);
        Draw.rect(ctx, '#294651', obstacle.x + 12, obstacle.y + 22, obstacle.w - 24, 42);
        Draw.rect(ctx, '#9ab9bd', obstacle.x + 17, obstacle.y + 26, obstacle.w - 34, 9);
      } else if (obstacle.type === 'fence') {
        Draw.rect(ctx, '#657461', obstacle.x, obstacle.y, obstacle.w, obstacle.h);
        for (let x = obstacle.x + 5; x < obstacle.x + obstacle.w; x += 13) Draw.rect(ctx, '#9b9b78', x, obstacle.y, 5, obstacle.h);
      } else {
        Draw.rect(ctx, '#314b43', obstacle.x, obstacle.y, obstacle.w, obstacle.h);
        Draw.rect(ctx, '#5d7a65', obstacle.x, obstacle.y, obstacle.w, 8);
      }
    });
  }

  function drawActor(ctx, event, pedestrianMode) {
    const pedestrian = event.pedestrian;
    if (!pedestrian.active || pedestrian.cleared) return;
    Draw.drawPedestrian(ctx, C, pedestrian.x, pedestrian.y, event, false, pedestrianMode);
    if (event.kind === 'cyclist') {
      ctx.save();
      ctx.strokeStyle = '#172b33';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pedestrian.x - 7, pedestrian.y + 7, 5, 0, Math.PI * 2);
      ctx.arc(pedestrian.x + 7, pedestrian.y + 7, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (event.kind === 'elder') {
      Draw.rect(ctx, '#d9d2b4', pedestrian.x + 6, pedestrian.y, 1, 11);
    } else {
      ctx.fillStyle = '#e8dfc0';
      ctx.beginPath();
      ctx.arc(pedestrian.x + pedestrian.direction * 12, pedestrian.y + 7, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawInspector(ctx, simulation) {
    if (simulation.phase !== 'walkaround') return;
    const position = inspectionPosition(simulation.inspection);
    const event = { coatColor: '#80e0b1', skinColor: '#efb489' };
    Draw.drawPedestrian(ctx, C, position.x, position.y, event, false, false);
    ctx.save();
    ctx.strokeStyle = '#80e0b188';
    ctx.setLineDash([3, 4]);
    ctx.strokeRect(140, 170, 80, 96);
    ctx.restore();
    Draw.fillFittedText(ctx, t('scene.reversing.canvas.walk'), 118, 154, 124, 9, 'sans-serif');
  }

  function drawWorld(ctx, simulation, demo) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, 2)];
    drawEnvironment(ctx, simulation, event);
    drawViewCone(ctx, simulation);
    const showHidden = simulation.status === 'frozen' || simulation.role === 'pedestrian';
    if (showHidden || visibilityFor(simulation, event, simulation.view)) drawActor(ctx, event, simulation.role === 'pedestrian');
    Draw.drawCar(ctx, simulation.x, carY(simulation), demo ? '#65d6a1' : '#e7685b', demo);
    if (simulation.speed > 0.1 || simulation.role === 'pedestrian') {
      Draw.rect(ctx, '#fff4ce', simulation.x - 11, carY(simulation) + 20, 6, 3);
      Draw.rect(ctx, '#fff4ce', simulation.x + 5, carY(simulation) + 20, 6, 3);
    }
    drawInspector(ctx, simulation);
    const label = simulation.phase === 'walkaround' ? t('scene.reversing.canvas.inspection') : t('scene.reversing.view.' + simulation.view);
    Draw.rect(ctx, '#132633dd', 104, 596, 152, 24);
    Draw.fillFittedText(ctx, label, 112, 612, 136, 9, 'sans-serif');
    if (simulation.status === 'frozen') {
      Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
      Draw.rect(ctx, '#fff0b0', simulation.x + 22, carY(simulation) - 20, 22, 24);
      Draw.rect(ctx, '#3b2a0e', simulation.x + 31, carY(simulation) - 16, 4, 10);
      Draw.rect(ctx, '#3b2a0e', simulation.x + 31, carY(simulation) - 3, 4, 4);
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) drawWorld(ctx, simulation.demo, simulation.demoMode === 'driver');
      else drawWorld(ctx, simulation, false);
    }
  };

  const Scene = {
    id: 'reversing-blind-spot',
    Constants: C,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    defensiveInput: defensiveInput,
    visibilityFor: visibilityFor,
    scanComplete: scanComplete,
    obstaclesFor: obstaclesFor,
    ui: {
      progress: function (simulation) {
        if (simulation.status === 'demonstrating' && simulation.demoMode === 'pedestrian') {
          return t('scene.reversing.hud.replay', { number: simulation.demoEventId + 1 });
        }
        return t('scene.reversing.hud.progress', { resolved: simulation.events.filter(function (event) { return event.resolved; }).length });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.inspected; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(Scoring.eventSafe).length
        ];
      },
      coach: function (simulation) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (simulation.status === 'demonstrating' && simulation.demoMode === 'pedestrian') {
          return { text: t('scene.reversing.hud.person'), status: t('scene.reversing.hud.personStatus'), coachTone: 'good', tone: '' };
        }
        if (current.phase === 'walkaround') {
          return { text: t('scene.reversing.hud.walk'), status: t('scene.reversing.hud.walkStatus'), coachTone: 'good', tone: '' };
        }
        if (event && event.pedestrian.active && !event.pedestrian.cleared) {
          return {
            text: t(current.speed < 0.4 ? 'scene.reversing.hud.wait' : 'scene.reversing.hud.stop'),
            status: t(current.speed < 0.4 ? 'hud.yielding' : 'hud.prepareStop'),
            coachTone: current.speed < 0.4 ? 'good' : 'risk', tone: current.speed < 0.4 ? '' : 'warn'
          };
        }
        if (event && !scanComplete(event) && current.distance < 0.05) {
          return { text: t('scene.reversing.hud.scan'), status: t('scene.reversing.hud.scanStatus'), coachTone: 'risk', tone: 'warn' };
        }
        return { text: t('scene.reversing.hud.reverse'), status: t('scene.reversing.hud.reverseStatus'), coachTone: '', tone: '' };
      },
      retryToast: function () {
        return { key: 'scene.reversing.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return {
          key: score === 10 ? 'scene.reversing.toast.safe' : 'scene.reversing.toast.improve',
          params: { score: score }, neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        const key = info.skippedInspection ? 'scene.reversing.failure.skipped' :
          (info.cameraOnly ? 'scene.reversing.failure.camera' : 'scene.reversing.failure.reason');
        return t(key, { speed: info.speed.toFixed(1) });
      },
      demoCaption: function (simulation) {
        if (simulation.demoMode === 'pedestrian') {
          const frozen = simulation.demo.status === 'frozen';
          return {
            step: t(frozen ? 'scene.reversing.replay.stopTitle' : 'scene.reversing.replay.title'),
            substep: t(frozen ? 'scene.reversing.replay.stopText' : 'scene.reversing.replay.text')
          };
        }
        const demo = simulation.demo;
        if (demo.phase === 'walkaround') return { step: t('scene.reversing.demo.walk'), substep: t('scene.reversing.demo.walkSub') };
        const event = demo.currentEvent;
        if (event && event.pedestrian.active && !event.pedestrian.cleared) {
          return { step: t('scene.reversing.demo.wait'), substep: t('scene.reversing.demo.waitSub') };
        }
        if (event && !scanComplete(event) && demo.distance < 0.05) {
          return { step: t('scene.reversing.demo.scan'), substep: t('scene.reversing.demo.scanSub') };
        }
        return { step: t('scene.reversing.demo.reverse'), substep: t('scene.reversing.demo.reverseSub') };
      },
      updateControls: function (doc, simulation) {
        const badge = doc.querySelector('.demo-badge');
        if (badge && simulation.status === 'demonstrating') {
          badge.textContent = t(simulation.demoMode === 'pedestrian' ? 'scene.reversing.replay.badge' : 'game.demoBadge');
        }
        const skipDemo = doc.getElementById('skip-demo-button');
        if (skipDemo && simulation.status === 'demonstrating') {
          skipDemo.textContent = t(simulation.demoMode === 'pedestrian' ? 'scene.reversing.replay.skip' : 'game.skipDemo');
        }
        doc.querySelectorAll('[data-view]').forEach(function (button) {
          const active = button.dataset.view === simulation.view && simulation.phase === 'reverse';
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', String(active));
          button.disabled = simulation.phase !== 'reverse' || simulation.status !== 'driving';
        });
        const skip = doc.getElementById('skip-inspection-button');
        if (skip) skip.hidden = simulation.phase !== 'walkaround' || simulation.status !== 'driving';
      }
    },

    bindControls: function (doc, getSimulation) {
      doc.querySelectorAll('[data-view]').forEach(function (button) {
        button.addEventListener('click', function () { getSimulation().setView(button.dataset.view); });
      });
      const skip = doc.getElementById('skip-inspection-button');
      if (skip) skip.addEventListener('click', function () { getSimulation().skipInspection(); });
      doc.addEventListener('keydown', function (event) {
        const index = ['1', '2', '3', '4'].indexOf(event.key);
        if (index >= 0 && getSimulation().status === 'driving') {
          getSimulation().setView(VIEWS[index]);
          event.preventDefault();
        }
      });
    }
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
