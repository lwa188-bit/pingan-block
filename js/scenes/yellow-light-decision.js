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
    EVENT_POSITIONS: [140, 390, 640],
    APPROACH_DISTANCE: 80,
    CONFLICT_DEPTH: 18,
    CAR_X: 210,
    START_SPEED: 30,
    MAX_SPEED: 60,
    MAX_TIME: 145,
    STOP_HOLD_TIME: 0.25,
    REAR_SCAN_DWELL: 0.3,
    REAR_COMFORTABLE_BRAKE: 4.2,
    REAR_MAX_BRAKE: 6,
    REAR_ACCELERATION: 2.4,
    REAR_NATURAL_DECELERATION: 0.25,
    PROCEED_BUFFER: 0.2,
    STOP_ASSESS_TIME: 0.2,
    STOP_BUFFER: 0.8,
    FINISH_BUFFER: 4
  });

  const TEMPLATES = ['clear-stop', 'dual-choice', 'no-abrupt-stop'];
  const VIEWS = ['front', 'rear'];

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
    const random = M.mulberry32(M.hashSeed('yellow-light-decision:' + seed));
    const templates = shuffle(TEMPLATES, random);
    const colors = ['#d7b957', '#7fa6b2', '#c5c9b8', '#d98468'];
    const events = C.EVENT_POSITIONS.map(function (stopS, id) {
      const template = templates[id];
      const yellowAt = template === 'clear-stop' ? 2.5 + random() * 0.2 :
        (template === 'dual-choice' ? 3.75 + random() * 0.2 : 4.45 + random() * 0.15);
      const yellowDuration = template === 'clear-stop' ? 2.4 :
        (template === 'dual-choice' ? 4.2 : 3.2);
      const rearGap = template === 'clear-stop' ? 19 + random() * 4 :
        (template === 'dual-choice' ? 15 + random() * 3 : 9 + random() * 2);
      const allRed = 0.8;
      const redDuration = 5.2;
      return Object.freeze({
        id: id,
        template: template,
        stopS: stopS,
        conflictEndS: stopS + C.CONFLICT_DEPTH,
        yellowAt: yellowAt,
        yellowDuration: yellowDuration,
        allRed: allRed,
        crossReleaseAt: yellowAt + yellowDuration + allRed,
        greenAt: yellowAt + yellowDuration + redDuration,
        rearGap: rearGap,
        rearReaction: template === 'clear-stop' ? 0.7 + random() * 0.15 : 0.82 + random() * 0.16,
        rearColor: colors[Math.floor(random() * colors.length)]
      });
    });
    return Object.freeze({ events: Object.freeze(events) });
  }

  function createRuntimeEvent(plan) {
    return {
      id: plan.id,
      active: false,
      localTime: 0,
      resolved: false,
      failed: false,
      attempts: 0,
      rear: null,
      approachSpeedIntegral: 0,
      approachTime: 0,
      approachMaxSpeed: 0,
      approachPrepared: false,
      rearScanStreak: 0,
      rearObserved: false,
      assessment: null,
      yellowSpeed: null,
      decisionMade: false,
      decisionScore: 0,
      branch: 'undecided',
      properStop: false,
      stopDuration: 0,
      stoppedDistance: null,
      rearStoppedSafely: false,
      minRearGap: Infinity,
      redSeen: false,
      waitedForGreen: false,
      resumeSpeedReached: false,
      earlyStart: false,
      enteredAgainstRule: false,
      rushAcceleration: false,
      execution: false,
      observation: 0,
      unsafePass: false,
      resolvedBranch: null
    };
  }

  function signalPhase(event) {
    if (!event || !event.active) return 'green';
    if (event.localTime < event.yellowAt) return 'green';
    if (event.localTime < event.yellowAt + event.yellowDuration) return 'yellow';
    if (event.localTime < event.greenAt) return 'red';
    return 'green';
  }

  function rearGap(simulation, event) {
    if (!event || !event.rear) return Infinity;
    return simulation.distance - C.CAR_LENGTH_M - event.rear.distance;
  }

  function assessOptions(simulation, event) {
    const speedKmh = simulation.speed;
    const v = speedKmh / 3.6;
    const lineDistance = event.stopS - (simulation.distance + C.CAR_LENGTH_M / 2);
    const gap = rearGap(simulation, event);
    const comfortTravel = v * C.STOP_ASSESS_TIME + v * v / (2 * C.BRAKE_DECELERATION) + C.STOP_BUFFER;
    let rearMargin = Infinity;
    if (event.rear) {
      const rearSpeed = event.rear.speed / 3.6;
      const rearTravel = rearSpeed * event.rearReaction + rearSpeed * rearSpeed / (2 * C.REAR_COMFORTABLE_BRAKE);
      rearMargin = gap + v * v / (2 * C.BRAKE_DECELERATION) - rearTravel;
    }
    const stopSafe = lineDistance >= comfortTravel && rearMargin >= 1;
    let proceedSafe = false;
    let timeToLine = Infinity;
    let timeToClear = Infinity;
    if (v > 0.5) {
      timeToLine = lineDistance <= 0 ? 0 : lineDistance / v;
      timeToClear = (lineDistance + C.CAR_LENGTH_M + C.CONFLICT_DEPTH) / v;
      const yellowRemaining = event.yellowAt + event.yellowDuration - event.localTime;
      const releaseRemaining = event.crossReleaseAt - event.localTime;
      proceedSafe = timeToLine <= yellowRemaining + 0.02 && timeToClear <= releaseRemaining - C.PROCEED_BUFFER;
    }
    return {
      stopSafe: stopSafe,
      proceedSafe: proceedSafe,
      lineDistance: lineDistance,
      stoppingDistance: comfortTravel,
      rearGap: gap,
      rearMargin: rearMargin,
      timeToLine: timeToLine,
      timeToClear: timeToClear,
      speed: speedKmh
    };
  }

  function stopInput(simulation, event) {
    const lineDistance = event.stopS - (simulation.distance + C.CAR_LENGTH_M / 2);
    const v = simulation.speed / 3.6;
    const brakeDistance = v * v / (2 * C.BRAKE_DECELERATION);
    if (lineDistance <= brakeDistance + 2.8 || (simulation.speed < 1 && lineDistance < 9)) {
      return { throttle: false, brake: simulation.speed > 0.25 };
    }
    const target = event.assessment && event.yellowSpeed != null ? Math.min(47, event.yellowSpeed) : 45;
    return {
      throttle: simulation.speed < target - 0.6,
      brake: simulation.speed > target + 0.6
    };
  }

  function defensiveInput(simulation, branch) {
    const event = simulation.currentEvent;
    if (!event) return {};
    if (event.active && !event.rearObserved && event.localTime >= 0.35 && event.localTime < event.yellowAt) {
      simulation.setView('rear');
    } else {
      simulation.setView('front');
    }

    const phase = signalPhase(event);
    const lineDistance = event.stopS - (simulation.distance + C.CAR_LENGTH_M / 2);
    if (lineDistance < 0 && !event.properStop) {
      return { throttle: simulation.speed < 45.5, brake: false };
    }
    if (event.properStop && !event.waitedForGreen) {
      return { throttle: false, brake: simulation.speed > 0.25 };
    }
    if (event.properStop && event.waitedForGreen) {
      return { throttle: simulation.speed < 46.5, brake: false };
    }
    if (phase === 'red' && lineDistance > 0) return stopInput(simulation, event);
    if (!event.assessment) {
      return { throttle: simulation.speed < 46.5, brake: simulation.speed > 48 };
    }

    let choice = event.assessment.stopSafe ? 'stop' : 'proceed';
    if (branch === 'proceed' && event.assessment.proceedSafe) choice = 'proceed';
    if (branch === 'stop' && event.assessment.stopSafe) choice = 'stop';
    if (choice === 'stop') return stopInput(simulation, event);

    const target = Math.max(30, Math.min(48, event.yellowSpeed || 47));
    return {
      throttle: simulation.speed < target - 0.7,
      brake: simulation.speed > target + 0.7
    };
  }

  class Simulation {
    constructor(seed, options) {
      options = options || {};
      this.seed = seed;
      this.plan = createPlan(seed);
      this.events = this.plan.events.map(function (plan) {
        return Object.assign(createRuntimeEvent(plan), plan);
      });
      const hasEventOption = options.eventId != null;
      this.eventIndex = hasEventOption ? options.eventId : 0;
      for (let index = 0; index < this.eventIndex; index += 1) {
        this.events[index].resolved = true;
        this.events[index].observation = 10;
        this.events[index].decisionScore = 3;
        this.events[index].execution = true;
        this.events[index].approachPrepared = true;
        this.events[index].rearObserved = true;
      }
      this.distance = this.events[this.eventIndex].stopS - C.APPROACH_DISTANCE;
      if (!hasEventOption) this.distance = 0;
      this.speed = hasEventOption ? 45 : C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.scoring.rushPenalties = 0;
      this.view = 'front';
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoBranch = 'stop';
      if (options.eventId != null) this.activateEvent(this.currentEvent);
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

    activateEvent(event) {
      if (!event || event.active) return;
      event.active = true;
      event.localTime = 0;
      event.rear = {
        distance: this.distance - C.CAR_LENGTH_M - event.rearGap,
        speed: this.speed,
        responseTimer: null,
        responseConsumed: false,
        followBraking: false,
        stopped: false
      };
    }

    onYellow(event) {
      if (event.assessment) return;
      event.yellowSpeed = this.speed;
      event.approachPrepared = event.approachTime > 0 &&
        event.approachSpeedIntegral / event.approachTime >= 35 &&
        event.approachSpeedIntegral / event.approachTime <= 55 && event.approachMaxSpeed <= 58;
      event.assessment = assessOptions(this, event);
    }

    updateObservation(event, dt) {
      if (!event.active || event.decisionMade || event.localTime >= event.yellowAt + event.yellowDuration ||
        this.view !== 'rear' || rearGap(this, event) > 70) {
        event.rearScanStreak = 0;
        return;
      }
      event.rearScanStreak += dt;
      if (event.rearScanStreak >= C.REAR_SCAN_DWELL) event.rearObserved = true;
    }

    advanceRear(event, input, dt) {
      const rear = event.rear;
      if (!rear) return;
      if (input.brake && this.previousSpeed > 1 && !rear.responseConsumed) {
        rear.responseConsumed = true;
        rear.responseTimer = event.rearReaction;
      }
      if (rear.responseTimer != null && rear.responseTimer > 0) {
        rear.responseTimer = Math.max(0, rear.responseTimer - dt);
        if (rear.responseTimer <= 0) rear.followBraking = true;
      }

      const gap = rearGap(this, event);
      const rearLineDistance = event.stopS - (rear.distance + C.CAR_LENGTH_M / 2);
      const phase = signalPhase(event);
      const rearSpeedMps = rear.speed / 3.6;
      const rearStopDistance = rearSpeedMps * rearSpeedMps / (2 * C.REAR_COMFORTABLE_BRAKE);
      let signalBrake = false;
      if (rearLineDistance > 0 && phase !== 'green') {
        const yellowRemaining = event.yellowAt + event.yellowDuration - event.localTime;
        const cannotEnter = phase === 'red' || rearLineDistance / Math.max(0.5, rearSpeedMps) > yellowRemaining;
        signalBrake = cannotEnter && rearLineDistance <= rearStopDistance + 8;
      }
      const followBrake = rear.followBraking &&
        (this.speed < 0.5 || rear.speed > this.speed + 0.8 || gap < event.rearGap + 2);
      const gapBrake = gap < Math.max(2.2, event.rearGap - 1.5) && rear.speed > this.speed - 0.5;
      let acceleration = -C.REAR_NATURAL_DECELERATION;
      if (signalBrake || followBrake || gapBrake) {
        acceleration = -(gap < 2.5 ? C.REAR_MAX_BRAKE : C.REAR_COMFORTABLE_BRAKE);
      } else if (gap > event.rearGap + 4 && rear.speed < this.speed + 1) {
        acceleration = C.REAR_ACCELERATION;
      } else if (rear.followBraking && gap > event.rearGap + 5 && rear.speed <= this.speed + 0.8) {
        rear.followBraking = false;
      }
      const oldSpeed = rear.speed / 3.6;
      const nextSpeed = M.clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      rear.speed = nextSpeed * 3.6;
      rear.distance += (oldSpeed + nextSpeed) * 0.5 * dt;
      rear.stopped = rear.speed < 0.35 && this.speed < 0.5 && gap > 0;
      if (event.properStop && rear.stopped) event.rearStoppedSafely = true;
    }

    freeze(event, reason) {
      if (this.status !== 'driving') return;
      event.failed = true;
      event.attempts += 1;
      event.unsafePass = true;
      const assessment = event.assessment || assessOptions(this, event);
      this.freezeInfo = {
        eventId: event.id,
        reason: reason,
        speed: this.speed,
        lineDistance: assessment.lineDistance,
        stoppingDistance: assessment.stoppingDistance,
        rearGap: rearGap(this, event),
        branch: event.branch
      };
      this.status = 'frozen';
    }

    resolveEvent(event) {
      if (event.properStop) {
        event.execution = event.assessment && event.assessment.stopSafe && !event.earlyStart &&
          event.rearStoppedSafely && event.waitedForGreen && !event.enteredAgainstRule;
        event.resolvedBranch = 'stop';
        if (event.assessment && !event.assessment.stopSafe) event.unsafePass = true;
      } else {
        event.execution = event.decisionMade && event.branch === 'proceeding' && event.assessment &&
          event.assessment.proceedSafe && !event.rushAcceleration && !event.enteredAgainstRule;
        event.resolvedBranch = 'proceed';
        if (event.assessment && !event.assessment.proceedSafe) event.unsafePass = true;
      }
      event.observation = (event.approachPrepared ? 2 : 0) + (event.rearObserved ? 2 : 0) +
        event.decisionScore + (event.execution ? 3 : 0);
      event.resolved = true;
      this.justResolved = event;
      if (this.eventIndex === this.events.length - 1) {
        this.status = 'complete';
        this.speed = 0;
        return;
      }
      this.eventIndex += 1;
      this.view = 'front';
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      if (dt <= 0) return;
      input = input || {};
      this.justHardBrake = false;
      this.justResolved = null;
      const event = this.currentEvent;
      if (!event) return;
      if (!event.active && this.distance >= event.stopS - C.APPROACH_DISTANCE) this.activateEvent(event);

      this.elapsed += dt;
      if (event.active) {
        event.localTime += dt;
        if (!event.assessment && event.localTime < event.yellowAt) {
          event.approachSpeedIntegral += this.speed * dt;
          event.approachTime += dt;
          event.approachMaxSpeed = Math.max(event.approachMaxSpeed, this.speed);
        }
        if (!event.assessment && event.localTime >= event.yellowAt) this.onYellow(event);
      }
      const phase = signalPhase(event);
      if (phase === 'red') event.redSeen = true;
      this.updateObservation(event, dt);

      const previousDistance = this.distance;
      const previousRearDistance = event.rear ? event.rear.distance : null;
      const previousRearSpeed = event.rear ? event.rear.speed : null;
      this.previousSpeed = this.speed;
      const lineBefore = event.stopS - (this.distance + C.CAR_LENGTH_M / 2);
      const emergency = input.brake && phase !== 'green' && lineBefore < 10 && lineBefore > -2 && this.speed > 20;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle && !input.brake) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = -(emergency ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);
      this.acceleration = acceleration;
      const oldSpeed = this.speed / 3.6;
      const nextSpeed = M.clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      this.speed = nextSpeed * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeed - nextSpeed) / dt);
      this.distance += (oldSpeed + nextSpeed) * 0.5 * dt;
      this.advanceRear(event, input, dt);

      const gap = rearGap(this, event);
      event.minRearGap = Math.min(event.minRearGap, gap);
      if (gap <= 0.05) {
        this.distance = previousDistance;
        this.speed = this.previousSpeed;
        if (event.rear) {
          event.rear.distance = previousRearDistance;
          event.rear.speed = previousRearSpeed;
        }
        this.freeze(event, 'rear');
        return;
      }

      const frontBefore = previousDistance + C.CAR_LENGTH_M / 2;
      const frontAfter = this.distance + C.CAR_LENGTH_M / 2;
      if (frontBefore <= event.stopS && frontAfter > event.stopS) {
        if (phase === 'red') {
          event.enteredAgainstRule = true;
          this.freeze(event, 'redEntry');
          return;
        }
        if (!event.decisionMade) {
          event.decisionMade = true;
          event.branch = 'proceeding';
          event.decisionScore = event.assessment && event.assessment.proceedSafe ? 3 : 0;
        }
      }

      const lineDistance = event.stopS - frontAfter;
      if (lineDistance >= 0.15 && lineDistance <= 9 && this.speed < 0.35) {
        event.stopDuration += dt;
        if (event.stopDuration >= C.STOP_HOLD_TIME && !event.properStop) {
          event.properStop = true;
          event.stoppedDistance = this.distance;
          if (!event.decisionMade) {
            event.decisionMade = true;
            event.branch = 'stopping';
            event.decisionScore = event.assessment && event.assessment.stopSafe ? 3 : 0;
          }
        }
      } else if (!event.properStop) {
        event.stopDuration = 0;
      }
      if (event.properStop && event.redSeen && phase === 'green' && this.speed < 0.5) event.waitedForGreen = true;
      if (event.properStop && event.waitedForGreen && this.speed >= 40) event.resumeSpeedReached = true;
      if (event.properStop && !event.waitedForGreen && this.speed > 2) event.earlyStart = true;
      if (event.properStop && event.rear && event.rear.stopped) event.rearStoppedSafely = true;

      if (event.assessment && event.localTime > event.yellowAt + 0.35 && input.throttle &&
        this.speed > event.yellowSpeed + 2 && !event.rushAcceleration) {
        event.rushAcceleration = true;
        this.scoring.rushPenalties += 1;
      }

      if (event.localTime >= event.crossReleaseAt && frontAfter > event.stopS &&
        this.distance - C.CAR_LENGTH_M / 2 < event.conflictEndS && phase === 'red') {
        this.freeze(event, 'cross');
        return;
      }

      Scoring.recordStep(this.scoring, this, dt);
      if (this.distance - C.CAR_LENGTH_M / 2 > event.conflictEndS) {
        this.resolveEvent(event);
        if (this.status === 'complete') return;
      }
      if (this.elapsed >= C.MAX_TIME) {
        this.speed = 0;
        this.status = 'timeout';
      }
    }

    retryEvent() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.demoEventId != null ? this.demoEventId : this.eventIndex);
      this.eventIndex = eventId;
      const event = this.events[eventId];
      const preserved = { failed: event.failed, attempts: event.attempts, resolved: false };
      Object.keys(event).forEach(function (key) { delete event[key]; });
      Object.assign(event, createRuntimeEvent(this.plan.events[eventId]), this.plan.events[eventId], preserved);
      this.distance = Math.max(0, event.stopS - C.APPROACH_DISTANCE);
      this.speed = 45;
      this.previousSpeed = 45;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.view = 'front';
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.justResolved = null;
      this.activateEvent(event);
      this.status = 'driving';
    }

    startDemo(branch) {
      if (!this.freezeInfo) return;
      const eventId = this.freezeInfo.eventId;
      const demo = new Simulation(this.seed, { eventId: eventId });
      demo.status = 'driving';
      demo.demoBranch = branch === 'proceed' ? 'proceed' : 'stop';
      this.demo = demo;
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.demoBranch = demo.demoBranch;
      this.status = 'demonstrating';
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      const event = this.demo.events[this.demoEventId];
      this.demo.step(defensiveInput(this.demo, this.demoBranch), dt);
      if (event.resolved || this.demo.status === 'frozen' || this.demo.status === 'timeout' || this.demoTime >= 40) {
        this.retryEvent();
      }
    }
  }

  const Scoring = {
    eventObservation: function (event) {
      return event.observation || ((event.approachPrepared ? 2 : 0) + (event.rearObserved ? 2 : 0) +
        event.decisionScore + (event.execution ? 3 : 0));
    },

    eventSafe: function (event) {
      return event.resolved && !event.failed && !event.unsafePass && !event.enteredAgainstRule && event.minRearGap > 0.05;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || !event.active) return false;
      const lineDistance = event.stopS - (simulation.distance + C.CAR_LENGTH_M / 2);
      const phase = signalPhase(event);
      if (event.properStop && !event.waitedForGreen) return true;
      if (event.properStop && event.waitedForGreen && !event.resumeSpeedReached && simulation.speed < 40) return true;
      if (lineDistance < -1 || lineDistance > C.APPROACH_DISTANCE + 2) return false;
      if (simulation.speed < 0.8 && phase === 'red') return true;
      if (event.assessment && event.assessment.stopSafe && (phase === 'yellow' || phase === 'red') &&
        !event.decisionMade) return true;
      return false;
    },

    recordStep: function (state, simulation, dt) {
      const event = simulation.currentEvent;
      if (!Scoring.isYieldExempt(simulation)) {
        const quality = Game.Scoring.speedQuality(simulation.speed, false);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const harsh = simulation.lastDeceleration > C.HARD_BRAKE && simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED;
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

    summarize: function (simulation, timedOut) {
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(Scoring.eventSafe);
      const observation = resolved.reduce(function (sum, event) { return sum + Scoring.eventObservation(event); }, 0);
      const safety = Math.round(clean.length * 40 / 3);
      const state = simulation.scoring;
      const efficiency = state.efficiencyTime > 0 ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
      const smooth = Math.max(0, 10 - state.hardBrakes * 2 - state.rushPenalties * 2);
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
        summaryKey = 'scene.yellow.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.yellow.result.advice.default';
      if (failed) adviceKey = 'scene.yellow.result.advice.failed';
      else if (simulation.events.some(function (event) { return event.rushAcceleration; })) adviceKey = 'scene.yellow.result.advice.rush';
      else if (observation < 28) adviceKey = 'scene.yellow.result.advice.observation';
      else if (state.hardBrakes) adviceKey = 'result.advice.braking';
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
        earlySlowCount: simulation.events.filter(function (event) { return event.rearObserved; }).length,
        passedCount: clean.length,
        timedOut: Boolean(timedOut),
        failed: failed,
        adviceKey: adviceKey
      };
    }
  };

  function worldY(simulation, position) {
    return Draw.worldY(C, simulation, position);
  }

  function drawSignal(ctx, x, y, phase) {
    Draw.rect(ctx, '#14232b', x, y, 14, 35);
    Draw.rect(ctx, phase === 'red' ? '#ff6459' : '#603b3b', x + 3, y + 3, 8, 8);
    Draw.rect(ctx, phase === 'yellow' ? '#ffd166' : '#5c583b', x + 3, y + 13, 8, 8);
    Draw.rect(ctx, phase === 'green' ? '#80e0b1' : '#315148', x + 3, y + 24, 8, 8);
  }

  function drawCrossCar(ctx, x, y, direction, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(direction > 0 ? Math.PI / 2 : -Math.PI / 2);
    Draw.drawCar(ctx, 0, 0, color, false);
    ctx.restore();
  }

  function drawIntersection(ctx, simulation, event) {
    const stopY = worldY(simulation, event.stopS);
    const endY = worldY(simulation, event.conflictEndS);
    if (stopY < -100 || endY > C.HEIGHT + 100) return;
    const centerY = worldY(simulation, event.stopS + C.CONFLICT_DEPTH / 2);
    Draw.rect(ctx, '#a9aa96', 0, endY - 30, C.WIDTH, stopY - endY + 68);
    Draw.rect(ctx, '#3b484b', 0, endY - 18, C.WIDTH, stopY - endY + 44);
    for (let x = 12; x < C.WIDTH; x += 40) {
      Draw.rect(ctx, '#697773', x, centerY, 22, 3);
    }
    for (let x = 176; x < 246; x += 16) {
      Draw.rect(ctx, '#d8dcd2', x, stopY - 8, 9, 17);
    }
    Draw.rect(ctx, '#f0ead2', 176, stopY + 12, 68, 3);
    const phase = signalPhase(event);
    drawSignal(ctx, 251, stopY - 38, phase);
    Draw.rect(ctx, '#132633cc', 270, stopY - 28, 66, 17);
    Draw.fillFittedText(ctx, t('scene.yellow.canvas.' + phase), 274, stopY - 16, 58, 8, 'sans-serif');

    if (event.active && event.localTime >= event.crossReleaseAt && event.localTime < event.greenAt) {
      const travel = (event.localTime - event.crossReleaseAt) * 72;
      drawCrossCar(ctx, -30 + travel, centerY - 17, 1, '#7fa6b2');
      drawCrossCar(ctx, 390 - travel, centerY + 19, -1, '#d7b957');
    } else {
      drawCrossCar(ctx, 60, centerY - 17, 1, '#7fa6b2');
      drawCrossCar(ctx, 300, centerY + 19, -1, '#d7b957');
    }
  }

  function drawRearCar(ctx, simulation, event) {
    if (!event.rear) return;
    const y = worldY(simulation, event.rear.distance);
    if (y < -50 || y > C.HEIGHT + 50) return;
    Draw.drawCar(ctx, C.CAR_X, y, event.rearColor, false);
    if (event.rear.followBraking) {
      Draw.rect(ctx, '#ff665c', C.CAR_X - 11, y - 21, 7, 4);
      Draw.rect(ctx, '#ff665c', C.CAR_X + 4, y - 21, 7, 4);
    }
  }

  function drawRearInset(ctx, simulation, event) {
    if (simulation.view !== 'rear' || !event.rear) return;
    Draw.rect(ctx, '#0c1b24ee', 102, 108, 156, 145);
    Draw.rect(ctx, '#3b484b', 152, 116, 56, 103);
    Draw.rect(ctx, '#91a18a66', 179, 116, 2, 103);
    Draw.drawCar(ctx, C.CAR_X, 137, '#e7685b', false);
    const gap = rearGap(simulation, event);
    const rearY = 174 + Math.min(42, Math.max(0, gap) * 1.4);
    Draw.drawCar(ctx, C.CAR_X, rearY, event.rearColor, false);
    Draw.fillFittedText(ctx, t('scene.yellow.canvas.rearGap', { gap: Math.max(0, Math.round(gap)) }),
      111, 240, 138, 9, 'sans-serif');
  }

  function drawWorld(ctx, simulation, demo) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    Draw.drawEnvironment(ctx, simulation, C, 172);
    drawIntersection(ctx, simulation, event);
    drawRearCar(ctx, simulation, event);
    Draw.drawCar(ctx, C.CAR_X, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    if (simulation.lastDeceleration > 0.8) {
      Draw.rect(ctx, '#ff665c', C.CAR_X - 11, C.CAR_Y + 19, 7, 4);
      Draw.rect(ctx, '#ff665c', C.CAR_X + 4, C.CAR_Y + 19, 7, 4);
    }
    drawRearInset(ctx, simulation, event);
    Draw.rect(ctx, '#132633dd', 102, 603, 156, 23);
    Draw.fillFittedText(ctx, t('scene.yellow.canvas.' + signalPhase(event)), 114, 618, 132, 9, 'sans-serif');
    if (demo && event.assessment) {
      Draw.rect(ctx, '#0e202ddd', 15, 548, 330, 43);
      const key = event.properStop ? 'scene.yellow.canvas.demoWait' :
        (event.assessment.stopSafe && simulation.demoBranch !== 'proceed' ? 'scene.yellow.canvas.demoStop' : 'scene.yellow.canvas.demoProceed');
      Draw.fillFittedText(ctx, t(key), 24, 570, 312, 10, 'sans-serif');
    }
    if (simulation.status === 'frozen') {
      Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
      Draw.rect(ctx, '#fff0b0', C.CAR_X + 24, C.CAR_Y - 25, 22, 24);
      Draw.rect(ctx, '#3b2a0e', C.CAR_X + 33, C.CAR_Y - 21, 4, 10);
      Draw.rect(ctx, '#3b2a0e', C.CAR_X + 33, C.CAR_Y - 8, 4, 4);
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        drawWorld(ctx, simulation.demo, true);
      } else {
        drawWorld(ctx, simulation, false);
      }
    }
  };

  const Scene = {
    id: 'yellow-light-decision',
    Constants: C,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    createPlan: createPlan,
    signalPhase: signalPhase,
    assessOptions: assessOptions,
    rearGap: rearGap,
    defensiveInput: defensiveInput,
    ui: {
      progress: function (simulation) {
        return t('scene.yellow.hud.progress', {
          resolved: simulation.events.filter(function (event) { return event.resolved; }).length
        });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.decisionScore === 3; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(Scoring.eventSafe).length
        ];
      },
      smoothScore: function (simulation) {
        return Math.max(0, 10 - simulation.scoring.hardBrakes * 2 - simulation.scoring.rushPenalties * 2);
      },
      coach: function (simulation) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (!event || !event.active) {
          return { text: t('scene.yellow.hud.cruise'), status: t('hud.cruiseGood'), coachTone: '', tone: '' };
        }
        const phase = signalPhase(event);
        if (event.properStop && !event.waitedForGreen) {
          return { text: t('scene.yellow.hud.wait'), status: t('scene.yellow.hud.stopped'), coachTone: 'good', tone: '' };
        }
        if (event.properStop && event.waitedForGreen) {
          return { text: t('scene.yellow.hud.resume'), status: t('scene.yellow.hud.proceedStatus'), coachTone: 'good', tone: '' };
        }
        if (phase === 'red') {
          return { text: t('scene.yellow.hud.red'), status: t('hud.prepareStop'), coachTone: 'risk', tone: 'warn' };
        }
        if (phase === 'yellow') {
          return { text: t('scene.yellow.hud.yellow'), status: t('scene.yellow.hud.judge'), coachTone: 'risk', tone: 'warn' };
        }
        if (!event.rearObserved && event.localTime < event.yellowAt) {
          return { text: t('scene.yellow.hud.observe'), status: t('scene.yellow.hud.observeStatus'), coachTone: 'risk', tone: '' };
        }
        return { text: t('scene.yellow.hud.cruise'), status: t('hud.cruiseGood'), coachTone: '', tone: '' };
      },
      retryToast: function () {
        return { key: 'scene.yellow.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        const dual = event.assessment && event.assessment.stopSafe && event.assessment.proceedSafe;
        return {
          key: score === 10 && dual ? 'scene.yellow.toast.dual' :
            (score === 10 ? 'scene.yellow.toast.safe' : 'scene.yellow.toast.improve'),
          params: { score: score },
          neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.yellow.failure.' + info.reason, {
          speed: Math.round(info.speed),
          remaining: Math.max(0, info.lineDistance).toFixed(1),
          distance: Math.round(info.stoppingDistance),
          gap: Math.max(0, info.rearGap).toFixed(1)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo && demo.currentEvent;
        if (!event) return { step: '', substep: '' };
        if (!event.assessment) {
          return { step: t('scene.yellow.demo.observe'), substep: t('scene.yellow.demo.observeSub') };
        }
        if (event.properStop && !event.waitedForGreen) {
          return { step: t('scene.yellow.demo.wait'), substep: t('scene.yellow.demo.waitSub') };
        }
        if (event.resolvedBranch === 'proceed' || (simulation.demoBranch === 'proceed' && !event.properStop)) {
          return { step: t('scene.yellow.demo.proceed'), substep: t('scene.yellow.demo.proceedSub') };
        }
        if (event.assessment.stopSafe) {
          return { step: t('scene.yellow.demo.stop'), substep: t('scene.yellow.demo.stopSub') };
        }
        return { step: t('scene.yellow.demo.proceed'), substep: t('scene.yellow.demo.proceedSub') };
      },
      updateControls: function (doc, simulation) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        doc.querySelectorAll('[data-view]').forEach(function (button) {
          const active = button.dataset.view === current.view;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', String(active));
          button.disabled = simulation.status !== 'driving';
        });
        const proceedButton = doc.getElementById('demo-proceed-button');
        if (proceedButton) {
          const event = simulation.freezeInfo ? simulation.events[simulation.freezeInfo.eventId] : null;
          proceedButton.hidden = !(event && event.assessment && event.assessment.proceedSafe);
        }
      }
    },

    bindControls: function (doc, getSimulation) {
      doc.querySelectorAll('[data-view]').forEach(function (button) {
        button.addEventListener('click', function () { getSimulation().setView(button.dataset.view); });
      });
      doc.addEventListener('keydown', function (event) {
        const index = ['1', '2'].indexOf(event.key);
        if (index >= 0 && getSimulation().status === 'driving') {
          getSimulation().setView(VIEWS[index]);
          event.preventDefault();
        }
      });
    }
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
