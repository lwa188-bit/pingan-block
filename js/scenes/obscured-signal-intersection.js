(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;
  const t = function (key, params) { return Game.I18N.t(key, params); };

  const C = Object.assign({}, Game.C, {
    EVENT_POSITIONS: [170, 480, 790],
    APPROACH_DISTANCE: 90,
    CONFLICT_DEPTH: 22,
    CAR_X: 210,
    START_SPEED: 42,
    MAX_SPEED: 60,
    MAX_TIME: 155,
    EYE_FORWARD: 0.65,
    EYE_HEIGHT: 1.15,
    SIGNAL_HEIGHT: 5.1,
    LATERAL_LIMIT: 0.7,
    LATERAL_SPEED: 0.62,
    SIGNAL_DWELL: 0.35,
    PEDESTRIAN_DWELL: 0.25,
    CONFLICT_DWELL: 0.45,
    STOP_HOLD_TIME: 0.3,
    PREDICTION_STEP: 0.025,
    PREDICTION_HORIZON: 3.2,
    LEADER_BRAKE: 2.6,
    LEADER_ACCELERATION: 1.2
  });

  const TEMPLATES = ['green-reveal', 'red-reveal', 'crosswalk-reveal'];

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function range(random, min, max) { return min + random() * (max - min); }
  function shuffle(values, random) {
    const result = values.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      const swap = result[index]; result[index] = result[other]; result[other] = swap;
    }
    return result;
  }

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed('obscured-signal-intersection:' + seed));
    const templates = shuffle(TEMPLATES, random);
    const colors = ['#d7b957', '#79a8b7', '#c98568', '#a4b68a'];
    const events = C.EVENT_POSITIONS.map(function (stopS, id) {
      const template = templates[id];
      const direction = random() < 0.5 ? -1 : 1;
      const yellowAt = template === 'red-reveal' ? range(random, 5.35, 5.6) : range(random, 27, 29);
      const yellowDuration = template === 'red-reveal' ? 2 : 2.4;
      return Object.freeze({
        id: id,
        template: template,
        stopS: stopS,
        crosswalkS: stopS + 4.5,
        conflictEndS: stopS + C.CONFLICT_DEPTH,
        signalS: stopS + 2.5,
        signalX: range(random, 0.1, 0.45),
        yellowAt: yellowAt,
        yellowDuration: yellowDuration,
        allRed: 0.8,
        crossReleaseAt: yellowAt + yellowDuration + 0.8,
        greenAt: template === 'red-reveal' ? range(random, 14.1, 14.8) : yellowAt + yellowDuration + 6.2,
        initialGap: range(random, 14, 17),
        leader: Object.freeze({
          type: random() < 0.5 ? 'bus' : 'truck',
          length: range(random, 10.2, 11.8),
          width: range(random, 2.45, 2.6),
          height: range(random, 3.15, 3.5),
          cruiseSpeed: range(random, 46, 49),
          color: colors[Math.floor(random() * colors.length)]
        }),
        pedestrian: Object.freeze({
          enabled: template === 'crosswalk-reveal',
          direction: direction,
          enterAt: range(random, 4.0, 4.4),
          speed: range(random, 1.2, 1.35),
          coatColor: colors[Math.floor(random() * colors.length)],
          skinColor: '#d9b58f'
        })
      });
    });
    return Object.freeze({ seed: seed, rulePackId: 'CN', events: Object.freeze(events) });
  }

  function createRuntimeEvent(plan) {
    return {
      id: plan.id,
      active: false,
      localTime: 0,
      resolved: false,
      failed: false,
      attempts: 0,
      leader: null,
      pedestrian: null,
      signalStreak: 0,
      signalFirstVisibleAt: null,
      signalConfirmedAt: null,
      signalConfirmed: false,
      conflictStreak: 0,
      conflictConfirmed: false,
      pedestrianStreak: 0,
      pedestrianFirstVisibleAt: null,
      pedestrianConfirmed: false,
      spacingTime: 0,
      spacingEstablished: false,
      minGap: Infinity,
      redObserved: false,
      properStop: false,
      stopDuration: 0,
      stoppedDistance: null,
      waitedForGreen: false,
      waitedForFullClear: false,
      resumeSpeedReached: false,
      earlyStart: false,
      enteredAgainstRule: false,
      enteredWithoutConfirmation: false,
      enteredOccupied: false,
      closePass: false,
      unsafePass: false,
      correctAction: false,
      observation: 0,
      lateralReversals: 0,
      lastSteer: 0,
      lastSteerAt: -10,
      steerPenaltyCooldown: 0
    };
  }

  function signalPhase(event) {
    if (!event || !event.active) return 'green';
    if (event.localTime < event.yellowAt) return 'green';
    if (event.localTime < event.yellowAt + event.yellowDuration) return 'yellow';
    if (event.localTime < event.greenAt) return 'red';
    return 'green';
  }

  function leaderGap(simulation, event) {
    if (!event || !event.leader) return Infinity;
    return event.leader.s - event.leader.length / 2 -
      (simulation.distance + C.CAR_LENGTH_M / 2);
  }

  function pedestrianPosition(event) {
    const ped = event.pedestrian;
    if (!ped || !ped.enabled) return null;
    const travel = Math.max(0, event.localTime - ped.enterAt) * ped.speed;
    return {
      x: -ped.direction * 5.4 + ped.direction * travel,
      s: event.crosswalkS,
      cleared: travel >= 10.8
    };
  }

  function pedestrianOccupied(event) {
    const ped = pedestrianPosition(event);
    return Boolean(ped && event.localTime >= event.pedestrian.enterAt && !ped.cleared && Math.abs(ped.x) <= 4.9);
  }

  function segmentIntersectsBox3D(eye, target, box) {
    const origin = [eye.x, eye.s, eye.z];
    const destination = [target.x, target.s, target.z];
    const mins = [box.minX, box.minS, 0];
    const maxs = [box.maxX, box.maxS, box.height];
    let enter = 0;
    let leave = 1;
    for (let axis = 0; axis < 3; axis += 1) {
      const delta = destination[axis] - origin[axis];
      if (Math.abs(delta) < 1e-9) {
        if (origin[axis] < mins[axis] || origin[axis] > maxs[axis]) return false;
        continue;
      }
      let near = (mins[axis] - origin[axis]) / delta;
      let far = (maxs[axis] - origin[axis]) / delta;
      if (near > far) { const swap = near; near = far; far = swap; }
      enter = Math.max(enter, near);
      leave = Math.min(leave, far);
      if (enter > leave) return false;
    }
    return leave > 1e-6 && enter < 1 - 1e-6;
  }

  function eyePoint(simulation) {
    return { x: simulation.lateral, s: simulation.distance + C.EYE_FORWARD, z: C.EYE_HEIGHT };
  }

  function leaderBox(event) {
    const leader = event.leader;
    if (!leader) return null;
    return {
      minX: leader.x - leader.width / 2,
      maxX: leader.x + leader.width / 2,
      minS: leader.s - leader.length / 2,
      maxS: leader.s + leader.length / 2,
      height: leader.height
    };
  }

  function targetVisibility(simulation, event, samples) {
    const eye = eyePoint(simulation);
    const box = leaderBox(event);
    let visibleSamples = 0;
    let testedSamples = 0;
    samples.forEach(function (sample) {
      if (sample.s < eye.s - 0.5 || sample.s > eye.s + 150) return;
      testedSamples += 1;
      if (!box || !segmentIntersectsBox3D(eye, sample, box)) visibleSamples += 1;
    });
    return {
      visible: testedSamples > 0 && visibleSamples > 0,
      visibleSamples: visibleSamples,
      totalSamples: samples.length,
      testedSamples: testedSamples,
      occluderId: box && visibleSamples === 0 && testedSamples > 0 ? 'leader' : null
    };
  }

  function signalVisibility(simulation, event) {
    if (!event) return { visible: false, visibleSamples: 0, totalSamples: 0 };
    return targetVisibility(simulation, event, [
      { x: event.signalX, s: event.signalS, z: C.SIGNAL_HEIGHT },
      { x: event.signalX, s: event.signalS, z: C.SIGNAL_HEIGHT - 0.3 },
      { x: event.signalX, s: event.signalS, z: C.SIGNAL_HEIGHT + 0.3 }
    ]);
  }

  function pedestrianVisibility(simulation, event) {
    const ped = pedestrianPosition(event);
    if (!ped || ped.cleared || event.localTime < event.pedestrian.enterAt) {
      return { visible: false, visibleSamples: 0, totalSamples: 0, occluderId: null };
    }
    return targetVisibility(simulation, event, [
      { x: ped.x, s: ped.s, z: 0.85 },
      { x: ped.x, s: ped.s, z: 1.55 },
      { x: ped.x - 0.18, s: ped.s, z: 1.1 },
      { x: ped.x + 0.18, s: ped.s, z: 1.1 }
    ]);
  }

  function conflictZoneVisibility(simulation, event) {
    return targetVisibility(simulation, event, [-3.2, 0, 3.2].map(function (x) {
      return { x: x, s: event.crosswalkS, z: 0.35 };
    }));
  }

  function updateLeader(event, dt) {
    const leader = event.leader;
    if (!leader) return;
    const ped = pedestrianPosition(event);
    const mustYield = Boolean(ped && event.localTime >= event.pedestrian.enterAt - 2 && !ped.cleared);
    const front = leader.s + leader.length / 2;
    const remaining = event.stopS - 0.45 - front;
    const oldSpeed = leader.speed / 3.6;
    let targetSpeed = leader.cruiseSpeed;
    if (mustYield) {
      const safeRemaining = Math.max(0, remaining);
      targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * C.LEADER_BRAKE * safeRemaining) * 3.6);
    }
    if (leader.yieldStopped && ped && !ped.cleared) targetSpeed = 0;
    if (ped && ped.cleared) {
      if (leader.resumeAt == null) leader.resumeAt = event.localTime + 0.8;
      if (event.localTime < leader.resumeAt && remaining < 1) targetSpeed = 0;
    }
    let acceleration = C.LEADER_ACCELERATION;
    if (leader.speed > targetSpeed + 0.25) acceleration = -C.LEADER_BRAKE;
    else if (leader.speed >= targetSpeed - 0.25) acceleration = 0;
    if (targetSpeed === 0 && leader.speed < 0.5) acceleration = 0;
    const nextSpeed = clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
    leader.speed = targetSpeed === 0 && nextSpeed < 0.25 ? 0 : nextSpeed * 3.6;
    leader.acceleration = (leader.speed / 3.6 - oldSpeed) / dt;
    leader.braking = leader.acceleration < -0.35 || (mustYield && targetSpeed < leader.cruiseSpeed - 1);
    leader.s += (oldSpeed + leader.speed / 3.6) * 0.5 * dt;
    const stoppingS = event.stopS - 0.45 - leader.length / 2;
    if (mustYield && leader.s >= stoppingS) {
      leader.s = stoppingS;
      leader.speed = 0;
      leader.acceleration = -oldSpeed / dt;
      leader.braking = true;
      leader.yieldStopped = true;
    }
    const newRemaining = event.stopS - 0.45 - (leader.s + leader.length / 2);
    if (mustYield && newRemaining <= 0.12 && leader.speed < 1) {
      leader.speed = 0;
      leader.yieldStopped = true;
    }
    if (!mustYield && leader.speed > 2) leader.yieldStopped = false;
    leader.state = leader.yieldStopped ? 'yield-stopped' : (leader.braking ? 'comfort-braking' :
      (front > event.conflictEndS ? 'cleared' : 'approach'));
  }

  function assessFollowingSpace(simulation, event) {
    const v = simulation.speed / 3.6;
    const leadSpeed = event.leader ? event.leader.speed / 3.6 : 0;
    const brakingDistance = Math.max(0, v * 0.65 + v * v / (2 * C.BRAKE_DECELERATION) -
      leadSpeed * leadSpeed / (2 * C.LEADER_BRAKE)) + 2;
    const gap = leaderGap(simulation, event);
    return { gap: gap, brakingDistance: brakingDistance, margin: gap - brakingDistance };
  }

  function leaderCollisionAlongPath(simulation, event, acceleration, horizon) {
    let playerS = simulation.distance;
    let playerV = simulation.speed / 3.6;
    let leaderS = event.leader.s;
    let leaderV = event.leader.speed / 3.6;
    const leaderAcceleration = event.leader.yieldStopped ? 0 :
      clamp(event.leader.acceleration || 0, -C.LEADER_BRAKE, C.LEADER_ACCELERATION);
    for (let time = 0; time < horizon; time += C.PREDICTION_STEP) {
      const dt = C.PREDICTION_STEP;
      const nextPlayerV = clamp(playerV + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      const nextLeaderV = clamp(leaderV + leaderAcceleration * dt, 0, C.MAX_SPEED / 3.6);
      playerS += (playerV + nextPlayerV) * 0.5 * dt;
      leaderS += (leaderV + nextLeaderV) * 0.5 * dt;
      playerV = nextPlayerV; leaderV = nextLeaderV;
      const gap = leaderS - event.leader.length / 2 - (playerS + C.CAR_LENGTH_M / 2);
      if (gap <= 0.04) return true;
      if (playerV === 0 && leaderV >= playerV) return false;
    }
    return false;
  }

  function predictLeaderConflict(simulation, event, input) {
    if (!event.leader) return false;
    const currentAcceleration = input.brake ? -C.BRAKE_DECELERATION :
      (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
    if (leaderCollisionAlongPath(simulation, event, currentAcceleration, 0.3)) return true;
    return leaderCollisionAlongPath(simulation, event, -C.EMERGENCY_BRAKE_DECELERATION, 4.5);
  }

  function pedestrianCollisionAlongPath(simulation, event, acceleration, horizon) {
    const ped = pedestrianPosition(event);
    let playerS = simulation.distance;
    let playerV = simulation.speed / 3.6;
    let pedX = ped.x;
    for (let time = 0; time < horizon; time += C.PREDICTION_STEP) {
      const dt = C.PREDICTION_STEP;
      const nextV = clamp(playerV + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      playerS += (playerV + nextV) * 0.5 * dt;
      playerV = nextV;
      pedX += event.pedestrian.direction * event.pedestrian.speed * dt;
      const longitudinal = playerS + C.CAR_LENGTH_M / 2 > event.crosswalkS - 0.8 &&
        playerS - C.CAR_LENGTH_M / 2 < event.crosswalkS + 0.8;
      if (longitudinal && Math.abs(simulation.lateral - pedX) < 0.95) return true;
      if (playerV === 0 || Math.abs(pedX) > 5.4) return false;
    }
    return false;
  }

  function predictCrossingConflict(simulation, event, input) {
    const ped = pedestrianPosition(event);
    if (!ped || ped.cleared || event.localTime < event.pedestrian.enterAt) return false;
    const currentAcceleration = input.brake ? -C.BRAKE_DECELERATION :
      (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
    if (pedestrianCollisionAlongPath(simulation, event, currentAcceleration, 0.3)) return true;
    return pedestrianCollisionAlongPath(simulation, event, -C.EMERGENCY_BRAKE_DECELERATION, 4.5);
  }

  function stopInput(simulation, event, gapLimited) {
    const lineDistance = event.stopS - (simulation.distance + C.CAR_LENGTH_M / 2);
    const v = simulation.speed / 3.6;
    const brakeDistance = v * v / (2 * C.BRAKE_DECELERATION);
    const gap = leaderGap(simulation, event);
    const shouldStop = lineDistance <= brakeDistance + 3.2 ||
      (gapLimited && gap <= Math.max(5, brakeDistance + 3)) ||
      (simulation.speed < 1 && (lineDistance < 9 || gapLimited));
    if (shouldStop) return { throttle: false, brake: simulation.speed > 0.25 };
    return { throttle: simulation.speed < 40, brake: simulation.speed > 43 };
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    if (!event || !event.active) return { throttle: simulation.speed < 46.5, brake: simulation.speed > 48 };
    const lineDistance = event.stopS - (simulation.distance + C.CAR_LENGTH_M / 2);
    const gap = leaderGap(simulation, event);
    const signalVisible = signalVisibility(simulation, event).visible;
    const phase = signalPhase(event);
    const knownPhase = signalVisible ? phase : (event.signalConfirmed ? event.lastConfirmedPhase : null);
    const pedVisible = pedestrianVisibility(simulation, event).visible;
    const pedNeedsYield = event.pedestrian && event.pedestrian.enabled && !pedestrianPosition(event).cleared &&
      (pedVisible || event.pedestrianConfirmed || event.leader.braking || event.leader.yieldStopped);
    const gapLimited = gap < 18 && event.leader.speed < simulation.speed + 2;
    const input = { left: false, right: false, throttle: false, brake: false };

    // A small, sustained lane offset can open a real line around the vehicle edge.
    if (!signalVisible && lineDistance > 18 && lineDistance < 65 && gap > 15) {
      if (simulation.lateral < 0.48) input.right = true;
    }

    if (lineDistance < -0.5) {
      const followTarget = gap < 15 ? Math.min(38, event.leader.speed + 1) : 44.5;
      input.throttle = simulation.speed < followTarget - 0.7 && gap > 7;
      input.brake = simulation.speed > followTarget + 0.8 || gap < 5 && simulation.speed > event.leader.speed + 1;
      return input;
    }
    if (event.properStop) {
      const canResume = (!event.redObserved || event.waitedForGreen) &&
        (!event.pedestrianConfirmed || event.waitedForFullClear) && signalVisible && phase === 'green' &&
        !pedestrianOccupied(event);
      if (!canResume) {
        input.brake = simulation.speed > 0.25;
        return input;
      }
      const followTarget = gap < 15 ? Math.min(38, event.leader.speed + 1) : 43.5;
      input.throttle = simulation.speed < followTarget - 0.7 && gap > 5;
      input.brake = simulation.speed > followTarget + 0.8 || gap < 4 && simulation.speed > event.leader.speed + 1;
      return input;
    }
    if (knownPhase === 'red' || knownPhase === 'yellow' && lineDistance < 32 || pedNeedsYield) {
      return Object.assign(input, stopInput(simulation, event, gapLimited || pedNeedsYield));
    }
    if (!event.signalConfirmed) {
      const v = simulation.speed / 3.6;
      const stoppingDistance = v * v / (2 * C.BRAKE_DECELERATION);
      if (lineDistance < stoppingDistance + 5 || gapLimited) {
        return Object.assign(input, stopInput(simulation, event, gapLimited));
      }
      input.throttle = simulation.speed < 40 && gap > 19;
      input.brake = simulation.speed > 43 || gap < 16;
      return input;
    }
    input.throttle = simulation.speed < 44.5 && gap > 17;
    input.brake = simulation.speed > 47 || gap < 13;
    return input;
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
        this.events[index].spacingEstablished = true;
        this.events[index].signalConfirmed = true;
        this.events[index].correctAction = true;
      }
      this.distance = hasEventOption ? this.events[this.eventIndex].stopS - C.APPROACH_DISTANCE : 0;
      this.speed = hasEventOption ? 45 : C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.lateral = 0;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.scoring.steerPenalties = 0;
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoOverview = false;
      if (hasEventOption) this.activateEvent(this.currentEvent);
    }

    get currentEvent() {
      const event = this.events[this.eventIndex];
      return event && !event.resolved ? event : null;
    }

    start() { this.status = 'driving'; }

    activateEvent(event) {
      if (!event || event.active) return;
      event.active = true;
      event.localTime = 0;
      const spec = event.leader;
      event.leader = {
        type: spec.type,
        length: spec.length,
        width: spec.width,
        height: spec.height,
        cruiseSpeed: spec.cruiseSpeed,
        color: spec.color,
        x: 0,
        s: this.distance + C.CAR_LENGTH_M / 2 + event.initialGap + spec.length / 2,
        speed: spec.cruiseSpeed,
        acceleration: 0,
        braking: false,
        yieldStopped: false,
        resumeAt: null,
        state: 'approach'
      };
      event.pedestrian = Object.assign({ cleared: false }, event.pedestrian);
    }

    updateObservation(event, dt) {
      const lineDistance = event.stopS - (this.distance + C.CAR_LENGTH_M / 2);
      const relevant = lineDistance < 68 && lineDistance > -6;
      const signal = signalVisibility(this, event);
      const conflict = conflictZoneVisibility(this, event);
      const pedestrian = pedestrianVisibility(this, event);
      event.visibility = { signal: signal, conflict: conflict, pedestrian: pedestrian };
      if (relevant && signal.visible && !event.signalConfirmed) {
        if (event.signalFirstVisibleAt == null) event.signalFirstVisibleAt = event.localTime;
        event.signalStreak += dt;
        if (event.signalStreak >= C.SIGNAL_DWELL) {
          event.signalConfirmed = true;
          event.signalConfirmedAt = event.localTime;
        }
      } else if (!event.signalConfirmed) event.signalStreak = 0;
      if (signal.visible) event.lastConfirmedPhase = signalPhase(event);
      if (signal.visible && signalPhase(event) === 'red') event.redObserved = true;

      if (relevant && conflict.visible && !pedestrianOccupied(event)) event.conflictStreak += dt;
      else if (pedestrianOccupied(event)) {
        event.conflictStreak = 0;
        event.conflictConfirmed = false;
      } else if (relevant) event.conflictStreak = 0;
      if (event.conflictStreak >= C.CONFLICT_DWELL) event.conflictConfirmed = true;

      if (relevant && pedestrian.visible) {
        if (event.pedestrianFirstVisibleAt == null) event.pedestrianFirstVisibleAt = event.localTime;
        event.pedestrianStreak += dt;
        if (event.pedestrianStreak >= C.PEDESTRIAN_DWELL) event.pedestrianConfirmed = true;
      } else if (!event.pedestrianConfirmed) event.pedestrianStreak = 0;

      const gap = leaderGap(this, event);
      if (lineDistance > 12 && lineDistance < 75 && gap >= 18 && gap <= 48 &&
        this.speed >= 32 && this.speed <= 48) event.spacingTime += dt;
      else if (gap < 14) event.spacingTime = 0;
      if (event.spacingTime >= 0.6) event.spacingEstablished = true;
    }

    freeze(event, reason) {
      if (this.status !== 'driving') return;
      event.failed = true;
      event.attempts += 1;
      event.unsafePass = true;
      this.freezeInfo = {
        eventId: event.id,
        reason: reason,
        speed: this.speed,
        lineDistance: event.stopS - (this.distance + C.CAR_LENGTH_M / 2),
        gap: leaderGap(this, event),
        signalFirstVisibleAt: event.signalFirstVisibleAt,
        leaderBraking: event.leader && event.leader.braking
      };
      this.status = 'frozen';
    }

    resolveEvent(event) {
      const waitedForObservedRed = !event.redObserved || event.waitedForGreen;
      const waitedForObservedPedestrian = !event.pedestrianConfirmed || event.waitedForFullClear;
      event.correctAction = event.signalConfirmed && event.conflictConfirmed &&
        waitedForObservedRed && waitedForObservedPedestrian &&
        !event.earlyStart && !event.enteredAgainstRule && !event.enteredWithoutConfirmation &&
        !event.enteredOccupied && !event.closePass;
      event.observation = (event.spacingEstablished ? 3 : 0) + (event.signalConfirmed ? 3 : 0) +
        (event.correctAction ? 4 : 0);
      if (!event.correctAction) event.unsafePass = true;
      event.resolved = true;
      this.justResolved = event;
      if (this.eventIndex === this.events.length - 1) {
        this.status = 'complete';
        this.speed = 0;
        return;
      }
      this.eventIndex += 1;
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
      if (event.active) event.localTime += dt;

      if (event.active && event.pedestrian && event.pedestrian.enabled) {
        const position = pedestrianPosition(event);
        event.pedestrian.x = position.x;
        event.pedestrian.s = position.s;
        event.pedestrian.cleared = position.cleared;
        if (position.cleared && event.pedestrian.clearAt == null) event.pedestrian.clearAt = event.localTime;
      }
      if (event.active) updateLeader(event, dt);

      const gapBefore = event.active ? leaderGap(this, event) : Infinity;
      const lineBefore = event.stopS - (this.distance + C.CAR_LENGTH_M / 2);
      const speedMps = this.speed / 3.6;
      const relativeSpeedMps = Math.max(0, (this.speed - event.leader.speed) / 3.6);
      const lineDeceleration = lineBefore > 0 ? speedMps * speedMps / (2 * lineBefore) : 0;
      const gapDeceleration = gapBefore > 0 && Number.isFinite(gapBefore) ?
        relativeSpeedMps * relativeSpeedMps / (2 * gapBefore) : 0;
      const emergency = input.brake && this.speed > 20 &&
        Math.max(lineDeceleration, gapDeceleration) > C.BRAKE_DECELERATION;
      this.necessaryBraking = Boolean(input.brake && event.active && event.spacingEstablished && gapBefore >= 3 &&
        gapBefore < 12 && lineBefore > 0 && (event.leader.braking || event.leader.yieldStopped || pedestrianOccupied(event)));
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle && !input.brake) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = -(emergency ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);

      if (event.active && (predictLeaderConflict(this, event, input) || predictCrossingConflict(this, event, input))) {
        const reason = predictCrossingConflict(this, event, input) ? 'pedestrian' : 'leader';
        this.freeze(event, reason);
        return;
      }

      const previousDistance = this.distance;
      const previousLeaderS = event.leader ? event.leader.s : 0;
      const previousLeaderSpeed = event.leader ? event.leader.speed : 0;
      this.previousSpeed = this.speed;
      this.acceleration = acceleration;
      const oldSpeed = this.speed / 3.6;
      const nextSpeed = clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      this.speed = nextSpeed * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeed - nextSpeed) / dt);
      this.distance += (oldSpeed + nextSpeed) * 0.5 * dt;

      const steer = input.left === input.right ? 0 : (input.left ? -1 : 1);
      this.lateral = clamp(this.lateral + steer * C.LATERAL_SPEED * dt, -C.LATERAL_LIMIT, C.LATERAL_LIMIT);
      event.steerPenaltyCooldown = Math.max(0, event.steerPenaltyCooldown - dt);
      if (steer && event.lastSteer && steer !== event.lastSteer &&
        event.localTime - event.lastSteerAt < 1.15 && event.steerPenaltyCooldown <= 0) {
        event.lateralReversals += 1;
        this.scoring.steerPenalties += 1;
        event.steerPenaltyCooldown = 1;
      }
      if (steer) { event.lastSteer = steer; event.lastSteerAt = event.localTime; }

      const gap = event.active ? leaderGap(this, event) : Infinity;
      if (event.active) event.minGap = Math.min(event.minGap, gap);
      if (gap <= 0.02) {
        this.distance = previousDistance;
        this.speed = this.previousSpeed;
        if (event.leader) {
          event.leader.s = previousLeaderS;
          event.leader.speed = previousLeaderSpeed;
        }
        this.freeze(event, 'leader');
        return;
      }

      const frontBefore = previousDistance + C.CAR_LENGTH_M / 2;
      const frontAfter = this.distance + C.CAR_LENGTH_M / 2;
      const phase = signalPhase(event);
      if (frontBefore <= event.stopS && frontAfter > event.stopS) {
        if (!event.signalConfirmed || !event.conflictConfirmed) event.enteredWithoutConfirmation = true;
        if (pedestrianOccupied(event)) event.enteredOccupied = true;
        if (phase === 'red') {
          event.enteredAgainstRule = true;
          this.freeze(event, 'redEntry');
          return;
        }
      }

      const lineDistance = event.stopS - frontAfter;
      const stopRelevant = phase === 'red' || pedestrianOccupied(event) || event.leader.yieldStopped;
      if (lineDistance >= 0.15 && lineDistance <= 30 && this.speed < 0.35 && stopRelevant) {
        event.stopDuration += dt;
        if (event.stopDuration >= C.STOP_HOLD_TIME && !event.properStop) {
          event.properStop = true;
          event.stoppedDistance = this.distance;
        }
      } else if (!event.properStop) event.stopDuration = 0;

      this.updateObservation(event, dt);
      if (event.properStop && event.redObserved && phase === 'green' && this.speed < 0.5 &&
        event.visibility.signal.visible) event.waitedForGreen = true;
      if (event.properStop && event.pedestrianConfirmed && !pedestrianOccupied(event) &&
        event.pedestrian.cleared && event.conflictConfirmed && this.speed < 0.5) event.waitedForFullClear = true;
      if (event.properStop && (event.redObserved && !event.waitedForGreen ||
        event.pedestrianConfirmed && !event.waitedForFullClear) && this.speed > 2) event.earlyStart = true;
      if ((event.waitedForGreen || event.waitedForFullClear) && this.speed >= 40) event.resumeSpeedReached = true;

      const longitudinalPed = frontAfter > event.crosswalkS - 0.9 &&
        this.distance - C.CAR_LENGTH_M / 2 < event.crosswalkS + 0.9;
      if (event.pedestrian && !event.pedestrian.cleared && longitudinalPed &&
        Math.abs(this.lateral - event.pedestrian.x) < 1.5) event.closePass = true;

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
      this.lateral = 0;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoOverview = false;
      this.justResolved = null;
      this.activateEvent(event);
      this.status = 'driving';
    }

    startDemo() {
      if (!this.freezeInfo) return;
      const eventId = this.freezeInfo.eventId;
      const demo = new Simulation(this.seed, { eventId: eventId });
      demo.status = 'driving';
      this.demo = demo;
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.demoOverview = false;
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

  const Scoring = {
    eventObservation: function (event) {
      return event.observation || ((event.spacingEstablished ? 3 : 0) + (event.signalConfirmed ? 3 : 0) +
        (event.correctAction ? 4 : 0));
    },
    eventSafe: function (event) {
      return event.resolved && !event.failed && !event.unsafePass && !event.enteredAgainstRule &&
        !event.enteredWithoutConfirmation && !event.enteredOccupied && !event.closePass && event.minGap > 0.02;
    },
    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || !event.active) return false;
      const lineDistance = event.stopS - (simulation.distance + C.CAR_LENGTH_M / 2);
      if (lineDistance < -1 || lineDistance > C.APPROACH_DISTANCE + 2) return false;
      const phase = signalPhase(event);
      const gap = leaderGap(simulation, event);
      if (event.properStop && (event.redObserved && !event.waitedForGreen ||
        event.pedestrianConfirmed && !event.waitedForFullClear)) return true;
      if ((event.waitedForGreen || event.waitedForFullClear) && !event.resumeSpeedReached &&
        simulation.speed < 40 && simulation.acceleration >= 0) return true;
      if (phase === 'red' && lineDistance > 0 && simulation.speed < 35) return true;
      if (pedestrianOccupied(event) && lineDistance > 0 && (simulation.speed < 35 || gap < 35)) return true;
      if (event.leader.yieldStopped && gap < 35) return true;
      if (!event.signalConfirmed && lineDistance < 25 && simulation.speed < 25) return true;
      return false;
    },
    recordStep: function (state, simulation, dt) {
      if (!Scoring.isYieldExempt(simulation)) {
        const quality = Game.Scoring.speedQuality(simulation.speed, false);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const harsh = simulation.lastDeceleration > C.HARD_BRAKE && simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED &&
        !simulation.necessaryBraking;
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
      const observation = resolved.reduce(function (sum, event) { return sum + Scoring.eventObservation(event); }, 0);
      const safety = Math.round(clean.length * 40 / 3);
      const state = simulation.scoring;
      const efficiency = state.efficiencyTime > 0 ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
      const smooth = Math.max(0, 10 - state.hardBrakes * 2 - state.steerPenalties);
      const failed = simulation.events.some(function (event) { return event.failed; });
      let total = safety + observation + efficiency + smooth;
      if (failed) total = Math.min(total, 59);
      if (timedOut) total = Math.min(total, 69);
      total = Math.round(total);
      let grade = 'C';
      let titleKey = 'result.title.c';
      let summaryKey = 'result.summary.c';
      if (total >= 85 && !timedOut) {
        grade = 'A'; titleKey = 'result.title.a'; summaryKey = 'scene.obscured.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B'; titleKey = 'result.title.b'; summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout'; summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.obscured.result.advice.default';
      if (failed) adviceKey = 'scene.obscured.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.obscured.result.advice.observation';
      else if (state.steerPenalties) adviceKey = 'scene.obscured.result.advice.steering';
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
        earlySlowCount: simulation.events.filter(function (event) { return event.signalConfirmed; }).length,
        passedCount: clean.length,
        timedOut: Boolean(timedOut),
        failed: failed,
        adviceKey: adviceKey
      };
    }
  };

  function worldY(simulation, position) { return Draw.worldY(C, simulation, position); }
  function screenX(worldX) { return C.CAR_X + worldX * 12; }

  function drawLargeVehicle(ctx, simulation, event) {
    const leader = event.leader;
    if (!leader) return;
    const x = screenX(leader.x);
    const y = worldY(simulation, leader.s);
    const width = 34;
    const height = leader.length * C.PIXELS_PER_METER;
    if (y < -height || y > C.HEIGHT + height) return;
    Draw.rect(ctx, '#0d1c2466', x - width / 2 + 4, y - height / 2 + 5, width, height);
    Draw.rect(ctx, '#14232b', x - width / 2 - 3, y - height / 2 + 8, 3, 13);
    Draw.rect(ctx, '#14232b', x + width / 2, y - height / 2 + 8, 3, 13);
    Draw.rect(ctx, '#14232b', x - width / 2 - 3, y + height / 2 - 20, 3, 13);
    Draw.rect(ctx, '#14232b', x + width / 2, y + height / 2 - 20, 3, 13);
    Draw.rect(ctx, leader.color, x - width / 2, y - height / 2, width, height);
    Draw.rect(ctx, leader.type === 'bus' ? '#294651' : '#c4c9b6', x - width / 2 + 4, y - height / 2 + 5, width - 8, 12);
    if (leader.type === 'bus') {
      for (let wy = y - height / 2 + 21; wy < y + height / 2 - 12; wy += 13) {
        Draw.rect(ctx, '#385d65', x - width / 2 + 4, wy, width - 8, 8);
      }
    } else {
      Draw.rect(ctx, '#9da58f', x - width / 2 + 4, y - height / 2 + 22, width - 8, height - 30);
      Draw.rect(ctx, '#7f897a', x - 1, y - height / 2 + 22, 2, height - 30);
    }
    Draw.rect(ctx, leader.braking ? '#ff5148' : '#9e3d3b', x - width / 2 + 3, y + height / 2 - 4, 8, 4);
    Draw.rect(ctx, leader.braking ? '#ff5148' : '#9e3d3b', x + width / 2 - 11, y + height / 2 - 4, 8, 4);
  }

  function drawSignal(ctx, x, y, phase, visible) {
    Draw.rect(ctx, '#23343b', x - 2, y + 29, 4, 31);
    Draw.rect(ctx, '#14232b', x - 7, y - 5, 14, 36);
    Draw.rect(ctx, visible && phase === 'red' ? '#ff6459' : '#603b3b', x - 4, y - 2, 8, 8);
    Draw.rect(ctx, visible && phase === 'yellow' ? '#ffd166' : '#5c583b', x - 4, y + 9, 8, 8);
    Draw.rect(ctx, visible && phase === 'green' ? '#80e0b1' : '#315148', x - 4, y + 20, 8, 8);
    if (!visible) Draw.fillFittedText(ctx, '?', x - 3, y + 17, 8, 11, 'sans-serif');
  }

  function drawIntersection(ctx, simulation, event, revealHidden) {
    const stopY = worldY(simulation, event.stopS);
    const endY = worldY(simulation, event.conflictEndS);
    if (stopY < -120 || endY > C.HEIGHT + 120) return;
    const centerY = worldY(simulation, event.stopS + C.CONFLICT_DEPTH / 2);
    Draw.rect(ctx, '#a9aa96', 0, endY - 25, C.WIDTH, stopY - endY + 60);
    Draw.rect(ctx, '#3b484b', 0, endY - 15, C.WIDTH, stopY - endY + 40);
    for (let x = 10; x < C.WIDTH; x += 40) Draw.rect(ctx, '#697773', x, centerY, 22, 3);
    const crosswalkY = worldY(simulation, event.crosswalkS);
    for (let x = 178; x < 244; x += 15) Draw.rect(ctx, '#d8dcd2', x, crosswalkY - 8, 8, 16);
    Draw.rect(ctx, '#f0ead2', 176, stopY + 9, 70, 3);
    const visibility = event.visibility ? event.visibility.signal : signalVisibility(simulation, event);
    const showSignal = revealHidden || visibility.visible;
    drawSignal(ctx, screenX(event.signalX) + 37, stopY - 45, signalPhase(event), showSignal);
    Draw.rect(ctx, '#132633dd', 258, stopY - 36, 88, 18);
    Draw.fillFittedText(ctx, t(showSignal ? 'scene.obscured.canvas.' + signalPhase(event) : 'scene.obscured.canvas.unknown'),
      262, stopY - 23, 80, 8, 'sans-serif');
  }

  function drawSightLines(ctx, simulation, event) {
    const eyeX = screenX(simulation.lateral);
    const eyeY = worldY(simulation, simulation.distance + C.EYE_FORWARD);
    ctx.save();
    ctx.strokeStyle = '#80e0b188';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    [[screenX(event.signalX) + 37, worldY(simulation, event.signalS)],
      [screenX(-3.2), worldY(simulation, event.crosswalkS)],
      [screenX(3.2), worldY(simulation, event.crosswalkS)]].forEach(function (point) {
      ctx.beginPath(); ctx.moveTo(eyeX, eyeY); ctx.lineTo(point[0], point[1]); ctx.stroke();
    });
    ctx.restore();
    Draw.rect(ctx, '#80e0b1', eyeX - 2, eyeY - 2, 5, 5);
  }

  function drawWorld(ctx, simulation, demo, overview) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    Draw.drawEnvironment(ctx, simulation, C, 172);
    drawIntersection(ctx, simulation, event, overview);
    drawLargeVehicle(ctx, simulation, event);
    if (event.pedestrian && event.pedestrian.enabled && !event.pedestrian.cleared && event.localTime >= event.pedestrian.enterAt) {
      const visibility = event.visibility ? event.visibility.pedestrian : pedestrianVisibility(simulation, event);
      if (overview || visibility.visible) {
        Draw.drawPedestrian(ctx, C, screenX(event.pedestrian.x), worldY(simulation, event.crosswalkS), event.pedestrian, false, demo);
      }
    }
    Draw.drawCar(ctx, screenX(simulation.lateral), C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    if (simulation.lastDeceleration > 0.8) {
      const x = screenX(simulation.lateral);
      Draw.rect(ctx, '#ff665c', x - 11, C.CAR_Y + 19, 7, 4);
      Draw.rect(ctx, '#ff665c', x + 4, C.CAR_Y + 19, 7, 4);
    }
    if (overview) drawSightLines(ctx, simulation, event);
    if (demo) {
      Draw.rect(ctx, '#0e202ddd', 14, 548, 332, 43);
      Draw.fillFittedText(ctx, t(overview ? 'scene.obscured.canvas.overview' : 'scene.obscured.canvas.driverView'),
        23, 570, 314, 10, 'sans-serif');
    }
    if (simulation.status === 'frozen') {
      Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
      const x = screenX(simulation.lateral);
      Draw.rect(ctx, '#fff0b0', x + 24, C.CAR_Y - 25, 22, 24);
      Draw.rect(ctx, '#3b2a0e', x + 33, C.CAR_Y - 21, 4, 10);
      Draw.rect(ctx, '#3b2a0e', x + 33, C.CAR_Y - 8, 4, 4);
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        drawWorld(ctx, simulation.demo, true, simulation.demoOverview);
      } else drawWorld(ctx, simulation, false, false);
    }
  };

  const Geometry = {
    segmentIntersectsBox3D: segmentIntersectsBox3D,
    eyePoint: eyePoint,
    leaderBox: leaderBox,
    signalVisibility: signalVisibility,
    pedestrianVisibility: pedestrianVisibility,
    conflictZoneVisibility: conflictZoneVisibility
  };

  const Scene = {
    id: 'obscured-signal-intersection',
    Constants: C,
    Geometry: Geometry,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    createPlan: createPlan,
    signalPhase: signalPhase,
    leaderGap: leaderGap,
    pedestrianPosition: pedestrianPosition,
    pedestrianOccupied: pedestrianOccupied,
    assessFollowingSpace: assessFollowingSpace,
    predictLeaderConflict: predictLeaderConflict,
    predictCrossingConflict: predictCrossingConflict,
    defensiveInput: defensiveInput,
    ui: {
      progress: function (simulation) {
        return t('scene.obscured.hud.progress', {
          resolved: simulation.events.filter(function (event) { return event.resolved; }).length
        });
      },
      liveStats: function (simulation) {
        return [simulation.events.filter(function (event) { return event.signalConfirmed; }).length,
          simulation.scoring.hardBrakes, simulation.events.filter(Scoring.eventSafe).length];
      },
      smoothScore: function (simulation) {
        return Math.max(0, 10 - simulation.scoring.hardBrakes * 2 - simulation.scoring.steerPenalties);
      },
      coach: function (simulation) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (!event || !event.active) return { text: t('scene.obscured.hud.cruise'), status: t('hud.cruiseGood'), coachTone: '', tone: '' };
        const visibility = event.visibility || { signal: signalVisibility(current, event), pedestrian: pedestrianVisibility(current, event) };
        if (visibility.pedestrian.visible && !event.pedestrian.cleared) {
          return { text: t('scene.obscured.hud.pedestrian'), status: t('hud.prepareStop'), coachTone: 'risk', tone: 'warn' };
        }
        if (event.properStop && (event.redObserved && !event.waitedForGreen || event.pedestrianConfirmed && !event.waitedForFullClear)) {
          return { text: t('scene.obscured.hud.wait'), status: t('scene.obscured.hud.stopped'), coachTone: 'good', tone: '' };
        }
        if (event.leader.braking && !visibility.pedestrian.visible) {
          return { text: t('scene.obscured.hud.leaderBrake'), status: t('scene.obscured.hud.spaceStatus'), coachTone: 'risk', tone: 'warn' };
        }
        if (!visibility.signal.visible) {
          return { text: t('scene.obscured.hud.occluded'), status: t('scene.obscured.hud.recoverStatus'), coachTone: 'risk', tone: '' };
        }
        const phase = signalPhase(event);
        if (phase !== 'green') return { text: t('scene.obscured.hud.' + phase), status: t('hud.prepareStop'), coachTone: 'risk', tone: 'warn' };
        if (event.pedestrian && event.pedestrian.cleared && !event.waitedForFullClear) {
          return { text: t('scene.obscured.hud.cleared'), status: t('scene.obscured.hud.recheckStatus'), coachTone: 'good', tone: '' };
        }
        return { text: t('scene.obscured.hud.green'), status: t('hud.cruiseGood'), coachTone: 'good', tone: '' };
      },
      retryToast: function () { return { key: 'scene.obscured.toast.retry', params: {}, neutral: true }; },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return { key: score === 10 ? 'scene.obscured.toast.safe' : 'scene.obscured.toast.improve',
          params: { score: score }, neutral: score !== 10 };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.obscured.failure.' + info.reason, {
          speed: Math.round(info.speed),
          remaining: Math.max(0, info.lineDistance).toFixed(1),
          gap: Math.max(0, info.gap).toFixed(1),
          visible: info.signalFirstVisibleAt == null ? '—' : info.signalFirstVisibleAt.toFixed(1)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo && demo.currentEvent;
        if (!event) return { step: '', substep: '' };
        if (!event.signalConfirmed) return { step: t('scene.obscured.demo.space'), substep: t('scene.obscured.demo.spaceSub') };
        if (event.properStop && (event.redObserved && !event.waitedForGreen || event.pedestrianConfirmed && !event.waitedForFullClear)) {
          return { step: t('scene.obscured.demo.wait'), substep: t('scene.obscured.demo.waitSub') };
        }
        return { step: t('scene.obscured.demo.proceed'), substep: t('scene.obscured.demo.proceedSub') };
      },
      updateControls: function (doc, simulation) {
        const button = doc.getElementById('replay-view-button');
        if (!button) return;
        button.hidden = simulation.status !== 'demonstrating';
        button.textContent = t(simulation.demoOverview ? 'scene.obscured.view.driver' : 'scene.obscured.view.overview');
        button.setAttribute('aria-pressed', String(simulation.demoOverview));
      }
    },
    bindControls: function (doc, getSimulation) {
      const button = doc.getElementById('replay-view-button');
      if (button) button.addEventListener('click', function () {
        const simulation = getSimulation();
        if (simulation.status === 'demonstrating') simulation.demoOverview = !simulation.demoOverview;
      });
    }
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
