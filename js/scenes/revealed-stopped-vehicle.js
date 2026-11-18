(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;
  const t = function (key, params) { return Game.I18N.t(key, params); };

  const C = Object.assign({}, Game.C, {
    PLAYER_X: 0,
    PLAYER_SCREEN_X: 216,
    PLAYER_SCREEN_WIDTH: 28,
    PLAYER_SCREEN_LENGTH: 44,
    LEFT_LANE_X: -4.1,
    X_PIXELS_PER_METER: 18,
    PLAYER_LENGTH: 4.2,
    PLAYER_WIDTH: 1.8,
    EYE_FORWARD: 1.25,
    START_SPEED: 48,
    MAX_SPEED: 60,
    MAX_TIME: 115,
    STOP_SPEED: 0.35,
    STOP_DWELL: 0.38,
    COMFORT_BRAKE: 3.5,
    EMERGENCY_BRAKE: 6.4,
    HARD_BRAKE: 4.7,
    TARGET_BUFFER: 7,
    CLOSE_BUFFER: 2.2,
    FAR_BUFFER: 24,
    STABLE_VISIBLE_TIME: 0.3,
    CLEAR_CONFIRM_TIME: 0.55,
    EVENT_SPACING: 720,
    PIXELS_PER_METER: 5.2
  });

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function smoothstep(value) {
    const x = clamp(value, 0, 1);
    return x * x * (3 - 2 * x);
  }
  function shuffle(items, random) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      const swap = result[index]; result[index] = result[other]; result[other] = swap;
    }
    return result;
  }
  function range(random, min, max) { return min + random() * (max - min); }

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed(seed));
    const templates = shuffle(['early-reveal', 'late-reveal', 'clear-reveal'], random);
    const colors = ['#d7b957', '#79a8b7', '#c98568', '#a4b68a'];
    const events = templates.map(function (template, id) {
      const startS = id * C.EVENT_SPACING;
      const initialPlayerSpeed = range(random, 47, 51);
      const initialLeaderGap = range(random, 29, 35);
      const leaderSpeed = range(random, 44, 48.5);
      const length = range(random, 4.25, 4.75);
      const width = range(random, 1.82, 1.96);
      const signalAt = range(random, 2.7, 3.5);
      const laneChangeAt = signalAt + range(random, 0.75, 1.0);
      const laneChangeDuration = template === 'late-reveal' ? range(random, 3.0, 3.35) : range(random, 2.35, 2.75);
      const leader = {
        initialS: startS + C.PLAYER_LENGTH / 2 + initialLeaderGap + length / 2,
        length: length,
        width: width,
        speed: leaderSpeed,
        signalAt: signalAt,
        laneChangeAt: laneChangeAt,
        laneChangeDuration: laneChangeDuration,
        targetX: C.LEFT_LANE_X + range(random, -0.08, 0.08),
        color: colors[Math.floor(random() * colors.length)]
      };
      const stoppedLength = range(random, 4.1, 4.65);
      const stoppedWidth = range(random, 1.78, 1.94);
      const revealEstimate = laneChangeAt + laneChangeDuration * 0.57;
      const extraGap = template === 'early-reveal' ? range(random, 43, 52) :
        (template === 'late-reveal' ? range(random, 18, 25) : 0);
      const stoppedS = leader.initialS + leaderSpeed / 3.6 * revealEstimate +
        (length + stoppedLength) / 2 + extraGap;
      return {
        id: id,
        template: template,
        startS: startS,
        finishS: template === 'clear-reveal' ? startS + range(random, 170, 190) : stoppedS,
        initialPlayerSpeed: initialPlayerSpeed,
        initialLeaderGap: initialLeaderGap,
        leader: leader,
        stoppedVehicle: {
          enabled: template !== 'clear-reveal',
          s: stoppedS,
          x: C.PLAYER_X + range(random, -0.12, 0.12),
          length: stoppedLength,
          width: stoppedWidth,
          type: random() < 0.5 ? 'hatchback' : 'sedan',
          color: colors[Math.floor(random() * colors.length)],
          hazardLights: true
        },
        shoulderVariant: Math.floor(random() * 3)
      };
    });
    return { seed: seed, events: events };
  }

  function createRuntimeEvent(plan) {
    return {
      id: plan.id,
      template: plan.template,
      startS: plan.startS,
      finishS: plan.finishS,
      initialPlayerSpeed: plan.initialPlayerSpeed,
      elapsed: 0,
      leader: {
        s: plan.leader.initialS,
        x: C.PLAYER_X,
        speed: plan.leader.speed,
        length: plan.leader.length,
        width: plan.leader.width,
        state: 'CRUISE',
        signal: false,
        color: plan.leader.color,
        targetX: plan.leader.targetX,
        laneChangeAt: plan.leader.laneChangeAt,
        laneChangeDuration: plan.leader.laneChangeDuration
      },
      stopped: plan.stoppedVehicle.enabled ? {
        enabled: true,
        s: plan.stoppedVehicle.s,
        x: plan.stoppedVehicle.x,
        length: plan.stoppedVehicle.length,
        width: plan.stoppedVehicle.width,
        color: plan.stoppedVehicle.color,
        type: plan.stoppedVehicle.type,
        state: 'HAZARD_LIGHTS_ON',
        hazardLights: true
      } : null,
      visibility: emptyVisibility(),
      cueVisibleAt: null,
      firstResponseAt: null,
      stoppedFirstVisibleAt: null,
      stoppedStableVisibleAt: null,
      clearLaneConfirmedAt: null,
      clearVisibleTime: 0,
      properEarlyControl: false,
      preparation: false,
      followAcceleration: false,
      followAccelerationTime: 0,
      earlyControlTime: 0,
      earlyHeavyBrakeTime: 0,
      responseSpeedDrop: 0,
      speedAtCue: null,
      brakingStartAt: null,
      stoppedAt: null,
      stoppedDwell: 0,
      minimumLeaderGap: Infinity,
      minimumStoppedGap: Infinity,
      revealGap: null,
      revealSpeed: null,
      revealMargin: null,
      closeStop: false,
      farStop: false,
      prematureStop: false,
      matchedAction: false,
      timelyResume: false,
      resumeAt: null,
      hardBrakeRecorded: false,
      failed: false,
      attempts: 0,
      resolved: false,
      observation: 0,
      unnecessaryWait: 0,
      preCueSpeedIntegral: 0,
      preCueTime: 0,
      preCueGapIntegral: 0,
      maxSpeedAfterCue: 0,
      history: []
    };
  }

  function emptyVisibility() {
    return {
      visible: false,
      visibleSamples: 0,
      totalSamples: 0,
      sampleMask: [],
      firstVisibleAt: null,
      continuousVisibleTime: 0,
      stableVisible: false,
      fullyVisible: false,
      occluderId: 'leader'
    };
  }

  function segmentIntersectsAABB(x1, y1, x2, y2, box) {
    let near = 0;
    let far = 1;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - box.left, box.right - x1, y1 - box.bottom, box.top - y1];
    for (let index = 0; index < 4; index += 1) {
      if (Math.abs(p[index]) < 0.0000001) {
        if (q[index] < 0) return false;
      } else {
        const ratio = q[index] / p[index];
        if (p[index] < 0) near = Math.max(near, ratio);
        else far = Math.min(far, ratio);
        if (near > far) return false;
      }
    }
    return true;
  }

  function leaderBox(leader) {
    return {
      left: leader.x - leader.width / 2,
      right: leader.x + leader.width / 2,
      bottom: leader.s - leader.length / 2,
      top: leader.s + leader.length / 2
    };
  }

  function stoppedSamples(stopped) {
    return [
      { x: stopped.x - stopped.width / 2, s: stopped.s - stopped.length / 2 + 0.12 },
      { x: stopped.x + stopped.width / 2, s: stopped.s - stopped.length / 2 + 0.12 },
      { x: stopped.x, s: stopped.s - stopped.length / 2 + 0.35 },
      { x: stopped.x, s: stopped.s + 0.15 },
      { x: stopped.x - stopped.width / 2, s: stopped.s + stopped.length / 2 - 0.25 },
      { x: stopped.x + stopped.width / 2, s: stopped.s + stopped.length / 2 - 0.25 }
    ];
  }

  function visibilityFor(simulation, event) {
    const result = emptyVisibility();
    if (!event.stopped) return result;
    const eye = { x: C.PLAYER_X - 0.28, s: simulation.distance + C.EYE_FORWARD };
    const samples = stoppedSamples(event.stopped);
    const box = leaderBox(event.leader);
    result.totalSamples = samples.length;
    samples.forEach(function (sample, index) {
      const visible = sample.s > eye.s && !segmentIntersectsAABB(eye.x, eye.s, sample.x, sample.s, box);
      result.sampleMask[index] = visible;
      if (visible) result.visibleSamples += 1;
    });
    result.visible = result.visibleSamples > 0;
    result.fullyVisible = result.visibleSamples === samples.length;
    result.firstVisibleAt = event.stoppedFirstVisibleAt;
    result.continuousVisibleTime = event.visibility.continuousVisibleTime;
    result.stableVisible = event.visibility.stableVisible;
    result.occluderId = result.visible ? null : 'leader';
    return result;
  }

  function playerFront(simulation) { return simulation.distance + C.PLAYER_LENGTH / 2; }
  function playerRear(simulation) { return simulation.distance - C.PLAYER_LENGTH / 2; }
  function leaderGap(simulation, event) {
    return event.leader.s - event.leader.length / 2 - playerFront(simulation);
  }
  function stoppedGap(simulation, event) {
    return event.stopped ? event.stopped.s - event.stopped.length / 2 - playerFront(simulation) : Infinity;
  }
  function rectanglesOverlap(simulation, vehicle) {
    const longitudinal = Math.abs(vehicle.s - simulation.distance) < (vehicle.length + C.PLAYER_LENGTH) / 2;
    const lateral = Math.abs(vehicle.x - C.PLAYER_X) < (vehicle.width + C.PLAYER_WIDTH) / 2;
    return longitudinal && lateral;
  }
  function stoppingDistance(speedKmh, deceleration) {
    const speed = Math.max(0, speedKmh / 3.6);
    return speed * speed / (2 * (deceleration || C.COMFORT_BRAKE));
  }
  function assessStoppingMargin(simulation, event) {
    const gap = stoppedGap(simulation, event);
    return {
      gap: gap,
      available: gap - C.TARGET_BUFFER,
      required: stoppingDistance(simulation.speed, C.COMFORT_BRAKE),
      margin: gap - C.TARGET_BUFFER - stoppingDistance(simulation.speed, C.COMFORT_BRAKE)
    };
  }

  function updateLeader(event, elapsed) {
    const leader = event.leader;
    leader.s = event.plan.leader.initialS + leader.speed / 3.6 * elapsed;
    leader.signal = elapsed >= event.plan.leader.signalAt;
    if (elapsed < event.plan.leader.signalAt) leader.state = 'CRUISE';
    else if (elapsed < leader.laneChangeAt) leader.state = 'SIGNALING';
    else if (elapsed < leader.laneChangeAt + leader.laneChangeDuration) leader.state = 'CHANGING_LEFT';
    else leader.state = 'LEFT_LANE_CRUISE';
    const progress = smoothstep((elapsed - leader.laneChangeAt) / leader.laneChangeDuration);
    leader.x = M.lerp(C.PLAYER_X, leader.targetX, progress);
    if (leader.s + 80 < event.startS) leader.state = 'CLEARED';
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    if (!event) return { throttle: simulation.speed < 47, brake: false };
    let target = 48;
    const cue = event.elapsed >= event.plan.leader.signalAt;
    if (cue && !event.visibility.stableVisible && event.clearLaneConfirmedAt == null) target = 39;
    if (event.stopped && event.visibility.visible) {
      const gap = Math.max(0, stoppedGap(simulation, event) - C.TARGET_BUFFER);
      const stoppingSpeed = Math.sqrt(Math.max(0, 2 * 3.15 * gap)) * 3.6;
      target = Math.min(target, stoppingSpeed);
      if (gap < 0.5 || simulation.speed < 1) target = 0;
    }
    if (!event.stopped && event.clearLaneConfirmedAt != null) target = 48;
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
      this.plan = createPlan(seed);
      this.events = this.plan.events.map(function (plan) {
        const event = createRuntimeEvent(plan);
        event.plan = plan;
        return event;
      });
      this.distance = 0;
      this.speed = C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.necessaryBraking = false;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoMode = 'driver';
      this.replayReturnStatus = null;
      this.replayPerspective = 'driver';
      this.retryCount = 0;
      this.transitionCount = 0;
      this.isolatedEvent = Boolean(options && options.eventId != null);
      this.startEventId = this.isolatedEvent ? options.eventId : 0;
      this.resetToEvent(this.startEventId, false);
    }

    resetToEvent(eventId, preserveStatus) {
      const event = this.events[eventId];
      if (!event) return;
      this.distance = event.startS;
      this.speed = event.initialPlayerSpeed;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.justResolved = null;
      this.necessaryBraking = false;
      if (!preserveStatus) this.status = this.status === 'ready' ? 'ready' : 'driving';
    }

    start() { this.status = 'driving'; }
    get currentEvent() {
      return this.events.find(function (event) {
        return !event.resolved && (!this.isolatedEvent || event.id === this.startEventId);
      }, this) || null;
    }
    get eventIndex() { const event = this.currentEvent; return event ? event.id : this.events.length - 1; }
    getRiskEvent() { return Scoring.getRiskEvent(this); }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      if (dt <= 0) return;
      input = input || {};
      this.justHardBrake = false;
      this.justResolved = null;
      this.previousSpeed = this.speed;
      const event = this.currentEvent;
      if (!event) { this.status = 'complete'; return; }

      const acceleration = input.brake ? -C.BRAKE_DECELERATION :
        (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
      this.acceleration = acceleration;
      const conflict = this.predictConflict(event, input);
      if (conflict) { this.freeze(event, conflict); return; }

      const oldSpeed = this.speed / 3.6;
      let nextSpeed = clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      if (!input.throttle && !input.brake && this.speed < 0.8) nextSpeed = 0;
      if (input.brake && nextSpeed < 0.08) nextSpeed = 0;
      this.speed = nextSpeed * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeed - nextSpeed) / dt);
      this.distance += (oldSpeed + nextSpeed) * 0.5 * dt;
      this.elapsed += dt;
      event.elapsed += dt;
      updateLeader(event, event.elapsed);
      this.updateEvent(event, dt, input);
      Scoring.recordStep(this.scoring, this, dt);

      if (!event.resolved && event.stopped && rectanglesOverlap(this, event.stopped)) {
        this.freeze(event, 'stopped'); return;
      }
      if (!event.resolved && rectanglesOverlap(this, event.leader)) {
        this.freeze(event, 'leader'); return;
      }
      if (!event.resolved) this.checkResolution(event, dt);
      if (event.resolved) this.advanceAfterResolution(event);
      else if (this.elapsed >= C.MAX_TIME) {
        this.speed = 0;
        this.status = 'timeout';
      }
    }

    updateEvent(event, dt, input) {
      const gapBefore = Math.min(leaderGap(this, event), event.minimumLeaderGap);
      event.minimumLeaderGap = gapBefore;
      if (event.stopped) event.minimumStoppedGap = Math.min(event.minimumStoppedGap, stoppedGap(this, event));
      if (event.elapsed < event.plan.leader.signalAt) {
        event.preCueTime += dt;
        event.preCueSpeedIntegral += this.speed * dt;
        event.preCueGapIntegral += Math.max(0, leaderGap(this, event)) * dt;
      }
      if (event.cueVisibleAt == null && event.leader.signal) {
        event.cueVisibleAt = event.elapsed;
        event.speedAtCue = this.speed;
      }
      if (event.cueVisibleAt != null) {
        event.maxSpeedAfterCue = Math.max(event.maxSpeedAfterCue, this.speed);
        if (event.visibility.stableVisible || event.clearLaneConfirmedAt != null) {
          // Confirmation phase is scored below.
        } else {
          if (!input.throttle && (input.brake || this.speed <= (event.speedAtCue || this.speed) + 0.5)) {
            event.earlyControlTime += dt;
            if (input.brake) event.earlyHeavyBrakeTime += dt;
            if (event.firstResponseAt == null) event.firstResponseAt = event.elapsed;
          }
          if (input.throttle && this.speed > (event.speedAtCue || 0) + 0.8) {
            event.followAccelerationTime += dt;
            if (event.followAccelerationTime >= 0.35) event.followAcceleration = true;
          }
          event.responseSpeedDrop = Math.max(event.responseSpeedDrop, (event.speedAtCue || this.speed) - this.speed);
        }
      }
      if (input.brake && event.brakingStartAt == null && event.cueVisibleAt != null) event.brakingStartAt = event.elapsed;
      event.preparation = event.preCueTime > 0 && event.preCueSpeedIntegral / event.preCueTime >= 39 &&
        event.preCueSpeedIntegral / event.preCueTime <= 55 && event.preCueGapIntegral / event.preCueTime >= 17;
      event.properEarlyControl = event.earlyControlTime >= 0.35 && event.responseSpeedDrop >= 1.1 &&
        event.earlyHeavyBrakeTime < 1.15 && !event.followAcceleration;

      const previous = event.visibility;
      const visibility = visibilityFor(this, event);
      visibility.continuousVisibleTime = visibility.visible ? previous.continuousVisibleTime + dt : 0;
      visibility.stableVisible = visibility.visibleSamples >= 3 && visibility.continuousVisibleTime >= C.STABLE_VISIBLE_TIME;
      visibility.firstVisibleAt = previous.firstVisibleAt;
      event.visibility = visibility;
      if (event.stopped && visibility.visible && event.stoppedFirstVisibleAt == null) {
        event.stoppedFirstVisibleAt = event.elapsed;
        visibility.firstVisibleAt = event.elapsed;
      }
      if (event.stopped && visibility.stableVisible && event.stoppedStableVisibleAt == null) {
        event.stoppedStableVisibleAt = event.elapsed;
        event.revealGap = stoppedGap(this, event);
        event.revealSpeed = this.speed;
        event.revealMargin = assessStoppingMargin(this, event).margin;
      }
      if (!event.stopped && event.leader.state === 'LEFT_LANE_CRUISE') {
        event.clearVisibleTime += dt;
        if (event.clearVisibleTime >= C.CLEAR_CONFIRM_TIME && event.clearLaneConfirmedAt == null) {
          event.clearLaneConfirmedAt = event.elapsed;
        }
      }
      if (event.stopped && this.speed <= C.STOP_SPEED && !event.visibility.stableVisible) {
        event.prematureStop = true;
      }
      if (event.clearLaneConfirmedAt != null && event.resumeAt == null && this.speed >= 42) {
        event.resumeAt = event.elapsed;
        event.timelyResume = event.resumeAt - event.clearLaneConfirmedAt <= 4.5;
      }
      if (event.clearLaneConfirmedAt != null && this.speed < 8) event.unnecessaryWait += dt;
      if (event.elapsed - (event.cueVisibleAt || 0) < 18 || event.history.length === 0 ||
        event.elapsed - event.history[event.history.length - 1].at >= 0.25) {
        event.history.push({
          at: event.elapsed,
          distance: this.distance,
          speed: this.speed,
          leaderS: event.leader.s,
          leaderX: event.leader.x,
          leaderGap: leaderGap(this, event),
          stoppedGap: stoppedGap(this, event),
          visibleSamples: event.visibility.visibleSamples
        });
      }
    }

    checkResolution(event, dt) {
      if (event.stopped) {
        if (this.speed <= C.STOP_SPEED && stoppedGap(this, event) > 0 && event.visibility.stableVisible) {
          event.stoppedDwell += dt;
        } else event.stoppedDwell = 0;
        if (event.stoppedDwell >= C.STOP_DWELL) {
          event.stoppedAt = event.elapsed;
          event.closeStop = stoppedGap(this, event) < C.CLOSE_BUFFER;
          event.farStop = stoppedGap(this, event) > C.FAR_BUFFER;
          event.matchedAction = !event.closeStop && !event.farStop && !event.prematureStop &&
            event.stoppedStableVisibleAt != null && event.brakingStartAt != null;
          this.resolveEvent(event);
        }
      } else if (this.distance >= event.finishS) {
        event.matchedAction = event.clearLaneConfirmedAt != null && event.timelyResume && this.speed >= 38;
        this.resolveEvent(event);
      }
    }

    resolveEvent(event) {
      event.resolved = true;
      event.observation = Scoring.eventObservation(event);
      if (event.stopped) event.stopped.state = 'EVENT_RESOLVED';
      this.justResolved = event;
    }

    advanceAfterResolution(event) {
      if (this.isolatedEvent || event.id === this.events.length - 1) {
        this.speed = 0;
        this.status = 'complete';
        return;
      }
      this.transitionCount += 1;
      this.resetToEvent(event.id + 1, true);
    }

    predictConflict(event, input) {
      if (this.speed < 0.05) return null;
      // First check the selected pedal for an immediate contact. Then check whether
      // even full braking can still avoid both vehicles; avoidable stops stay playable.
      if (this.pathContacts(event, input, 0.22)) return this.speed > 8 ? 'trajectory' : null;
      const emergency = { throttle: false, brake: true };
      if (this.pathContacts(event, emergency, 5.5, true)) return event.stopped && stoppedGap(this, event) < leaderGap(this, event) + 5 ? 'stopped' : 'leader';
      return null;
    }

    pathContacts(event, input, horizon, emergency) {
      let distance = this.distance;
      let speed = this.speed / 3.6;
      let elapsed = event.elapsed;
      const acceleration = input.brake ? -(emergency ? C.EMERGENCY_BRAKE : C.BRAKE_DECELERATION) :
        (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
      const substep = 0.025;
      for (let time = 0; time < horizon - 0.000001; time += substep) {
        const slice = Math.min(substep, horizon - time);
        const nextSpeed = clamp(speed + acceleration * slice, 0, C.MAX_SPEED / 3.6);
        distance += (speed + nextSpeed) * 0.5 * slice;
        speed = nextSpeed;
        elapsed += slice;
        const predicted = { plan: event.plan, leader: Object.assign({}, event.leader) };
        updateLeader(predicted, elapsed);
        const pseudo = { distance: distance };
        if (rectanglesOverlap(pseudo, predicted.leader)) return 'leader';
        if (event.stopped && rectanglesOverlap(pseudo, event.stopped)) return 'stopped';
        if (speed <= 0) break;
      }
      return null;
    }

    freeze(event, reason) {
      if (this.status !== 'driving') return;
      event.failed = true;
      event.attempts += 1;
      this.retryCount += 1;
      this.status = 'frozen';
      const margin = event.stopped ? assessStoppingMargin(this, event) : null;
      this.freezeInfo = {
        eventId: event.id,
        reason: reason || 'stopped',
        speed: this.speed,
        elapsed: event.elapsed,
        leaderGap: leaderGap(this, event),
        stoppedGap: stoppedGap(this, event),
        stoppingDistance: stoppingDistance(this.speed, C.EMERGENCY_BRAKE),
        available: margin ? margin.available : null,
        cueVisibleAt: event.cueVisibleAt,
        firstResponseAt: event.firstResponseAt,
        firstVisibleAt: event.stoppedFirstVisibleAt,
        stableVisibleAt: event.stoppedStableVisibleAt,
        followAcceleration: event.followAcceleration,
        preparation: event.preparation,
        leaderState: event.leader.state
      };
    }

    retryEvent() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId : (this.demoEventId == null ? this.eventIndex : this.demoEventId);
      const old = this.events[eventId];
      const fresh = createRuntimeEvent(this.plan.events[eventId]);
      fresh.plan = this.plan.events[eventId];
      fresh.failed = old.failed;
      fresh.attempts = old.attempts;
      this.events[eventId] = fresh;
      this.freezeInfo = null;
      this.demo = null;
      this.demoEventId = null;
      this.demoTime = 0;
      this.demoMode = 'driver';
      this.replayReturnStatus = null;
      this.status = 'driving';
      this.resetToEvent(eventId, true);
    }

    makeDemo(eventId) {
      return new Simulation(this.seed, { eventId: eventId });
    }

    startDemo() {
      if (!this.freezeInfo) return;
      this.demoEventId = this.freezeInfo.eventId;
      this.demo = this.makeDemo(this.demoEventId);
      this.demo.start();
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
      this.demo.start();
      this.demoTime = 0;
      this.demoMode = 'overview';
      this.replayPerspective = 'driver';
      this.justResolved = null;
      this.status = 'demonstrating';
    }

    finishReplay() {
      if (this.demoMode !== 'overview') return;
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
      const replayDone = this.demoMode === 'overview' && event.resolved && this.demoTime > 2;
      if (demo.status === 'frozen' || demo.status === 'timeout' || replayDone ||
        (this.demoMode === 'driver' && (event.resolved || demo.status === 'complete')) || this.demoTime >= 38) {
        if (this.demoMode === 'overview') this.finishReplay();
        else this.retryEvent();
      }
    }
  }

  const Scoring = {
    getRiskEvent: function (simulation) {
      const event = simulation.currentEvent;
      if (!event) return null;
      if (event.stopped && event.visibility.visible && stoppedGap(simulation, event) < 80) return event;
      if (!event.stopped && event.clearLaneConfirmedAt != null) return event;
      return null;
    },
    isNecessaryPhase: function (simulation) {
      const event = simulation.currentEvent;
      if (!event) return false;
      if (event.stopped && event.visibility.visible && stoppedGap(simulation, event) <= 82) return true;
      if (event.cueVisibleAt != null && !event.stopped && event.clearLaneConfirmedAt == null &&
        event.elapsed - event.cueVisibleAt <= 4.5) return true;
      return false;
    },
    recordStep: function (state, simulation, dt) {
      const event = simulation.currentEvent;
      const necessary = Scoring.isNecessaryPhase(simulation);
      simulation.necessaryBraking = necessary;
      if (!necessary) {
        let quality = Game.Scoring.speedQuality(simulation.speed, false);
        if (event && event.cueVisibleAt != null && event.followAcceleration) quality = Math.min(quality, 0.45);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const necessaryLateBrake = event && event.template === 'late-reveal' && event.properEarlyControl &&
        event.visibility.stableVisible && stoppedGap(simulation, event) > 0;
      const harsh = simulation.lastDeceleration > C.HARD_BRAKE && simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED &&
        !necessaryLateBrake;
      if (harsh && state.hardBrakeCooldown <= 0) {
        state.hardBrakeDuration += dt;
        if (state.hardBrakeDuration >= 0.15) {
          state.hardBrakes += 1;
          state.hardBrakeDuration = 0;
          state.hardBrakeCooldown = 1.2;
          simulation.justHardBrake = true;
          if (event) event.hardBrakeRecorded = true;
        }
      } else if (!harsh) state.hardBrakeDuration = 0;
    },
    eventObservation: function (event) {
      const preparation = event.preparation ? 3 : 0;
      const response = event.properEarlyControl ? 3 : 0;
      const action = event.matchedAction ? 4 : 0;
      return preparation + response + action;
    },
    eventSafe: function (event) { return !event.failed && !event.closeStop; },
    smoothScore: function (simulation) {
      const follow = simulation.events.filter(function (event) { return event.followAcceleration; }).length;
      return Math.max(0, 10 - simulation.scoring.hardBrakes * 2 - follow * 2);
    },
    summarize: function (simulation, timedOut) {
      const state = simulation.scoring;
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(Scoring.eventSafe);
      const observation = resolved.reduce(function (sum, event) { return sum + Scoring.eventObservation(event); }, 0);
      const safety = Math.round(clean.length * (40 / 3));
      const efficiency = state.efficiencyTime > 0 ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
      const smooth = Scoring.smoothScore(simulation);
      const failed = simulation.events.some(function (event) { return event.failed; });
      let total = safety + observation + efficiency + smooth;
      if (failed) total = Math.min(total, 59);
      if (timedOut) total = Math.min(total, 69);
      total = Math.round(total);
      let grade = 'C';
      let titleKey = 'result.title.c';
      let summaryKey = 'result.summary.c';
      if (total >= 85 && !timedOut) {
        grade = 'A'; titleKey = 'result.title.a'; summaryKey = 'scene.revealedVehicle.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B'; titleKey = 'result.title.b'; summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout'; summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.revealedVehicle.result.advice.default';
      if (failed) adviceKey = 'scene.revealedVehicle.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.revealedVehicle.result.advice.observation';
      else if (state.hardBrakes > 0) adviceKey = 'result.advice.braking';
      else if (timedOut || efficiency < 12) adviceKey = 'result.advice.efficiency';
      return {
        total: total, grade: grade, titleKey: titleKey, summaryKey: summaryKey,
        safety: safety, observation: Math.round(observation), efficiency: Math.round(efficiency),
        efficiencyRaw: efficiency, smooth: smooth, hardBrakes: state.hardBrakes,
        earlySlowCount: simulation.events.filter(function (event) { return event.properEarlyControl; }).length,
        passedCount: clean.length, timedOut: Boolean(timedOut), failed: failed, adviceKey: adviceKey
      };
    }
  };

  function worldY(simulation, s) { return Draw.worldY(C, simulation, s); }
  function vehiclePixels(vehicle) {
    return {
      width: vehicle.width * C.PLAYER_SCREEN_WIDTH / C.PLAYER_WIDTH,
      length: vehicle.length * C.PLAYER_SCREEN_LENGTH / C.PLAYER_LENGTH
    };
  }
  function screenX(worldX) { return C.PLAYER_SCREEN_X + worldX * C.X_PIXELS_PER_METER; }
  function drawVehicle(ctx, simulation, vehicle, player, demo) {
    const dimensions = player ? { width: C.PLAYER_SCREEN_WIDTH, length: C.PLAYER_SCREEN_LENGTH } : vehiclePixels(vehicle);
    const x = player ? C.PLAYER_SCREEN_X : screenX(vehicle.x);
    const y = worldY(simulation, player ? simulation.distance : vehicle.s);
    const w = dimensions.width;
    const h = dimensions.length;
    if (y < -50 || y > C.HEIGHT + 50) return;
    const color = player ? (demo ? '#80e0b1' : '#e7685b') : vehicle.color;
    Draw.rect(ctx, '#0d1c2455', x - w / 2 + 3, y - h / 2 + 4, w, h);
    Draw.rect(ctx, '#14232b', x - w / 2 - 2, y - h / 2 + 5, 3, 8);
    Draw.rect(ctx, '#14232b', x + w / 2 - 1, y - h / 2 + 5, 3, 8);
    Draw.rect(ctx, '#14232b', x - w / 2 - 2, y + h / 2 - 12, 3, 8);
    Draw.rect(ctx, '#14232b', x + w / 2 - 1, y + h / 2 - 12, 3, 8);
    Draw.rect(ctx, color, x - w / 2, y - h / 2, w, h);
    Draw.rect(ctx, '#294651', x - w / 2 + 3, y - h / 2 + 7, w - 6, 9);
    Draw.rect(ctx, '#80b9c1', x - w / 2 + 5, y - h / 2 + 8, w - 10, 3);
    Draw.rect(ctx, '#1c343e', x - w / 2 + 3, y + 1, w - 6, 3);
    Draw.rect(ctx, '#294651', x - w / 2 + 3, y + 5, w - 6, 7);
    Draw.rect(ctx, '#fff2bd', x - w / 2 + 2, y - h / 2 + 1, 4, 2);
    Draw.rect(ctx, '#fff2bd', x + w / 2 - 6, y - h / 2 + 1, 4, 2);
    Draw.rect(ctx, '#c6383f', x - w / 2 + 2, y + h / 2 - 3, 4, 2);
    Draw.rect(ctx, '#c6383f', x + w / 2 - 6, y + h / 2 - 3, 4, 2);
    if (!player && vehicle.signal) {
      const on = Math.floor(simulation.elapsed * 2) % 2 === 0;
      Draw.rect(ctx, on ? '#ffd166' : '#8c713a', x - w / 2 - 4, y - 3, 5, 5);
      if (on) Draw.rect(ctx, '#ffd16644', x - w / 2 - 8, y - 5, 4, 9);
    }
    if (!player && vehicle.hazardLights) {
      const on = Math.floor(simulation.elapsed * 1.5) % 2 === 0;
      const lamp = on ? '#ffd166' : '#9b623c';
      Draw.rect(ctx, lamp, x - w / 2 + 1, y + h / 2 - 4, 4, 3);
      Draw.rect(ctx, lamp, x + w / 2 - 5, y + h / 2 - 4, 4, 3);
    }
  }

  function drawVisibleStopped(ctx, simulation, event, overview) {
    if (!event.stopped) return;
    if (overview) { drawVehicle(ctx, simulation, event.stopped, false, false); return; }
    const visibility = event.visibility;
    if (!visibility.visible) return;
    const samples = stoppedSamples(event.stopped);
    const minX = event.stopped.x - event.stopped.width / 2;
    const maxX = event.stopped.x + event.stopped.width / 2;
    const rearS = event.stopped.s - event.stopped.length / 2;
    const frontS = event.stopped.s + event.stopped.length / 2;
    // Clip to the union of sight rays that actually clear the moving leader.
    ctx.save();
    ctx.beginPath();
    let hasRegion = false;
    visibility.sampleMask.forEach(function (visible, index) {
      if (!visible) return;
      const point = samples[index];
      const eyeS = simulation.distance + C.EYE_FORWARD;
      const frontT = (frontS - eyeS) / Math.max(0.001, point.s - eyeS);
      const rearT = (rearS - eyeS) / Math.max(0.001, point.s - eyeS);
      const frontX = C.PLAYER_X - 0.28 + (point.x - (C.PLAYER_X - 0.28)) * frontT;
      const rearX = C.PLAYER_X - 0.28 + (point.x - (C.PLAYER_X - 0.28)) * rearT;
      const frontLeft = worldY(simulation, frontS);
      const rearY = worldY(simulation, rearS);
      const left = Math.max(minX, Math.min(frontX, rearX) - 0.14);
      const right = Math.min(maxX, Math.max(frontX, rearX) + 0.14);
      if (right <= left) return;
      const x = screenX(left);
      const width = (right - left) * C.X_PIXELS_PER_METER;
      ctx.rect(x, frontLeft, width, rearY - frontLeft);
      hasRegion = true;
    });
    if (hasRegion) {
      ctx.clip();
      drawVehicle(ctx, simulation, event.stopped, false, false);
    }
    ctx.restore();
  }

  function drawRoad(ctx, simulation) {
    Draw.drawEnvironment(ctx, simulation, C, 172);
    // The two lanes travel in the same direction; subtle chevrons distinguish this
    // from the opposing-road scenes without revealing the current event template.
    const scroll = (simulation.distance * C.PIXELS_PER_METER) % 110;
    for (let y = -80 + scroll; y < C.HEIGHT + 80; y += 110) {
      Draw.rect(ctx, '#b9c4b133', 128, y, 3, 10);
      Draw.rect(ctx, '#b9c4b133', 123, y + 6, 5, 3);
      Draw.rect(ctx, '#b9c4b133', 130, y + 6, 5, 3);
      Draw.rect(ctx, '#b9c4b133', 209, y, 3, 10);
      Draw.rect(ctx, '#b9c4b133', 204, y + 6, 5, 3);
      Draw.rect(ctx, '#b9c4b133', 211, y + 6, 5, 3);
    }
  }

  function drawTimeline(ctx, simulation, event) {
    Draw.rect(ctx, '#10232bdc', 30, 94, 300, 80);
    ctx.fillStyle = '#dce8d9';
    Draw.fillFittedText(ctx, t('scene.revealedVehicle.replay.timeline'), 42, 111, 270, 10, 'sans-serif');
    const events = [
      { at: event.cueVisibleAt, key: 'cue' },
      { at: event.firstResponseAt, key: 'response' },
      { at: event.stoppedFirstVisibleAt || event.clearLaneConfirmedAt, key: 'reveal' },
      { at: event.brakingStartAt, key: 'brake' },
      { at: event.stoppedAt || (event.resolved ? event.elapsed : null), key: 'finish' }
    ];
    const end = Math.max(1, event.elapsed, event.stoppedAt || 0);
    Draw.rect(ctx, '#52736c', 50, 136, 258, 2);
    events.forEach(function (item, index) {
      if (item.at == null) return;
      const x = 50 + 258 * clamp(item.at / end, 0, 1);
      Draw.rect(ctx, index === 4 ? '#80e0b1' : '#ffd166', x - 2, 132, 5, 10);
      ctx.fillStyle = '#c6d6ce';
      Draw.fillFittedText(ctx, t('scene.revealedVehicle.replay.' + item.key), x - 18, 155 + (index % 2) * 10, 42, 7, 'sans-serif');
    });
  }

  function drawWorld(ctx, simulation, overview, demo) {
    drawRoad(ctx, simulation);
    const event = simulation.currentEvent || simulation.events[simulation.events.length - 1];
    if (event) {
      drawVisibleStopped(ctx, simulation, event, overview);
      drawVehicle(ctx, simulation, event.leader, false, false);
      if (overview && event.stopped) {
        const y = worldY(simulation, event.stopped.s);
        Draw.rect(ctx, '#10232bdc', 235, clamp(y - 8, 180, 420), 88, 17);
        ctx.fillStyle = '#ffe4a0';
        Draw.fillFittedText(ctx, t('scene.revealedVehicle.replay.alwaysThere'), 239, clamp(y + 3, 191, 431), 80, 8, 'sans-serif');
      }
    }
    drawVehicle(ctx, simulation, { color: '#e7685b' }, true, demo);
    if (simulation.status === 'ready') {
      Draw.rect(ctx, '#10232bcc', 92, 112, 176, 29);
      ctx.fillStyle = '#e8eddc';
      Draw.fillFittedText(ctx, t('scene.revealedVehicle.canvas.goal'), 101, 131, 158, 10, 'sans-serif');
    }
    if (overview && event) drawTimeline(ctx, simulation, event);
  }

  const Renderer = {
    render: function (ctx, simulation) {
      const replay = simulation.status === 'demonstrating' && simulation.demoMode === 'overview' && simulation.demo;
      const demonstrating = simulation.status === 'demonstrating' && simulation.demo;
      const view = demonstrating ? simulation.demo : simulation;
      const overview = replay && simulation.replayPerspective === 'overview';
      drawWorld(ctx, view, overview, demonstrating && !replay);
      if (replay) {
        Draw.rect(ctx, '#10232bdc', 24, 52, 312, 30);
        ctx.fillStyle = '#dce8d9';
        Draw.fillFittedText(ctx, t(overview ? 'scene.revealedVehicle.replay.overview' : 'scene.revealedVehicle.replay.driver'),
          35, 71, 290, 11, 'sans-serif');
      }
      if (simulation.status === 'frozen' && simulation.freezeInfo) {
        Draw.rect(ctx, '#5f3434bb', 52, 196, 256, 74);
        ctx.fillStyle = '#ffe5cd';
        Draw.fillFittedText(ctx, t('scene.revealedVehicle.canvas.freeze'), 65, 223, 230, 14, 'sans-serif');
        ctx.fillStyle = '#f6d6b8';
        Draw.fillFittedText(ctx, t('scene.revealedVehicle.canvas.freezeSub'), 65, 247, 230, 9, 'sans-serif');
      }
    }
  };

  Scenes['revealed-stopped-vehicle'] = {
    id: 'revealed-stopped-vehicle',
    Constants: C,
    Geometry: {
      segmentIntersectsAABB: segmentIntersectsAABB,
      visibilityFor: visibilityFor,
      stoppedSamples: stoppedSamples,
      rectanglesOverlap: rectanglesOverlap,
      leaderGap: leaderGap,
      stoppedGap: stoppedGap
    },
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    createPlan: createPlan,
    defensiveInput: defensiveInput,
    bindControls: function (doc, getSimulation) {
      const button = doc.getElementById('replay-view-button');
      if (!button) return;
      button.addEventListener('click', function () {
        const simulation = getSimulation();
        if (simulation.status !== 'demonstrating' || simulation.demoMode !== 'overview') return;
        simulation.replayPerspective = simulation.replayPerspective === 'overview' ? 'driver' : 'overview';
        button.textContent = t(simulation.replayPerspective === 'overview' ?
          'scene.revealedVehicle.replay.showDriver' : 'scene.revealedVehicle.replay.showOverview');
      });
    },
    updateLeader: updateLeader,
    assessStoppingMargin: assessStoppingMargin,
    ui: {
      progress: function (simulation) {
        if (simulation.status === 'demonstrating' && simulation.demoMode === 'overview') {
          return t('scene.revealedVehicle.hud.replay', { number: simulation.demoEventId + 1 });
        }
        return t('scene.revealedVehicle.hud.progress', {
          resolved: simulation.events.filter(function (event) { return event.resolved; }).length
        });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.properEarlyControl; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && Scoring.eventSafe(event); }).length
        ];
      },
      smoothScore: Scoring.smoothScore,
      updateControls: function (doc, simulation) {
        const replay = simulation.status === 'demonstrating' && simulation.demoMode === 'overview';
        const badge = doc.querySelector('#demo-screen .demo-badge');
        const skip = doc.getElementById('skip-demo-button');
        const toggle = doc.getElementById('replay-view-button');
        if (badge) badge.textContent = t(replay ? 'scene.revealedVehicle.replay.badge' : 'game.demoBadge');
        if (skip) skip.textContent = t(replay ? 'scene.revealedVehicle.replay.skip' : 'game.skipDemo');
        if (toggle) {
          toggle.hidden = !replay;
          toggle.textContent = t(simulation.replayPerspective === 'overview' ?
            'scene.revealedVehicle.replay.showDriver' : 'scene.revealedVehicle.replay.showOverview');
        }
      },
      coach: function (simulation, displaySpeed) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        let key = 'scene.revealedVehicle.hud.cruise';
        let status = displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : 'hud.speedUp';
        let tone = displaySpeed < 25 ? 'warn' : '';
        let coachTone = '';
        if (simulation.status === 'demonstrating' && simulation.demoMode === 'overview') {
          return { text: t('scene.revealedVehicle.hud.replayCoach'), status: t('scene.revealedVehicle.replay.badge'), tone: '', coachTone: 'good' };
        }
        if (event) {
          if (event.cueVisibleAt != null && !event.visibility.visible && event.clearLaneConfirmedAt == null) {
            key = event.leader.state === 'SIGNALING' ? 'scene.revealedVehicle.hud.signal' : 'scene.revealedVehicle.hud.changing';
            status = 'hud.prepareSlow'; tone = 'warn'; coachTone = 'risk';
          }
          if (event.visibility.visible && !event.resolved) {
            key = 'scene.revealedVehicle.hud.stopped'; status = 'hud.prepareStop'; tone = 'warn'; coachTone = 'risk';
          }
          if (!event.stopped && event.clearLaneConfirmedAt != null) {
            key = current.speed < 8 ? 'scene.revealedVehicle.hud.resume' : 'scene.revealedVehicle.hud.clear';
            status = current.speed < 8 ? 'hud.speedUp' : 'hud.cruiseGood'; tone = current.speed < 8 ? 'warn' : ''; coachTone = 'good';
          }
        }
        return { text: t(key), status: t(simulation.status === 'ready' ? 'hud.ready' : status), tone: tone, coachTone: coachTone };
      },
      retryToast: function () { return { key: 'scene.revealedVehicle.toast.retry', params: {}, neutral: true }; },
      eventToast: function (event) {
        if (event.closeStop) return { key: 'scene.revealedVehicle.toast.close', params: { score: event.observation }, neutral: true };
        if (event.farStop) return { key: 'scene.revealedVehicle.toast.far', params: { score: event.observation }, neutral: true };
        if (event.observation === 10) return { key: event.stopped ? 'scene.revealedVehicle.toast.safe' : 'scene.revealedVehicle.toast.clear', params: { score: 10 }, neutral: false };
        return { key: 'scene.revealedVehicle.toast.improve', params: { score: event.observation }, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        const key = info.followAcceleration ? 'scene.revealedVehicle.failure.acceleration' :
          (info.reason === 'leader' ? 'scene.revealedVehicle.failure.leader' : 'scene.revealedVehicle.failure.stopped');
        return t(key, {
          speed: Math.round(info.speed),
          remaining: Math.max(0, info.reason === 'leader' ? info.leaderGap : info.stoppedGap).toFixed(1),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo.events[simulation.demoEventId];
        if (simulation.demoMode === 'overview') {
          return {
            step: t(simulation.replayPerspective === 'overview' ? 'scene.revealedVehicle.replay.overview' : 'scene.revealedVehicle.replay.driver'),
            substep: t('scene.revealedVehicle.replay.caption')
          };
        }
        let key = 'scene.revealedVehicle.demo.cruise';
        if (event.visibility.visible) key = 'scene.revealedVehicle.demo.stop';
        else if (event.clearLaneConfirmedAt != null) key = 'scene.revealedVehicle.demo.clear';
        else if (event.cueVisibleAt != null) key = 'scene.revealedVehicle.demo.cue';
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
