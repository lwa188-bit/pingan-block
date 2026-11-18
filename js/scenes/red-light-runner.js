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
    START_Y: 570,
    EXIT_Y: 150,
    RUNNER_Y: 300,
    STOP_LINE_Y: 420,
    YIELD_MIN_Y: 442,
    YIELD_MAX_Y: 530,
    MAX_SPEED: 50,
    START_SPEED: 30,
    ACCELERATION: 7,
    BRAKE_DECELERATION: 18,
    NATURAL_DECELERATION: 2,
    PIXELS_PER_KMH: 2,
    PLAYER_HALF_WIDTH: 14,
    PLAYER_HALF_LENGTH: 22,
    RUNNER_HALF_WIDTH: 22,
    RUNNER_HALF_LENGTH: 14,
    MAX_TIME: 105,
    SCAN_DWELL: 0.25,
    CLEAR_DWELL: 0.25,
    PREDICTION_STEP: 0.025,
    PREDICTION_HORIZON: 0.65
  });
  const VIEWS = ['left', 'front', 'right'];

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed('red-light-runner:' + seed));
    const colors = ['#d7b957', '#7fa6b2', '#c5c9b8', '#d98468'];
    function runner(id, direction, x, speed) {
      return Object.freeze({
        id: id,
        direction: direction,
        x: x,
        y: C.RUNNER_Y,
        speed: speed,
        color: colors[Math.floor(random() * colors.length)]
      });
    }
    const firstSpeed = 48 + random() * 8;
    const secondSpeed = 48 + random() * 8;
    const followSpeed = 49 + random() * 7;
    const followX = -132 - random() * 18;
    return Object.freeze({ events: Object.freeze([
      Object.freeze({
        id: 0, kind: 'open-left', side: 'left', direction: 1,
        runners: Object.freeze([runner(0, 1, -132 - random() * 18, firstSpeed)])
      }),
      Object.freeze({
        id: 1, kind: 'occluded-right', side: 'right', direction: -1,
        runners: Object.freeze([runner(0, -1, 492 + random() * 18, secondSpeed)])
      }),
      Object.freeze({
        id: 2, kind: 'follow', side: 'left', direction: 1,
        runners: Object.freeze([
          runner(0, 1, followX, followSpeed),
          runner(1, 1, followX - 540 - random() * 24, followSpeed)
        ])
      })
    ]) });
  }

  function createRuntimeEvent(plan) {
    return {
      id: plan.id,
      kind: plan.kind,
      side: plan.side,
      runners: plan.runners.map(function (runner) {
        return Object.assign({}, runner, {
          baseSpeed: runner.speed,
          routeClear: false,
          gone: false,
          observed: false,
          observationStreak: 0
        });
      }),
      resolved: false,
      failed: false,
      attempts: 0,
      scanView: null,
      scanStreak: 0,
      scanDwells: { left: 0, front: 0, right: 0 },
      initialObserved: false,
      properStop: false,
      waitedUntilClear: false,
      clearConfirmed: false,
      clearDwell: 0,
      earlyStart: false,
      unsafePass: false,
      minimumClearance: Infinity,
      rushAcceleration: false,
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
    Object.keys(event).forEach(function (key) { delete event[key]; });
    Object.assign(event, createRuntimeEvent(plan), preserved);
  }

  function scanComplete(event) {
    return event.scanDwells.left >= C.SCAN_DWELL && event.scanDwells.right >= C.SCAN_DWELL;
  }

  function allRouteClear(event) {
    return event.runners.every(function (runner) { return runner.routeClear; });
  }

  function advancePlayer(player, input, dt) {
    input = input || {};
    const previousSpeed = player.speed;
    if (input.brake) player.speed = Math.max(0, player.speed - C.BRAKE_DECELERATION * dt);
    else if (input.throttle) player.speed = Math.min(C.MAX_SPEED, player.speed + C.ACCELERATION * dt);
    else player.speed = Math.max(0, player.speed - C.NATURAL_DECELERATION * dt);
    player.y -= (previousSpeed + player.speed) * 0.5 * C.PIXELS_PER_KMH * dt;
  }

  function advanceRunner(runner, dt) {
    if (runner.gone) return;
    runner.x += runner.direction * runner.baseSpeed * C.PIXELS_PER_KMH * dt;
    if (!runner.routeClear) {
      runner.routeClear = runner.direction > 0 ? runner.x - C.RUNNER_HALF_WIDTH > C.CAR_X + 36 :
        runner.x + C.RUNNER_HALF_WIDTH < C.CAR_X - 36;
    }
    if ((runner.direction > 0 && runner.x > 430) || (runner.direction < 0 && runner.x < -70)) {
      runner.gone = true;
      runner.routeClear = true;
    }
  }

  function vehicleClearance(player, runner) {
    const horizontal = Math.abs(player.x - runner.x) - (C.PLAYER_HALF_WIDTH + C.RUNNER_HALF_WIDTH);
    const vertical = Math.abs(player.y - runner.y) - (C.PLAYER_HALF_LENGTH + C.RUNNER_HALF_LENGTH);
    if (horizontal <= 0 && vertical <= 0) return Math.max(horizontal, vertical);
    return Math.hypot(Math.max(0, horizontal), Math.max(0, vertical));
  }

  function segmentIntersectsRect(a, b, rect) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let near = 0;
    let far = 1;
    const tests = [
      [-dx, a.x - rect.x], [dx, rect.x + rect.w - a.x],
      [-dy, a.y - rect.y], [dy, rect.y + rect.h - a.y]
    ];
    for (let index = 0; index < tests.length; index += 1) {
      const p = tests[index][0];
      const q = tests[index][1];
      if (Math.abs(p) < 0.000001) {
        if (q < 0) return false;
      } else {
        const ratio = q / p;
        if (p < 0) near = Math.max(near, ratio);
        else far = Math.min(far, ratio);
        if (near > far) return false;
      }
    }
    return true;
  }

  function obstaclesFor(event) {
    if (!event || event.kind !== 'occluded-right') return [];
    return [{ x: 248, y: 305, w: 82, h: 52, type: 'vehicle' }];
  }

  function coneFor(simulation, view) {
    view = view || simulation.view;
    const side = view === 'left' ? -1 : (view === 'right' ? 1 : 0);
    return {
      x: simulation.player.x + side * 12,
      y: simulation.player.y - (view === 'front' ? 22 : 12),
      dx: side,
      dy: view === 'front' ? -1 : -0.18,
      cos: Math.cos((view === 'front' ? 48 : 50) * Math.PI / 180),
      range: view === 'front' ? 270 : 340
    };
  }

  function visibilityFor(simulation, event, view, target) {
    if (!event) return false;
    const runner = target || event.runners.find(function (candidate) {
      return !candidate.routeClear && !candidate.gone;
    });
    if (!runner || runner.routeClear || runner.gone) return false;
    const cone = coneFor(simulation, view);
    const dx = runner.x - cone.x;
    const dy = runner.y - cone.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.001 || distance > cone.range) return false;
    const directionLength = Math.hypot(cone.dx, cone.dy);
    if ((dx * cone.dx + dy * cone.dy) / (distance * directionLength) < cone.cos) return false;
    const eye = { x: cone.x, y: cone.y };
    const point = { x: runner.x, y: runner.y };
    return !obstaclesFor(event).some(function (obstacle) {
      return segmentIntersectsRect(eye, point, obstacle);
    });
  }

  function predictConflict(simulation, input) {
    const event = simulation.currentEvent;
    if (!event || allRouteClear(event) || simulation.player.speed < 0.1) return null;
    const player = Object.assign({}, simulation.player);
    const runners = event.runners.map(function (runner) { return Object.assign({}, runner); });
    const steps = Math.ceil(C.PREDICTION_HORIZON / C.PREDICTION_STEP);
    for (let index = 0; index < steps; index += 1) {
      advancePlayer(player, input, C.PREDICTION_STEP);
      runners.forEach(function (runner) { advanceRunner(runner, C.PREDICTION_STEP); });
      for (let runnerIndex = 0; runnerIndex < runners.length; runnerIndex += 1) {
        const runner = runners[runnerIndex];
        if (!runner.routeClear && vehicleClearance(player, runner) <= 0) {
          return {
            eventId: event.id,
            runnerId: runner.id,
            time: (index + 1) * C.PREDICTION_STEP,
            kind: event.kind
          };
        }
      }
      if (player.speed <= 0) break;
    }
    return null;
  }

  const Geometry = {
    advancePlayer: advancePlayer,
    advanceRunner: advanceRunner,
    vehicleClearance: vehicleClearance,
    segmentIntersectsRect: segmentIntersectsRect,
    obstaclesFor: obstaclesFor,
    allRouteClear: allRouteClear
  };

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
      this.scoring.rushPenalties = 0;
      this.view = 'front';
      this.speed = C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.player = { x: C.CAR_X, y: C.START_Y, speed: C.START_SPEED };
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
    }

    get currentEvent() {
      const event = this.events[this.eventIndex];
      return event && !event.resolved ? event : null;
    }

    start() {
      this.status = 'driving';
    }

    setView(view) {
      if (VIEWS.includes(view)) this.view = view;
    }

    resetPlayer() {
      this.player = { x: C.CAR_X, y: C.START_Y, speed: C.START_SPEED };
      this.speed = C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.view = 'front';
    }

    updateObservation(event, dt) {
      if (this.player.y >= C.STOP_LINE_Y - 10) {
        if (event.scanView === this.view) event.scanStreak += dt;
        else {
          event.scanView = this.view;
          event.scanStreak = dt;
        }
        event.scanDwells[this.view] = Math.max(event.scanDwells[this.view], event.scanStreak);
      } else {
        event.scanView = null;
        event.scanStreak = 0;
      }

      event.runners.forEach(function (runner) {
        const visible = visibilityFor(this, event, this.view, runner);
        runner.observationStreak = visible ? runner.observationStreak + dt : 0;
        if (runner.observationStreak >= C.SCAN_DWELL) runner.observed = true;
      }, this);
      event.initialObserved = event.runners.every(function (runner) { return runner.observed; });

      if (allRouteClear(event) && event.properStop && event.waitedUntilClear &&
        this.speed < 0.5 && this.view === event.side) {
        event.clearDwell += dt;
        if (event.clearDwell >= C.CLEAR_DWELL) event.clearConfirmed = true;
      } else if (!allRouteClear(event) || this.speed >= 0.5 || this.view !== event.side) {
        event.clearDwell = 0;
      }
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
        scanned: event ? scanComplete(event) : false,
        observed: event ? event.initialObserved : false,
        earlyStart: event ? event.earlyStart : false
      };
      this.status = 'frozen';
    }

    failureReason(event) {
      if (event.kind === 'follow' && event.earlyStart) return 'follow';
      if (event.rushAcceleration) return 'rush';
      if (!scanComplete(event)) return 'unscanned';
      if (!event.initialObserved) return 'unseen';
      if (event.kind === 'occluded-right') return 'occluded';
      return 'ignored';
    }

    resolveEvent() {
      const event = this.currentEvent;
      if (!event) return;
      event.observation = (scanComplete(event) ? 3 : 0) + (event.initialObserved ? 4 : 0) +
        (event.clearConfirmed && !event.earlyStart ? 3 : 0);
      event.earlySlow = scanComplete(event);
      event.resolved = true;
      this.justResolved = event;
      if (this.eventIndex === this.events.length - 1) {
        this.player.speed = 0;
        this.speed = 0;
        this.status = 'complete';
        return;
      }
      this.eventIndex += 1;
      this.resetPlayer();
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
        const avoidance = predictConflict(this, { brake: true });
        if (prediction.time <= 0.075 || avoidance) {
          this.freeze(this.failureReason(event), prediction);
          return;
        }
      }

      const oldPlayer = Object.assign({}, this.player);
      const oldRunners = event.runners.map(function (runner) { return Object.assign({}, runner); });
      const previousSpeed = this.player.speed;
      advancePlayer(this.player, input, dt);
      this.speed = this.player.speed;
      this.acceleration = (this.speed - previousSpeed) / dt;
      this.lastDeceleration = Math.max(0, (previousSpeed - this.speed) / dt);
      event.runners.forEach(function (runner) { advanceRunner(runner, dt); });

      if (input.throttle && !allRouteClear(event) && this.player.y < 475 && this.speed > 18) {
        if (!event.rushAcceleration) this.scoring.rushPenalties += 1;
        event.rushAcceleration = true;
      }
      if (event.properStop && !allRouteClear(event) && this.speed > 2) event.earlyStart = true;
      if (this.player.y < C.STOP_LINE_Y && !allRouteClear(event)) event.earlyStart = true;

      let contact = false;
      event.runners.forEach(function (runner) {
        if (runner.routeClear) return;
        const clearance = vehicleClearance(this.player, runner);
        event.minimumClearance = Math.min(event.minimumClearance, clearance);
        if (clearance <= 0) contact = true;
        else if (clearance < 6 && this.speed > 1) event.unsafePass = true;
      }, this);
      if (contact) {
        this.player = oldPlayer;
        this.speed = oldPlayer.speed;
        event.runners = oldRunners;
        this.freeze(this.failureReason(event), { eventId: event.id, time: 0, kind: event.kind });
        return;
      }

      const threatening = !allRouteClear(event);
      if (threatening && this.speed < 0.35 && this.player.y >= C.YIELD_MIN_Y && this.player.y <= C.YIELD_MAX_Y) {
        event.properStop = true;
      }
      if (event.properStop && allRouteClear(event) && this.speed < 0.5) event.waitedUntilClear = true;
      this.updateObservation(event, dt);
      Scoring.recordStep(this.scoring, this, dt);

      if (this.player.y <= C.EXIT_Y && allRouteClear(event)) this.resolveEvent();
      if (this.elapsed >= C.MAX_TIME && this.status === 'driving') {
        this.player.speed = 0;
        this.speed = 0;
        this.status = 'timeout';
      }
    }

    retryEvent() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.demoEventId != null ? this.demoEventId : this.eventIndex);
      this.eventIndex = eventId;
      resetEventRuntime(this.events[eventId], this.plan.events[eventId]);
      this.resetPlayer();
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
      if (event.resolved || this.demo.status === 'frozen' || this.demo.status === 'timeout' || this.demoTime >= 40) {
        this.retryEvent();
      }
    }
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    if (!event) return {};
    let view = 'front';
    if (event.scanDwells.left < C.SCAN_DWELL) view = 'left';
    else if (event.scanDwells.right < C.SCAN_DWELL) view = 'right';
    else if (!event.initialObserved || !allRouteClear(event) || !event.clearConfirmed) view = event.side;
    simulation.setView(view);

    let target = 32;
    if (simulation.player.y < 505) target = 18;
    const needsWait = !scanComplete(event) || !event.initialObserved || !allRouteClear(event) || !event.clearConfirmed;
    if (simulation.player.y < 488 && needsWait) target = 0;
    if (!needsWait) target = simulation.player.y < C.STOP_LINE_Y ? 34 : 32;
    return {
      throttle: simulation.speed < target - 0.35,
      brake: simulation.speed > target + 0.35,
      left: false,
      right: false
    };
  }

  const Scoring = {
    eventObservation: function (event) {
      return event.observation || ((scanComplete(event) ? 3 : 0) + (event.initialObserved ? 4 : 0) +
        (event.clearConfirmed && !event.earlyStart ? 3 : 0));
    },

    eventSafe: function (event) {
      return event.resolved && !event.failed && !event.unsafePass;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || simulation.speed >= 0.8 || simulation.player.y < C.YIELD_MIN_Y - 12 ||
        simulation.player.y > C.YIELD_MAX_Y) return false;
      return !scanComplete(event) || !event.initialObserved || !allRouteClear(event) || !event.clearConfirmed;
    },

    recordStep: function (state, simulation, dt) {
      const event = simulation.currentEvent;
      if (!Scoring.isYieldExempt(simulation)) {
        const approaching = simulation.player.y <= 505 && !allRouteClear(event);
        const low = approaching ? 12 : 26;
        const high = approaching ? 24 : 40;
        let quality = 0;
        if (simulation.speed >= low && simulation.speed <= high) quality = 1;
        else if (simulation.speed > 1 && simulation.speed < low) quality = (simulation.speed - 1) / (low - 1);
        else if (simulation.speed > high) quality = Math.max(0, 1 - (simulation.speed - high) / 14);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const necessary = event && ((!allRouteClear(event) && simulation.player.y < 525) ||
        (event.initialObserved && simulation.previousSpeed < 25));
      const harsh = !necessary && simulation.lastDeceleration > 15 && simulation.previousSpeed > 28;
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
      const safety = Math.round(clean.length * 40 / 3);
      const observation = resolved.reduce(function (sum, event) { return sum + Scoring.eventObservation(event); }, 0);
      const state = simulation.scoring;
      const efficiency = state.efficiencyTime > 0 ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
      const smooth = Math.max(0, 10 - state.hardBrakes * 2 - state.rushPenalties);
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
        summaryKey = 'scene.redLight.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.redLight.result.advice.default';
      if (failed) adviceKey = 'scene.redLight.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.redLight.result.advice.observation';
      else if (state.hardBrakes || state.rushPenalties) adviceKey = 'scene.redLight.result.advice.smooth';
      else if (timedOut || efficiency < 12) adviceKey = 'scene.redLight.result.advice.efficiency';
      return {
        total: total, grade: grade, titleKey: titleKey, summaryKey: summaryKey,
        safety: safety, observation: Math.round(observation), efficiency: Math.round(efficiency),
        efficiencyRaw: efficiency, smooth: smooth, hardBrakes: state.hardBrakes,
        earlySlowCount: simulation.events.filter(scanComplete).length,
        passedCount: clean.length, timedOut: Boolean(timedOut), failed: failed, adviceKey: adviceKey
      };
    }
  };

  function drawSignal(ctx, x, y, green) {
    Draw.rect(ctx, '#14232b', x, y, 13, 32);
    Draw.rect(ctx, green ? '#603b3b' : '#ff6459', x + 3, y + 3, 7, 7);
    Draw.rect(ctx, '#5c583b', x + 3, y + 13, 7, 7);
    Draw.rect(ctx, green ? '#80e0b1' : '#315148', x + 3, y + 23, 7, 7);
  }

  function drawLegalVehicle(ctx, x, y, direction, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(direction > 0 ? Math.PI / 2 : -Math.PI / 2);
    Draw.drawCar(ctx, 0, 0, color || '#6f8f9a', false);
    Draw.rect(ctx, '#ff6b5f', -11, 19, 7, 4);
    Draw.rect(ctx, '#ff6b5f', 4, 19, 7, 4);
    ctx.restore();
  }

  function drawEnvironment(ctx, event) {
    Draw.rect(ctx, '#365647', 0, 0, C.WIDTH, C.HEIGHT);
    Draw.rect(ctx, '#a9aa96', 98, 0, 164, C.HEIGHT);
    Draw.rect(ctx, '#a9aa96', 0, 228, C.WIDTH, 166);
    Draw.rect(ctx, '#3b484b', 110, 0, 140, C.HEIGHT);
    Draw.rect(ctx, '#3b484b', 0, 240, C.WIDTH, 142);
    for (let y = 12; y < C.HEIGHT; y += 38) {
      if (y < 225 || y > 400) Draw.rect(ctx, '#78877e', 178, y, 3, 17);
    }
    for (let x = 12; x < C.WIDTH; x += 42) {
      if (x < 105 || x > 255) Draw.rect(ctx, '#697773', x, 308, 22, 3);
    }
    Draw.rect(ctx, '#526064', 116, 0, 2, 228);
    Draw.rect(ctx, '#526064', 242, 394, 2, 246);
    for (let x = 116; x < 246; x += 18) {
      Draw.rect(ctx, '#c5c1aa', x, 374, 10, 20);
      Draw.rect(ctx, '#c5c1aa', x, 218, 10, 20);
    }
    Draw.rect(ctx, '#d8e8c8', 140, C.STOP_LINE_Y, 80, 3);
    Draw.rect(ctx, '#80e0b116', 142, C.STOP_LINE_Y + 4, 76, 26);
    Draw.fillFittedText(ctx, t('scene.redLight.canvas.stop'), 139, 442, 82, 7, 'sans-serif');
    Draw.fillFittedText(ctx, t('scene.redLight.canvas.ownGreen'), 224, 414, 70, 7, 'sans-serif');
    Draw.fillFittedText(ctx, t('scene.redLight.canvas.crossRed'), 18, 258, 80, 7, 'sans-serif');
    drawSignal(ctx, 231, 381, true);
    drawSignal(ctx, 91, 261, false);
    if (event && event.kind === 'occluded-right') {
      drawLegalVehicle(ctx, 289, 331, -1, '#728b96');
      Draw.rect(ctx, '#263d3c', 300, 168, 60, 60);
      Draw.rect(ctx, '#4c6a59', 305, 173, 50, 9);
    } else {
      drawLegalVehicle(ctx, event && event.side === 'left' ? 292 : 66, 356,
        event && event.side === 'left' ? -1 : 1, '#728b96');
    }
  }

  function drawViewCone(ctx, simulation) {
    if (simulation.view === 'front') return;
    const cone = coneFor(simulation, simulation.view);
    const base = Math.atan2(cone.dy, cone.dx);
    const angle = Math.acos(cone.cos);
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = '#b7efc4';
    ctx.beginPath();
    ctx.moveTo(cone.x, cone.y);
    ctx.lineTo(cone.x + Math.cos(base - angle) * cone.range, cone.y + Math.sin(base - angle) * cone.range);
    ctx.lineTo(cone.x + Math.cos(base + angle) * cone.range, cone.y + Math.sin(base + angle) * cone.range);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawRunner(ctx, simulation, event, runner, force, inset) {
    if (runner.gone || (!force && !visibilityFor(simulation, event, simulation.view, runner))) return;
    if (!inset && (runner.x < -45 || runner.x > 405)) return;
    ctx.save();
    ctx.translate(runner.x, runner.y);
    ctx.rotate(runner.direction > 0 ? Math.PI / 2 : -Math.PI / 2);
    Draw.drawCar(ctx, 0, 0, runner.color, false);
    ctx.restore();
    if (!inset) {
      Draw.rect(ctx, '#132633dd', runner.x - 25, runner.y - 28, 50, 12);
      Draw.fillFittedText(ctx, Math.round(runner.baseSpeed) + ' km/h', runner.x - 22, runner.y - 19, 44, 7, 'sans-serif');
      if (runner.observed) Draw.rect(ctx, '#80e0b1', runner.x - 18, runner.y + 18, 36, 2);
    }
  }

  function drawPlayer(ctx, simulation, demo) {
    Draw.drawCar(ctx, simulation.player.x, simulation.player.y, demo ? '#65d6a1' : '#e7685b', demo);
    if (simulation.lastDeceleration > 1) {
      Draw.rect(ctx, '#ff665c', simulation.player.x - 11, simulation.player.y + 19, 7, 4);
      Draw.rect(ctx, '#ff665c', simulation.player.x + 4, simulation.player.y + 19, 7, 4);
    }
  }

  function drawInset(ctx, simulation) {
    if (simulation.view === 'front') return;
    const event = simulation.currentEvent;
    if (!event) return;
    const box = { x: 103, y: 104, w: 154, h: 132 };
    const direction = simulation.view === 'left' ? -1 : 1;
    const center = { x: simulation.player.x + direction * 155, y: 385 };
    ctx.save();
    Draw.rect(ctx, '#0c1b24ee', box.x - 3, box.y - 3, box.w + 6, box.h + 25);
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    ctx.scale(0.42, 0.42);
    ctx.translate(-center.x, -center.y);
    drawEnvironment(ctx, event);
    event.runners.forEach(function (runner) { drawRunner(ctx, simulation, event, runner, false, true); });
    drawPlayer(ctx, simulation, false);
    ctx.restore();
    const visible = event.runners.some(function (runner) {
      return visibilityFor(simulation, event, simulation.view, runner);
    });
    ctx.save();
    ctx.strokeStyle = '#8fd8bd';
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = '#dcebdd';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(t('scene.redLight.view.' + simulation.view), box.x + 5, box.y + box.h + 14);
    ctx.textAlign = 'right';
    ctx.fillStyle = visible ? '#80e0b1' : '#9bb0b5';
    ctx.fillText(t(visible ? 'scene.redLight.canvas.visible' : 'scene.redLight.canvas.scanning'),
      box.x + box.w - 5, box.y + box.h + 14);
    ctx.restore();
  }

  function drawWorld(ctx, simulation, demo) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, 2)];
    drawEnvironment(ctx, event);
    drawViewCone(ctx, simulation);
    if (event) {
      event.runners.forEach(function (runner) {
        drawRunner(ctx, simulation, event, runner, simulation.status === 'frozen', false);
      });
    }
    drawPlayer(ctx, simulation, demo);
    drawInset(ctx, simulation);
    Draw.rect(ctx, '#132633dd', 112, 600, 136, 23);
    Draw.fillFittedText(ctx, t('scene.redLight.view.' + simulation.view), 124, 615, 112, 9, 'sans-serif');
    if (simulation.status === 'frozen') {
      Draw.rect(ctx, '#fff0b0', simulation.player.x + 22, simulation.player.y - 20, 22, 24);
      Draw.rect(ctx, '#3b2a0e', simulation.player.x + 31, simulation.player.y - 16, 4, 10);
      Draw.rect(ctx, '#3b2a0e', simulation.player.x + 31, simulation.player.y - 3, 4, 4);
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) drawWorld(ctx, simulation.demo, true);
      else drawWorld(ctx, simulation, false);
    }
  };

  const Scene = {
    id: 'red-light-runner',
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
    scanComplete: scanComplete,
    ui: {
      progress: function (simulation) {
        return t('scene.redLight.hud.progress', {
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
        if (!event) return { text: t('scene.redLight.hud.cruise'), status: t('hud.ready'), coachTone: '', tone: '' };
        if (!scanComplete(event)) {
          return { text: t('scene.redLight.hud.scan'), status: t('scene.redLight.hud.scanStatus'), coachTone: 'risk', tone: 'warn' };
        }
        if (!event.initialObserved) {
          return {
            text: t(event.kind === 'occluded-right' ? 'scene.redLight.hud.occluded' : 'scene.redLight.hud.observe'),
            status: t('scene.redLight.hud.observing'), coachTone: 'risk', tone: 'warn'
          };
        }
        if (!allRouteClear(event)) {
          const following = event.kind === 'follow' && event.runners[0].routeClear;
          return {
            text: t(following ? 'scene.redLight.hud.follow' : (current.speed < 0.5 ? 'scene.redLight.hud.wait' : 'scene.redLight.hud.stop')),
            status: t(current.speed < 0.5 ? 'hud.yielding' : 'hud.prepareStop'),
            coachTone: current.speed < 0.5 ? 'good' : 'risk', tone: current.speed < 0.5 ? '' : 'warn'
          };
        }
        if (!event.clearConfirmed) {
          return { text: t('scene.redLight.hud.confirm'), status: t('scene.redLight.hud.confirmStatus'), coachTone: 'good', tone: '' };
        }
        return { text: t('scene.redLight.hud.proceed'), status: t('scene.redLight.hud.proceedStatus'), coachTone: '', tone: '' };
      },
      retryToast: function () {
        return { key: 'scene.redLight.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return {
          key: score === 10 ? 'scene.redLight.toast.safe' : 'scene.redLight.toast.improve',
          params: { score: score }, neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.redLight.failure.' + info.reason, { speed: info.speed.toFixed(0) });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo && demo.currentEvent;
        if (!event) return { step: '', substep: '' };
        if (!scanComplete(event) || !event.initialObserved) {
          return { step: t('scene.redLight.demo.observe'), substep: t('scene.redLight.demo.observeSub') };
        }
        if (!allRouteClear(event) || !event.clearConfirmed) {
          return { step: t('scene.redLight.demo.wait'), substep: t('scene.redLight.demo.waitSub') };
        }
        return { step: t('scene.redLight.demo.proceed'), substep: t('scene.redLight.demo.proceedSub') };
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
