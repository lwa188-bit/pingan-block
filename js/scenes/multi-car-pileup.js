(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;

  function t(key, params) {
    return Game.I18N ? Game.I18N.t(key, params) : key;
  }

  // ---------------------------------------------------------------------------
  // Constants and condition packs
  // ---------------------------------------------------------------------------

  const CONDITIONS = Object.freeze({
    urban: Object.freeze({
      id: 'urban', road: 'urban', weather: 'dry', headway: 3,
      maxSpeed: 65, normalDecel: 3.8, emergencyDecel: 6.8,
      naturalDecel: 0.35, recovery: 2.0,
      cruiseMin: 45, cruiseMax: 60,
      visibilityRange: 250, brakeLightContrast: 1.0,
      reactionTime: 0.75
    }),
    highway: Object.freeze({
      id: 'highway', road: 'highway', weather: 'dry', headway: 3,
      maxSpeed: 125, normalDecel: 3.8, emergencyDecel: 6.8,
      naturalDecel: 0.35, recovery: 1.8,
      cruiseMin: 85, cruiseMax: 120,
      visibilityRange: 450, brakeLightContrast: 1.0,
      reactionTime: 0.75
    }),
    rain: Object.freeze({
      id: 'rain', road: 'highway', weather: 'rain', headway: 4,
      maxSpeed: 95, normalDecel: 2.65, emergencyDecel: 4.6,
      naturalDecel: 0.28, recovery: 1.35,
      cruiseMin: 60, cruiseMax: 90,
      visibilityRange: 420, brakeLightContrast: 0.65,
      reactionTime: 0.85
    })
  });

  const C = Object.assign({}, Game.C, {
    EVENT_POSITIONS: [140, 560, 960],
    APPROACH_DISTANCE: 120,
    FINISH_DISTANCE: 1250,
    MAX_SPEED: 125,
    MAX_TIME: 110,
    MAX_INACTIVE_TIME: 12,
    START_SPEED: 50,
    PREDICT_STEP: 0.025,
    PREDICT_HORIZON: 4.5,
    COLLISION_GAP: 0.8,
    FREEZE_GAP: 0.5,
    CN_RULES: Object.freeze({
      id: 'CN',
      highway: Object.freeze({ threshold: 100, above: 100, below: 50 })
    }),
    GENERIC_RULES: Object.freeze({ id: 'GENERIC', highway: null })
  });

  const TEMPLATES = ['urban-chain', 'highway-chain', 'rain-chain'];
  const VEHICLE_TYPES = ['sedan', 'suv', 'truck'];
  const TRIGGER_CAUSES = ['pedestrian', 'obstacle', 'queue', 'accident'];
  const COLORS = ['#d7b957', '#7fa6b2', '#c5c9b8', '#d98468', '#9b8ec4', '#6fa88f'];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

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

  // ---------------------------------------------------------------------------
  // Plan generation
  // ---------------------------------------------------------------------------

  function createPlan(seed) {
    const random = M.mulberry32(M.hashSeed('multi-car-pileup:' + seed));
    const templates = shuffle(TEMPLATES, random);
    const events = C.EVENT_POSITIONS.map(function (triggerS, id) {
      const template = templates[id];
      const conditionId = template === 'urban-chain' ? 'urban' :
        (template === 'highway-chain' ? 'highway' : 'rain');
      const condition = CONDITIONS[conditionId];
      const leaderCount = template === 'highway-chain' ? 4 : 3;
      const initialPlayerSpeed = condition.cruiseMin + random() * (condition.cruiseMax - condition.cruiseMin);
      const initialLegalDistance = condition.road === 'highway' ?
        (initialPlayerSpeed > C.CN_RULES.highway.threshold ? C.CN_RULES.highway.above : C.CN_RULES.highway.below) : 0;
      const initialSpeedMS = initialPlayerSpeed / 3.6;
      const initialStoppingDistance = initialSpeedMS * condition.reactionTime +
        initialSpeedMS * initialSpeedMS / (2 * condition.normalDecel);
      const initialPlayerGap = Math.max(
        condition.headway * (0.9 + random() * 0.3),
        initialLegalDistance / initialSpeedMS * 1.05,
        initialStoppingDistance / initialSpeedMS * 1.05
      );

      const leaders = [];
      let currentS = triggerS;
      for (let i = 0; i < leaderCount; i += 1) {
        // Before reversing, i=0 is the nearest vehicle. Keep it low so it does
        // not hide the entire chain from the player.
        const isNearest = i === 0;
        const typePool = isNearest ? ['sedan', 'suv'] : VEHICLE_TYPES;
        const type = typePool[Math.floor(random() * typePool.length)];
        const length = type === 'truck' ? 8.5 : (type === 'suv' ? 4.8 : 4.2);
        const width = type === 'truck' ? 2.5 : 1.85;
        const height = type === 'truck' ? 3.2 : (type === 'suv' ? 1.8 : 1.45);
        const cruiseSpeed = initialPlayerSpeed + (random() - 0.5) * 4;
        const targetSpeed = template === 'rain-chain' && i === leaderCount - 1 ? 0 :
          Math.max(15, cruiseSpeed - (25 + random() * 20));
        leaders.push(Object.freeze({
          id: i,
          type: type,
          length: length,
          width: width,
          height: height,
          initialS: currentS,
          cruiseSpeed: cruiseSpeed,
          targetSpeed: targetSpeed,
          reactionTime: condition.reactionTime + random() * 0.25,
          comfortableDecel: condition.normalDecel * (0.9 + random() * 0.2),
          emergencyDecel: condition.emergencyDecel,
          brakeLightDelay: 0.08 + random() * 0.06,
          color: COLORS[Math.floor(random() * COLORS.length)]
        }));
        currentS += length + cruiseSpeed / 3.6 * condition.headway * (0.85 + random() * 0.3);
      }
      // Reverse so that id=0 is the front-most (farthest) vehicle and the
      // highest id is the nearest leader. This matches the follower logic in
      // advanceLeader, where vehicle i follows vehicle i-1.
      leaders.reverse();
      leaders.forEach(function (leader, index) {
        leader = Object.assign({}, leader, { id: index });
        leaders[index] = Object.freeze(leader);
      });

      // Place the player so the initial bumper gap matches the planned headway
      // instead of leaving an excessive fixed approach distance.
      const nearestLength = leaders[leaders.length - 1].length;
      const initialGapMeters = initialPlayerSpeed / 3.6 * initialPlayerGap;
      const approachStartS = triggerS - initialGapMeters - C.CAR_LENGTH_M / 2 - nearestLength / 2;

      return Object.freeze({
        id: id,
        template: template,
        conditionId: conditionId,
        triggerS: triggerS,
        approachStartS: approachStartS,
        finishS: triggerS + 80,
        initialPlayerSpeed: initialPlayerSpeed,
        initialPlayerGap: initialPlayerGap,
        leaderCount: leaderCount,
        leaders: Object.freeze(leaders),
        triggerCause: TRIGGER_CAUSES[Math.floor(random() * TRIGGER_CAUSES.length)],
        visibilityModifier: condition.brakeLightContrast
      });
    });
    return Object.freeze({ seed: seed, rulePackId: 'CN', events: Object.freeze(events) });
  }

  // ---------------------------------------------------------------------------
  // Runtime event state
  // ---------------------------------------------------------------------------

  function createLeaderRuntime(plan) {
    return {
      id: plan.id,
      distance: plan.initialS,
      speed: plan.cruiseSpeed,
      acceleration: 0,
      state: 'cruise',
      stateTime: 0,
      reactionTimer: 0,
      brakeLightOn: false,
      brakeLightTimer: 0,
      brakeStartedAt: null,
      stopped: false,
      plan: plan
    };
  }

  function createRuntimeEvent(plan) {
    return {
      id: plan.id,
      active: false,
      triggered: false,
      controlInputReceived: false,
      localTime: 0,
      resolved: false,
      failed: false,
      attempts: 0,
      leaders: plan.leaders.map(createLeaderRuntime),
      // Observation tracking
      distantCueFirstSeenAt: null,
      distantCueType: null,
      distantCueLeaderId: null,
      immediateLeadBrakeAt: null,
      playerResponseAt: null,
      distantCueResponseAt: null,
      earlyRecognition: false,
      // Gap tracking
      minGapRatioBefore: Infinity,
      gapAtTrigger: 0,
      headwayAtTrigger: 0,
      priorHeadwayOK: false,
      stableFollowTime: 0,
      approachTime: 0,
      approachSpeedIntegral: 0,
      approachMaxSpeed: 0,
      // Scoring
      observationScore: 0,
      safe: false,
      closePass: false,
      hardBrakeRecorded: false,
      minGapDuringEvent: Infinity,
      // Plan reference
      plan: plan
    };
  }

  function resetEventRuntime(event) {
    const preserved = {
      failed: event.failed,
      attempts: event.attempts,
      resolved: event.resolved
    };
    const fresh = createRuntimeEvent(event.plan);
    Object.keys(event).forEach(function (key) { delete event[key]; });
    Object.assign(event, fresh, preserved);
  }

  // ---------------------------------------------------------------------------
  // Geometry and visibility
  // ---------------------------------------------------------------------------

  function playerFront(simulation) {
    return simulation.distance + C.CAR_LENGTH_M / 2;
  }

  function playerRear(simulation) {
    return simulation.distance - C.CAR_LENGTH_M / 2;
  }

  function leaderRear(leader) {
    return leader.distance - leader.plan.length / 2;
  }

  function leaderFront(leader) {
    return leader.distance + leader.plan.length / 2;
  }

  function bumperGap(simulation, leader) {
    return leaderRear(leader) - playerFront(simulation);
  }

  function timeGap(simulation, leader) {
    return Math.max(0, bumperGap(simulation, leader)) / Math.max(simulation.speed / 3.6, 0.1);
  }

  function nearestLeader(event) {
    if (!event || !event.leaders.length) return null;
    let nearest = event.leaders[0];
    for (let i = 1; i < event.leaders.length; i += 1) {
      if (event.leaders[i].distance < nearest.distance) nearest = event.leaders[i];
    }
    return nearest;
  }

  function conditionFor(simulation) {
    const event = simulation.currentEvent || simulation.events[simulation.events.length - 1];
    return CONDITIONS[event ? event.plan.conditionId : 'urban'];
  }

  function legalMinimumDistance(simulation) {
    const condition = conditionFor(simulation);
    if (condition.road !== 'highway') return 0;
    const rule = simulation.rulePack && simulation.rulePack.highway;
    if (!rule) return 0;
    return simulation.speed > rule.threshold ? rule.above : rule.below;
  }

  function recommendedHeadway(simulation) {
    const speed = Math.max(simulation.speed / 3.6, 0.1);
    return recommendedDistance(simulation) / speed;
  }

  function recommendedDistance(simulation) {
    const condition = conditionFor(simulation);
    return Math.max(
      simulation.speed / 3.6 * condition.headway,
      legalMinimumDistance(simulation),
      stoppingDistanceFor(simulation)
    );
  }

  function stoppingDistanceFor(simulation) {
    const condition = conditionFor(simulation);
    const speed = simulation.speed / 3.6;
    return speed * condition.reactionTime + speed * speed / (2 * condition.normalDecel);
  }

  function segmentIntersectsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
    // Slab method for segment-AABB intersection
    const dx = x2 - x1;
    const dy = y2 - y1;
    let tMin = 0;
    let tMax = 1;
    if (Math.abs(dx) < 1e-9) {
      if (x1 < rx || x1 > rx + rw) return false;
    } else {
      let t1 = (rx - x1) / dx;
      let t2 = (rx + rw - x1) / dx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
    if (Math.abs(dy) < 1e-9) {
      if (y1 < ry || y1 > ry + rh) return false;
    } else {
      let t1 = (ry - y1) / dy;
      let t2 = (ry + rh - y1) / dy;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
    return true;
  }

  function visibilityFor(simulation, event, leaderId) {
    const condition = conditionFor(simulation);
    const eyeX = C.CAR_X;
    const eyeS = simulation.distance + 1.2; // eye point inside player car
    const eyeHeight = 1.2;

    const target = event.leaders[leaderId];
    if (!target) return { visible: false, occluderId: null };

    const targetS = target.distance;
    const targetHeight = target.plan.height * 0.75; // brake light height
    const distance = targetS - eyeS;
    if (distance <= 0 || distance > condition.visibilityRange) {
      return { visible: false, occluderId: null };
    }

    // Check occlusion by intermediate vehicles (closer to player). A nearer
    // vehicle only blocks the target's brake lights when its roof is above the
    // target light height; taller distant vehicles remain visible over sedans.
    for (let i = 0; i < event.leaders.length; i += 1) {
      if (i === leaderId) continue;
      const occluder = event.leaders[i];
      const occS = occluder.distance;
      if (occS <= eyeS || occS >= targetS) continue; // not between eye and target

      const occHeight = occluder.plan.height;
      // Only a substantially taller vehicle fully hides the brake lights.
      // Similar-height traffic still allows the lights to be seen over the roof.
      if (occHeight > targetHeight + 0.8) {
        return { visible: false, occluderId: i };
      }
    }

    // Weather/contrast check
    const contrast = condition.brakeLightContrast;
    const effectiveRange = condition.visibilityRange * contrast;
    if (distance > effectiveRange) {
      return { visible: false, occluderId: null };
    }

    return { visible: true, occluderId: null };
  }

  function anyDistantCueVisible(simulation, event) {
    // Check if any leader beyond the nearest is visible and braking
    const nearest = nearestLeader(event);
    if (!nearest) return null;
    for (let i = 0; i < event.leaders.length; i += 1) {
      const leader = event.leaders[i];
      if (leader.id === nearest.id) continue;
      if (!leader.brakeLightOn) continue;
      const vis = visibilityFor(simulation, event, i);
      if (vis.visible) {
        return { leaderId: i, type: 'brakeLight' };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Vehicle state machines
  // ---------------------------------------------------------------------------

  function advanceLeader(leader, event, dt) {
    const plan = leader.plan;
    leader.stateTime += dt;

    if (leader.state === 'cruise') {
      // Check if this is the front-most leader and should trigger
      if (leader.id === 0 && !event.triggered && leader.distance >= event.plan.triggerS && event.active) {
        event.triggered = true;
        leader.state = 'braking';
        leader.stateTime = 0;
      } else if (leader.id > 0) {
        // Check if vehicle ahead is braking and too close
        const ahead = event.leaders[leader.id - 1];
        const gap = (ahead.distance - ahead.plan.length / 2) - (leader.distance + plan.length / 2);
        const stopDistance = Math.pow(leader.speed / 3.6, 2) / (2 * plan.comfortableDecel);
        const reactionDistance = leader.speed / 3.6 * plan.reactionTime;
        const aheadBraking = ahead.state === 'braking' || ahead.state === 'holding';
        if ((aheadBraking && gap < stopDistance + reactionDistance + 5) || gap < 8) {
          leader.reactionTimer += dt;
          if (leader.reactionTimer >= plan.reactionTime) {
            leader.state = 'braking';
            leader.stateTime = 0;
          }
        } else {
          leader.reactionTimer = 0;
        }
      }
    }

    if (leader.state === 'braking') {
      if (leader.brakeStartedAt === null) leader.brakeStartedAt = event.localTime;
      const speedRatio = leader.speed / Math.max(plan.cruiseSpeed, 1);
      const decel = plan.comfortableDecel * (1 + (1 - speedRatio) * 0.3);
      leader.acceleration = -decel;
      if (leader.speed <= plan.targetSpeed + 0.5) {
        leader.speed = plan.targetSpeed;
        leader.state = 'holding';
        leader.stateTime = 0;
        leader.acceleration = 0;
      }
      if (!leader.brakeLightOn && leader.stateTime >= plan.brakeLightDelay) {
        leader.brakeLightOn = true;
      }
    } else if (leader.state === 'holding') {
      leader.acceleration = 0;
      leader.speed = plan.targetSpeed;
      if (leader.speed < 0.3) leader.stopped = true;
      // Check if vehicle ahead has recovered
      if (leader.id > 0) {
        const ahead = event.leaders[leader.id - 1];
        if (ahead.state === 'recovering' || ahead.state === 'cruise') {
          const gap = (ahead.distance - ahead.plan.length / 2) - (leader.distance + plan.length / 2);
          if (gap > 12) {
            leader.state = 'recovering';
            leader.stateTime = 0;
          }
        }
      } else if (leader.id === 0) {
        // Front-most vehicle eventually recovers even after a full stop.
        const holdDuration = plan.targetSpeed > 1 ? 2.5 : 4.0;
        if (leader.stateTime > holdDuration) {
          leader.state = 'recovering';
          leader.stateTime = 0;
        }
      }
    } else if (leader.state === 'recovering') {
      leader.acceleration = plan.recovery || 1.5;
      leader.brakeLightOn = false;
      if (leader.speed >= plan.cruiseSpeed - 0.5) {
        leader.speed = plan.cruiseSpeed;
        leader.state = 'cruise';
        leader.stateTime = 0;
        leader.acceleration = 0;
      }
    } else {
      leader.acceleration = 0;
    }

    const oldSpeed = leader.speed / 3.6;
    const nextSpeed = clamp(oldSpeed + leader.acceleration * dt, 0, C.MAX_SPEED / 3.6);
    leader.speed = nextSpeed * 3.6;
    leader.distance += (oldSpeed + nextSpeed) * 0.5 * dt;
    if (leader.speed < 0.3) leader.stopped = true;
    else leader.stopped = false;
  }

  // ---------------------------------------------------------------------------
  // Collision prediction
  // ---------------------------------------------------------------------------

  function predictConflict(simulation, input) {
    const event = simulation.currentEvent;
    if (!event || !event.active) return null;
    const nearest = nearestLeader(event);
    if (!nearest) return null;

    // Clone player and nearest leader
    let playerDist = simulation.distance;
    let playerSpeed = simulation.speed;
    let leaderDist = nearest.distance;
    let leaderSpeed = nearest.speed;
    const leaderPlan = nearest.plan;
    let leaderState = nearest.state;
    let leaderStateTime = nearest.stateTime;

    const condition = conditionFor(simulation);
    const dt = C.PREDICT_STEP;
    let minGap = bumperGap(simulation, nearest);
    let timeToContact = null;

    for (let time = 0; time < C.PREDICT_HORIZON; time += dt) {
      // Advance player
      let acceleration = -condition.naturalDecel;
      if (input.throttle && !input.brake) acceleration = C.ACCELERATION;
      if (input.brake) {
        const gap = (leaderDist - leaderPlan.length / 2) - (playerDist + C.CAR_LENGTH_M / 2);
        const emergency = gap < 12 && playerSpeed > 20;
        acceleration = -(emergency ? condition.emergencyDecel : condition.normalDecel);
      }
      const oldSpeed = playerSpeed / 3.6;
      const nextSpeed = clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      playerSpeed = nextSpeed * 3.6;
      playerDist += (oldSpeed + nextSpeed) * 0.5 * dt;

      // Advance leader (simplified state machine)
      leaderStateTime += dt;
      if (leaderState === 'cruise' && leaderDist >= event.plan.triggerS) {
        leaderState = 'braking';
        leaderStateTime = 0;
      }
      let leaderAccel = 0;
      if (leaderState === 'braking') {
        leaderAccel = -leaderPlan.comfortableDecel;
        if (leaderSpeed <= leaderPlan.targetSpeed + 0.5) {
          leaderSpeed = leaderPlan.targetSpeed;
          leaderState = 'holding';
        }
      } else if (leaderState === 'holding') {
        leaderSpeed = leaderPlan.targetSpeed;
      }
      const oldLeaderSpeed = leaderSpeed / 3.6;
      const nextLeaderSpeed = clamp(oldLeaderSpeed + leaderAccel * dt, 0, C.MAX_SPEED / 3.6);
      leaderSpeed = nextLeaderSpeed * 3.6;
      leaderDist += (oldLeaderSpeed + nextLeaderSpeed) * 0.5 * dt;

      const gap = (leaderDist - leaderPlan.length / 2) - (playerDist + C.CAR_LENGTH_M / 2);
      if (gap < minGap) minGap = gap;
      if (gap <= C.COLLISION_GAP && timeToContact === null) {
        timeToContact = time;
      }
    }

    return {
      minGap: minGap,
      timeToContact: timeToContact,
      leaderId: nearest.id
    };
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  class Simulation {
    constructor(seed, options) {
      options = options || {};
      this.seed = seed;
      this.plan = createPlan(seed);
      this.rulePack = options.rulePack || C.CN_RULES;
      this.events = this.plan.events.map(function (plan) {
        return createRuntimeEvent(plan);
      });
      const hasEventOption = options.eventId != null;
      this.eventIndex = hasEventOption ? options.eventId : 0;
      for (let index = 0; index < this.eventIndex; index += 1) {
        this.events[index].resolved = true;
        this.events[index].observationScore = 10;
        this.events[index].safe = true;
        this.events[index].earlyRecognition = true;
        this.events[index].priorHeadwayOK = true;
      }
      this.distance = this.events[this.eventIndex].plan.approachStartS;
      this.speed = this.events[this.eventIndex].plan.initialPlayerSpeed;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.elapsed = 0;
      this.inactiveTime = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.view = 'front';
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoMode = 'driver';
      this.demoKind = 'lesson';
      this.demoPaused = false;
      this.replayReturnStatus = null;
      this.activateEvent(this.currentEvent);
    }

    get currentEvent() {
      const event = this.events[this.eventIndex];
      return event && !event.resolved ? event : null;
    }

    start() {
      this.status = 'driving';
    }

    activateEvent(event) {
      if (!event || event.active) return;
      event.active = true;
      event.localTime = 0;
      event.triggered = false;
      // Start each event from its immutable plan so the chain unfolds from a
      // consistent state rather than from wherever the vehicles happened to be.
      for (let i = 0; i < event.leaders.length; i += 1) {
        const leader = event.leaders[i];
        const plan = leader.plan;
        leader.distance = plan.initialS;
        leader.speed = plan.cruiseSpeed;
        leader.acceleration = 0;
        leader.state = 'cruise';
        leader.stateTime = 0;
        leader.reactionTimer = 0;
        leader.brakeLightOn = false;
        leader.brakeLightTimer = 0;
        leader.brakeStartedAt = null;
        leader.stopped = false;
      }
      event.gapAtTrigger = bumperGap(this, nearestLeader(event));
      event.headwayAtTrigger = timeGap(this, nearestLeader(event));
      event.priorHeadwayOK = event.headwayAtTrigger >= recommendedHeadway(this) * 0.85;
    }

    updateObservation(event, input, dt) {
      if (!event.active) return;

      // Track player response
      if (event.playerResponseAt === null && (input.brake || (!input.throttle && this.speed < this.previousSpeed - 0.5))) {
        event.playerResponseAt = event.localTime;
      }

      // Track immediate lead brake
      const nearest = nearestLeader(event);
      if (nearest && nearest.brakeLightOn && event.immediateLeadBrakeAt === null) {
        event.immediateLeadBrakeAt = event.localTime;
      }

      // Track distant cue
      if (event.distantCueFirstSeenAt === null) {
        const cue = anyDistantCueVisible(this, event);
        if (cue) {
          event.distantCueFirstSeenAt = event.localTime;
          event.distantCueType = cue.type;
          event.distantCueLeaderId = cue.leaderId;
        }
      }

      const defensiveResponse = input.brake ||
        (!input.throttle && this.speed < this.previousSpeed - 0.5);
      if (event.distantCueResponseAt === null && event.distantCueFirstSeenAt !== null &&
          event.immediateLeadBrakeAt === null && defensiveResponse) {
        event.distantCueResponseAt = event.localTime;
      }

      // Check early recognition using a response made while the distant cue is
      // visible. Routine speed matching before the cue must not consume the
      // one-shot playerResponseAt timestamp and make a later response invisible.
      if (!event.earlyRecognition && event.distantCueFirstSeenAt !== null && event.distantCueResponseAt !== null) {
        if (event.immediateLeadBrakeAt === null || event.distantCueResponseAt < event.immediateLeadBrakeAt) {
          event.earlyRecognition = true;
        }
      }

      // Track stable following
      const gap = bumperGap(this, nearest);
      const recommended = recommendedDistance(this);
      if (gap >= recommended * 0.85 && gap <= recommended * 1.5) {
        event.stableFollowTime += dt;
      }

      // Track approach
      if (event.localTime < 3) {
        event.approachTime += dt;
        event.approachSpeedIntegral += this.speed * dt;
        event.approachMaxSpeed = Math.max(event.approachMaxSpeed, this.speed);
      }

      // Track minimum gap
      if (gap < event.minGapDuringEvent) event.minGapDuringEvent = gap;
      const gapRatio = gap / Math.max(recommended, 1);
      if (gapRatio < event.minGapRatioBefore) event.minGapRatioBefore = gapRatio;
    }

    freeze(event, reason) {
      if (this.status !== 'driving') return;
      event.failed = true;
      event.attempts += 1;
      const nearest = nearestLeader(event);
      this.freezeInfo = {
        eventId: event.id,
        reason: reason,
        speed: this.speed,
        gap: nearest ? bumperGap(this, nearest) : 0,
        headway: nearest ? timeGap(this, nearest) : 0,
        stoppingDistance: stoppingDistanceFor(this),
        recommendedDistance: recommendedDistance(this),
        distantCueSeen: event.distantCueFirstSeenAt !== null,
        earlyRecognition: event.earlyRecognition,
        conditionId: event.plan.conditionId
      };
      this.status = 'frozen';
    }

    resolveEvent(event) {
      event.observationScore =
        (event.earlyRecognition ? 4 : 0) +
        (event.priorHeadwayOK ? 4 : 0) +
        (event.stableFollowTime > 2 ? 2 : 0);
      event.safe = !event.failed && !event.closePass && event.minGapDuringEvent > C.COLLISION_GAP;
      event.resolved = true;
      this.justResolved = event;
      if (this.eventIndex === this.events.length - 1) {
        this.status = 'complete';
        this.speed = 0;
        return;
      }
      this.eventIndex += 1;
      const nextEvent = this.currentEvent;
      if (nextEvent) {
        this.distance = nextEvent.plan.approachStartS;
        this.speed = nextEvent.plan.initialPlayerSpeed;
        this.previousSpeed = this.speed;
        this.lastDeceleration = 0;
        this.acceleration = 0;
        this.activateEvent(nextEvent);
      }
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
      if (!event.active && this.distance >= event.plan.approachStartS) this.activateEvent(event);
      if (input.throttle || input.brake) event.controlInputReceived = true;
      this.inactiveTime = input.throttle || input.brake ? 0 : this.inactiveTime + dt;

      this.elapsed += dt;
      if (this.inactiveTime >= C.MAX_INACTIVE_TIME) {
        this.speed = 0;
        this.status = 'timeout';
        return;
      }
      if (event.active) event.localTime += dt;

      // Save pre-step state for rollback
      const previousDistance = this.distance;
      const previousSpeed = this.speed;
      const previousLeaderStates = event.leaders.map(function (leader) {
        return {
          distance: leader.distance,
          speed: leader.speed,
          state: leader.state,
          stateTime: leader.stateTime,
          reactionTimer: leader.reactionTimer,
          brakeStartedAt: leader.brakeStartedAt,
          brakeLightOn: leader.brakeLightOn
        };
      });

      // Predict conflict with current input
      const prediction = predictConflict(this, input);
      if (prediction && prediction.timeToContact !== null && prediction.timeToContact < 0.08) {
        // Check if full braking can avoid
        const brakePrediction = predictConflict(this, { brake: true });
        if (brakePrediction && brakePrediction.minGap <= C.COLLISION_GAP) {
          this.freeze(event, 'chain');
          return;
        }
      }

      // Advance player
      const condition = conditionFor(this);
      this.previousSpeed = this.speed;
      let acceleration = -condition.naturalDecel;
      if (input.throttle && !input.brake) acceleration = C.ACCELERATION;
      if (input.brake) {
        const nearest = nearestLeader(event);
        const gap = nearest ? bumperGap(this, nearest) : 100;
        const emergency = gap < 12 && this.speed > 20;
        acceleration = -(emergency ? condition.emergencyDecel : condition.normalDecel);
      }
      this.acceleration = acceleration;
      const oldSpeed = this.speed / 3.6;
      const nextSpeed = clamp(oldSpeed + acceleration * dt, 0, condition.maxSpeed / 3.6);
      this.speed = nextSpeed * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeed - nextSpeed) / dt);
      this.distance += (oldSpeed + nextSpeed) * 0.5 * dt;

      // Advance leaders
      for (let i = 0; i < event.leaders.length; i += 1) {
        advanceLeader(event.leaders[i], event, dt);
      }

      // Update observation
      this.updateObservation(event, input, dt);

      // Check actual contact
      const nearest = nearestLeader(event);
      if (nearest) {
        const gap = bumperGap(this, nearest);
        if (gap <= 0.05) {
          // Rollback
          this.distance = previousDistance;
          this.speed = previousSpeed;
          for (let i = 0; i < event.leaders.length; i += 1) {
            event.leaders[i].distance = previousLeaderStates[i].distance;
            event.leaders[i].speed = previousLeaderStates[i].speed;
            event.leaders[i].state = previousLeaderStates[i].state;
            event.leaders[i].stateTime = previousLeaderStates[i].stateTime;
            event.leaders[i].reactionTimer = previousLeaderStates[i].reactionTimer;
            event.leaders[i].brakeStartedAt = previousLeaderStates[i].brakeStartedAt;
            event.leaders[i].brakeLightOn = previousLeaderStates[i].brakeLightOn;
          }
          this.freeze(event, 'contact');
          return;
        }
        // Check close pass
        if (gap < 2 && this.speed > 15 && !event.closePass) {
          event.closePass = true;
        }
      }

      // Scoring
      Scoring.recordStep(this.scoring, this, dt);

      // Check event resolution: player has passed the conflict zone and traffic is recovering.
      const trafficRecovering = event.leaders.every(function (leader) {
        return leader.state === 'recovering' || leader.state === 'cruise';
      });
      const passedConflict = this.distance > event.plan.triggerS + 50;
      const passedAllLeaders = event.leaders.every(function (leader) {
        return playerFront(this) > leaderFront(leader) + 5;
      }, this);
      const followingRecoveredTraffic = nearest && this.speed > 2 &&
        bumperGap(this, nearest) >= 0 &&
        bumperGap(this, nearest) <= Math.max(40, recommendedDistance(this) * 2.5);
      // Recovering traffic far ahead is not, by itself, completion: a coasting
      // or stopped player must rejoin the flow before the next event begins.
      if (event.controlInputReceived && passedConflict &&
          (passedAllLeaders || (trafficRecovering && followingRecoveredTraffic))) {
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
      resetEventRuntime(event);
      this.distance = event.plan.approachStartS;
      this.speed = event.plan.initialPlayerSpeed;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.inactiveTime = 0;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoMode = 'driver';
      this.demoKind = 'lesson';
      this.demoPaused = false;
      this.replayReturnStatus = null;
      this.justResolved = null;
      this.activateEvent(event);
      this.status = 'driving';
    }

    startDemo(branch) {
      if (!this.freezeInfo) return;
      const eventId = this.freezeInfo.eventId;
      const demo = new Simulation(this.seed, { eventId: eventId, rulePack: this.rulePack });
      demo.status = 'driving';
      this.demo = demo;
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.demoMode = 'driver';
      this.demoKind = 'lesson';
      this.demoPaused = false;
      this.status = 'demonstrating';
    }

    setDemoMode(mode) {
      if (this.status !== 'demonstrating' || ['driver', 'front', 'middle', 'overview'].indexOf(mode) < 0) {
        return false;
      }
      this.demoMode = mode;
      return true;
    }

    setDemoPaused(paused) {
      if (this.status !== 'demonstrating') return false;
      this.demoPaused = Boolean(paused);
      return true;
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo || this.demoPaused) return;
      if (this.demoKind === 'replay' && this.demo.status !== 'driving') return;
      this.demoTime += dt;
      const event = this.demo.events[this.demoEventId];
      this.demo.step(defensiveInput(this.demo), dt);
      if (this.demoKind === 'lesson' &&
          (event.resolved || this.demo.status === 'frozen' || this.demo.status === 'timeout' || this.demoTime >= 45)) {
        this.retryEvent();
      } else if (this.demoKind === 'replay' &&
          (event.resolved || this.demo.status === 'frozen' || this.demo.status === 'timeout' || this.demoTime >= 45)) {
        this.finishReplay();
      }
    }

    stepDemoOnce() {
      if (this.status !== 'demonstrating' || !this.demo) return false;
      const wasPaused = this.demoPaused;
      this.demoPaused = false;
      this.stepDemo(1 / 60);
      if (this.status === 'demonstrating') this.demoPaused = wasPaused;
      return true;
    }

    startPedestrianReplay() {
      // Multi-car perspective replay
      if (!this.freezeInfo && this.status !== 'complete' && this.status !== 'timeout') return;
      const eventId = this.freezeInfo ? this.freezeInfo.eventId : Math.min(this.eventIndex, this.events.length - 1);
      this.replayReturnStatus = this.status;
      const demo = new Simulation(this.seed, { eventId: eventId, rulePack: this.rulePack });
      demo.status = 'driving';
      this.demo = demo;
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.demoMode = 'overview';
      this.demoKind = 'replay';
      this.demoPaused = false;
      this.status = 'demonstrating';
    }

    finishReplay() {
      if (this.demoKind === 'lesson') {
        this.retryEvent();
        return;
      }
      const returnStatus = this.replayReturnStatus;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoMode = 'driver';
      this.demoKind = 'lesson';
      this.demoPaused = false;
      this.replayReturnStatus = null;
      if (returnStatus === 'frozen' || returnStatus === 'complete' || returnStatus === 'timeout') {
        this.status = returnStatus;
      } else if (this.freezeInfo) {
        this.status = 'frozen';
      } else if (this.events.every(function (event) { return event.resolved; })) {
        this.status = 'complete';
      } else {
        this.status = 'driving';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Defensive autopilot
  // ---------------------------------------------------------------------------

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    if (!event) return {};
    const nearest = nearestLeader(event);
    const condition = conditionFor(simulation);

    // Before the event activates, simply cruise at a reasonable condition speed.
    if (!event.active || !nearest) {
      const cruiseTarget = (condition.cruiseMin + condition.cruiseMax) / 2;
      if (simulation.speed < cruiseTarget - 1) return { throttle: true, brake: false };
      if (simulation.speed > cruiseTarget + 1) return { throttle: false, brake: true };
      return { throttle: false, brake: false };
    }

    const gap = bumperGap(simulation, nearest);
    const recommended = recommendedDistance(simulation);
    const leaderSpeed = nearest.speed;

    // If a distant cue is visible and we have not yet responded, ease off early.
    const distantCue = anyDistantCueVisible(simulation, event);
    if (distantCue && !event.earlyRecognition) {
      return { throttle: false, brake: simulation.speed > 5 };
    }

    // When the nearest leader is stopped or nearly stopped, approach to a safe
    // queue distance and hold there rather than stopping hundreds of meters back.
    if (leaderSpeed < 2) {
      const queueGap = 6;
      if (gap > queueGap + 3) {
        // Close the gap smoothly. Target speed depends on remaining distance.
        const target = Math.min(condition.cruiseMax, Math.sqrt(2 * condition.normalDecel * Math.max(0, gap - queueGap)) * 3.6);
        if (simulation.speed < target - 1) return { throttle: true, brake: false };
        if (simulation.speed > target + 1) return { throttle: false, brake: true };
        return { throttle: false, brake: false };
      }
      if (gap < queueGap - 1 && simulation.speed > 0.5) return { throttle: false, brake: true };
      if (simulation.speed > 0.5) return { throttle: false, brake: true };
      return { throttle: false, brake: false };
    }

    // Normal car-following: aim for a gap slightly above the recommended
    // distance and a speed close to the leader, bounded by the condition range.
    const targetGap = recommended * 1.15;
    const gapError = gap - targetGap;
    const speedAdjust = clamp(gapError * 0.35, -12, 15);
    const targetSpeed = clamp(leaderSpeed + speedAdjust, condition.cruiseMin * 0.6, condition.cruiseMax);

    if (gap < recommended * 0.75) {
      return { throttle: false, brake: simulation.speed > leaderSpeed + 1 };
    }
    if (simulation.speed < targetSpeed - 0.5) return { throttle: true, brake: false };
    if (simulation.speed > targetSpeed + 0.5) return { throttle: false, brake: true };
    return { throttle: false, brake: false };
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  function conditionSpeedQuality(speed, condition) {
    const min = condition.cruiseMin;
    const max = condition.cruiseMax;
    if (speed < min * 0.45 || speed > max * 1.15) return 0;
    if (speed < min) return (speed - min * 0.45) / (min * 0.55);
    if (speed <= max) return 1;
    return Math.max(0, (max * 1.15 - speed) / (max * 0.15));
  }

  const Scoring = {
    eventObservation: function (event) {
      return event.observationScore || 0;
    },

    eventSafe: function (event) {
      return event.resolved && !event.failed && !event.closePass && event.minGapDuringEvent > C.COLLISION_GAP;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || !event.active) return false;
      const nearest = nearestLeader(event);
      if (!nearest) return false;
      const gap = bumperGap(simulation, nearest);
      const recommended = recommendedDistance(simulation);
      // Necessary waiting when leader is stopped/braking and we are at safe gap
      if ((nearest.stopped || nearest.state === 'braking') &&
          simulation.speed < 2 && gap > 1 && gap < recommended * 1.5) {
        return true;
      }
      // Early recognition coasting
      if (event.earlyRecognition && simulation.speed < conditionFor(simulation).cruiseMin * 0.7) {
        return true;
      }
      return false;
    },

    recordStep: function (state, simulation, dt) {
      if (!Scoring.isYieldExempt(simulation)) {
        const condition = conditionFor(simulation);
        const quality = conditionSpeedQuality(simulation.speed, condition);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const harsh = simulation.lastDeceleration > C.HARD_BRAKE && simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED;
      // Exempt necessary emergency braking after good early recognition
      const event = simulation.currentEvent;
      const necessary = event && event.earlyRecognition && event.priorHeadwayOK;
      if (harsh && !necessary && state.hardBrakeCooldown <= 0) {
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
      const observation = resolved.reduce(function (sum, event) {
        return sum + Scoring.eventObservation(event);
      }, 0);
      const safety = Math.round(clean.length * 40 / 3);
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
        summaryKey = 'scene.multiCar.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.multiCar.result.advice.default';
      if (failed) adviceKey = 'scene.multiCar.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.multiCar.result.advice.observation';
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
        earlyRecognitionCount: simulation.events.filter(function (event) { return event.earlyRecognition; }).length,
        passedCount: clean.length,
        timedOut: Boolean(timedOut),
        failed: failed,
        adviceKey: adviceKey
      };
    }
  };

  // ---------------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------------

  function cameraFor(simulation, mode) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    const camera = { distance: simulation.distance, anchor: C.CAR_Y, scale: 1, selectedLeaderId: null };
    if (mode === 'front' || mode === 'middle') {
      const index = mode === 'front' ? 0 : Math.max(1, Math.floor((event.leaders.length - 1) / 2));
      const leader = event.leaders[Math.min(index, event.leaders.length - 1)];
      camera.distance = leader.distance;
      camera.anchor = 350;
      camera.selectedLeaderId = leader.id;
    } else if (mode === 'overview') {
      let minimum = playerRear(simulation);
      let maximum = playerFront(simulation);
      event.leaders.forEach(function (leader) {
        minimum = Math.min(minimum, leaderRear(leader));
        maximum = Math.max(maximum, leaderFront(leader));
      });
      const span = Math.max(55, maximum - minimum + 20);
      camera.distance = (minimum + maximum) / 2;
      camera.anchor = 280;
      camera.scale = Math.min(1, 400 / (span * C.PIXELS_PER_METER));
    }
    return camera;
  }

  function worldY(camera, position) {
    return camera.anchor - (position - camera.distance) * C.PIXELS_PER_METER * camera.scale;
  }

  function drawLeader(ctx, camera, leader, highlighted) {
    const y = worldY(camera, leader.distance);
    if (y < -60 || y > C.HEIGHT + 60) return;
    const plan = leader.plan;
    const vehicleScale = plan.type === 'truck' ? 1.3 : (plan.type === 'suv' ? 1.1 : 1.0);
    const scale = vehicleScale * camera.scale;
    const w = 28 * scale;
    const h = 44 * scale;
    const x = C.CAR_X;

    if (highlighted) {
      Draw.rect(ctx, '#fff0b0', x - w / 2 - 4, y - h / 2 - 4, w + 8, 3);
      Draw.rect(ctx, '#fff0b0', x - w / 2 - 4, y + h / 2 + 1, w + 8, 3);
      Draw.rect(ctx, '#fff0b0', x - w / 2 - 4, y - h / 2 - 4, 3, h + 8);
      Draw.rect(ctx, '#fff0b0', x + w / 2 + 1, y - h / 2 - 4, 3, h + 8);
    }
    Draw.rect(ctx, '#0d1c2455', x - w / 2 + 4 * camera.scale, y - h / 2 + 4 * camera.scale, w, h);
    Draw.rect(ctx, plan.color, x - w / 2, y - h / 2, w, h);
    Draw.rect(ctx, '#294651', x - w / 2 + 3 * scale, y - h / 2 + 11 * scale, w - 6 * scale, 10 * scale);
    Draw.rect(ctx, '#294651', x - w / 2 + 3 * scale, y - h / 2 + 26 * scale, w - 6 * scale, 8 * scale);
    const lightColor = leader.brakeLightOn ? '#ff3b30' : '#c6383f';
    Draw.rect(ctx, lightColor, x - w / 2 + 2 * scale, y + h / 2 - 4 * scale, 7 * scale, 3 * scale);
    Draw.rect(ctx, lightColor, x + w / 2 - 9 * scale, y + h / 2 - 4 * scale, 7 * scale, 3 * scale);
  }

  function drawPlayer(ctx, camera, simulation, demo) {
    const y = worldY(camera, simulation.distance);
    if (y < -50 || y > C.HEIGHT + 50) return;
    ctx.save();
    ctx.translate(C.CAR_X, y);
    ctx.scale(camera.scale, camera.scale);
    Draw.drawCar(ctx, 0, 0, demo ? '#65d6a1' : '#e7685b', demo);
    ctx.restore();
    if (simulation.lastDeceleration > 0.8) {
      Draw.rect(ctx, '#ff665c', C.CAR_X - 11 * camera.scale, y + 19 * camera.scale, 7 * camera.scale, 4 * camera.scale);
      Draw.rect(ctx, '#ff665c', C.CAR_X + 4 * camera.scale, y + 19 * camera.scale, 7 * camera.scale, 4 * camera.scale);
    }
  }

  function drawGapGuide(ctx, simulation, camera) {
    const event = simulation.currentEvent;
    if (!event || !event.active) return;
    const nearest = nearestLeader(event);
    if (!nearest) return;

    const gap = bumperGap(simulation, nearest);
    const recommended = recommendedDistance(simulation);
    const bandTop = worldY(camera, simulation.distance + C.CAR_LENGTH_M / 2 + recommended);
    const bandBottom = worldY(camera, simulation.distance + C.CAR_LENGTH_M / 2);
    const color = gap >= recommended * 0.85 ? '#80e0b133' : '#ff645933';
    Draw.rect(ctx, color, C.CAR_X - 20, bandTop, 40, bandBottom - bandTop);

    Draw.rect(ctx, '#132633dd', 15, 15, 100, 22);
    ctx.fillStyle = '#d7e6df';
    Draw.fillFittedText(ctx, t('scene.multiCar.canvas.gap', { gap: Math.max(0, Math.round(gap)) }),
      20, 30, 90, 10, 'sans-serif');
  }

  function drawTriggerCause(ctx, simulation, camera, event) {
    const front = event.leaders[0];
    const y = worldY(camera, front.distance + 13);
    if (y < -30 || y > C.HEIGHT + 30) return;
    const x = C.CAR_X;
    const cause = event.plan.triggerCause;
    if (cause === 'pedestrian') {
      Draw.rect(ctx, '#f2c49b', x - 3, y - 12, 6, 6);
      Draw.rect(ctx, '#d98468', x - 5, y - 6, 10, 12);
      Draw.rect(ctx, '#26333a', x - 5, y + 6, 3, 8);
      Draw.rect(ctx, '#26333a', x + 2, y + 6, 3, 8);
    } else if (cause === 'queue') {
      Draw.rect(ctx, '#d7b957', x - 14, y - 10, 12, 20);
      Draw.rect(ctx, '#7fa6b2', x + 2, y - 10, 12, 20);
    } else if (cause === 'accident') {
      Draw.rect(ctx, '#d98468', x - 15, y - 8, 14, 20);
      Draw.rect(ctx, '#9b8ec4', x + 2, y - 12, 14, 20);
      Draw.rect(ctx, '#fff0b0', x - 2, y - 18, 4, 30);
    } else {
      Draw.rect(ctx, '#fff0b0', x - 18, y - 4, 36, 8);
      Draw.rect(ctx, '#d98468', x - 15, y - 4, 8, 8);
      Draw.rect(ctx, '#d98468', x + 5, y - 4, 8, 8);
    }
    Draw.rect(ctx, '#132633dd', x - 65, y + 20, 130, 20);
    ctx.fillStyle = '#d7e6df';
    Draw.fillFittedText(ctx, t('scene.multiCar.cause.' + cause), x - 60, y + 34, 120, 10, 'sans-serif');
  }

  function drawReplayTimeline(ctx, simulation, event) {
    Draw.rect(ctx, '#10212dee', 12, 522, 336, 106);
    ctx.fillStyle = '#d7e6df';
    Draw.fillFittedText(ctx, t('scene.multiCar.replay.timeline', { time: event.localTime.toFixed(1) }),
      20, 538, 320, 10, 'sans-serif');
    event.leaders.forEach(function (leader, index) {
      const y = 555 + index * 17;
      Draw.rect(ctx, leader.brakeLightOn ? '#ff665c' : '#52717b', 20, y - 8, 6, 6);
      const brakeTime = leader.brakeStartedAt === null ? '—' : leader.brakeStartedAt.toFixed(1) + 's';
      ctx.fillStyle = '#d7e6df';
      Draw.fillFittedText(ctx, t('scene.multiCar.replay.leader', { number: index + 1, time: brakeTime }),
        32, y, 150, 9, 'sans-serif');
      Draw.fillFittedText(ctx, t('scene.multiCar.replay.state.' + leader.state), 195, y, 140, 9, 'sans-serif');
    });
  }

  function drawWeather(ctx, simulation) {
    const condition = conditionFor(simulation);
    if (condition.weather === 'rain') {
      Draw.rect(ctx, '#1a2a3a44', 0, 0, C.WIDTH, C.HEIGHT);
      const scroll = (simulation.elapsed * 200) % 40;
      for (let i = 0; i < 20; i += 1) {
        const x = (i * 47 + 13) % C.WIDTH;
        const y = (i * 31 + scroll) % C.HEIGHT;
        Draw.rect(ctx, '#6a8a9a66', x, y, 1, 8);
      }
    }
  }

  function drawWorld(ctx, simulation, demo, mode) {
    mode = mode || 'driver';
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    const camera = cameraFor(simulation, mode);
    Draw.drawEnvironment(ctx, { distance: camera.distance }, C, 172);

    const sortedLeaders = event.leaders.slice().sort(function (a, b) {
      return b.distance - a.distance;
    });
    for (let i = 0; i < sortedLeaders.length; i += 1) {
      drawLeader(ctx, camera, sortedLeaders[i], sortedLeaders[i].id === camera.selectedLeaderId);
    }
    drawPlayer(ctx, camera, simulation, demo);

    if (mode === 'driver') {
      drawGapGuide(ctx, simulation, camera);
    } else {
      Draw.rect(ctx, '#132633dd', 15, 15, 140, 22);
      ctx.fillStyle = '#d7e6df';
      Draw.fillFittedText(ctx, t('scene.multiCar.replay.' + mode), 20, 30, 130, 10, 'sans-serif');
    }
    if (mode === 'front' || mode === 'overview') drawTriggerCause(ctx, simulation, camera, event);
    drawWeather(ctx, simulation);

    const condition = conditionFor(simulation);
    Draw.rect(ctx, '#132633dd', 245, 15, 100, 22);
    ctx.fillStyle = '#d7e6df';
    Draw.fillFittedText(ctx, t('scene.multiCar.canvas.' + condition.id), 250, 30, 90, 10, 'sans-serif');
    if (mode === 'overview') drawReplayTimeline(ctx, simulation, event);

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
        drawWorld(ctx, simulation.demo, true, simulation.demoMode);
      } else {
        drawWorld(ctx, simulation, false, 'driver');
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Scene registration
  // ---------------------------------------------------------------------------

  function bindControls(doc, getSimulation) {
    const modes = ['driver', 'front', 'middle', 'overview'];
    doc.querySelectorAll('[data-replay-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        getSimulation().setDemoMode(button.getAttribute('data-replay-view'));
      });
    });
    const pauseButton = doc.getElementById('demo-pause-button');
    const stepButton = doc.getElementById('demo-step-button');
    if (pauseButton) {
      pauseButton.addEventListener('click', function () {
        const simulation = getSimulation();
        simulation.setDemoPaused(!simulation.demoPaused);
      });
    }
    if (stepButton) {
      stepButton.addEventListener('click', function () {
        getSimulation().stepDemoOnce();
      });
    }
    doc.addEventListener('keydown', function (event) {
      const simulation = getSimulation();
      if (simulation.status !== 'demonstrating') return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < modes.length) {
        simulation.setDemoMode(modes[index]);
        event.preventDefault();
      }
    });
  }

  const Scene = {
    id: 'multi-car-pileup',
    Constants: C,
    Conditions: CONDITIONS,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    defensiveInput: defensiveInput,
    createPlan: createPlan,
    visibilityFor: visibilityFor,
    predictConflict: predictConflict,
    nearestLeader: nearestLeader,
    bumperGap: bumperGap,
    timeGap: timeGap,
    recommendedDistance: recommendedDistance,
    recommendedHeadway: recommendedHeadway,
    bindControls: bindControls,
    ui: {
      updateControls: function (doc, simulation) {
        const demonstrating = simulation.status === 'demonstrating';
        const frame = doc.getElementById('game-frame');
        if (frame) frame.classList.toggle('is-replay', demonstrating && simulation.demoKind === 'replay');
        doc.querySelectorAll('[data-replay-view]').forEach(function (button) {
          const active = demonstrating && button.getAttribute('data-replay-view') === simulation.demoMode;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', String(active));
          button.disabled = !demonstrating;
        });
        const pauseButton = doc.getElementById('demo-pause-button');
        const stepButton = doc.getElementById('demo-step-button');
        if (pauseButton) {
          pauseButton.textContent = t(simulation.demoPaused ? 'scene.multiCar.replay.resume' : 'scene.multiCar.replay.pause');
          pauseButton.disabled = !demonstrating;
        }
        if (stepButton) stepButton.disabled = !demonstrating || !simulation.demoPaused;
        const badge = doc.querySelector('.demo-badge');
        if (badge) badge.textContent = t(simulation.demoKind === 'replay' ? 'scene.multiCar.replay.badge' : 'game.demoBadge');
        const skip = doc.getElementById('skip-demo-button');
        if (skip) skip.textContent = t(simulation.demoKind === 'replay' ? 'scene.multiCar.replay.finish' : 'game.skipDemo');
      },
      progress: function (simulation) {
        if (simulation.status === 'demonstrating' && simulation.demoKind === 'replay') {
          return t('scene.multiCar.replay.progress');
        }
        return t('scene.multiCar.hud.progress', {
          resolved: simulation.events.filter(function (event) { return event.resolved; }).length
        });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlyRecognition; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(Scoring.eventSafe).length
        ];
      },
      smoothScore: function (simulation) {
        return Math.max(0, 10 - simulation.scoring.hardBrakes * 2);
      },
      coach: function (simulation) {
        if (simulation.status === 'demonstrating' && simulation.demoKind === 'replay') {
          return {
            text: t('scene.multiCar.replay.' + simulation.demoMode + 'Sub'),
            status: t('scene.multiCar.replay.badge'),
            coachTone: 'good',
            tone: ''
          };
        }
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (!event || !event.active) {
          return { text: t('scene.multiCar.hud.cruise'), status: t('hud.cruiseGood'), coachTone: '', tone: '' };
        }
        const nearest = nearestLeader(event);
        if (nearest && nearest.brakeLightOn && event.earlyRecognition) {
          return { text: t('scene.multiCar.hud.earlySeen'), status: t('scene.multiCar.hud.goodMargin'), coachTone: 'good', tone: '' };
        }
        if (nearest && nearest.brakeLightOn && !event.earlyRecognition) {
          return { text: t('scene.multiCar.hud.lateSeen'), status: t('hud.prepareStop'), coachTone: 'risk', tone: 'warn' };
        }
        if (event.distantCueFirstSeenAt !== null) {
          return { text: t('scene.multiCar.hud.distantCue'), status: t('scene.multiCar.hud.easeOff'), coachTone: 'good', tone: '' };
        }
        return { text: t('scene.multiCar.hud.observeFar'), status: t('hud.cruiseGood'), coachTone: '', tone: '' };
      },
      retryToast: function () {
        return { key: 'scene.multiCar.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return {
          key: score === 10 ? 'scene.multiCar.toast.safe' : 'scene.multiCar.toast.improve',
          params: { score: score },
          neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.multiCar.failure.' + info.reason, {
          speed: Math.round(info.speed),
          gap: Math.max(0, info.gap).toFixed(1),
          distance: Math.round(info.stoppingDistance),
          recommended: Math.round(info.recommendedDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        if (!demo) return { step: '', substep: '' };
        if (simulation.demoKind === 'replay') {
          return {
            step: t('scene.multiCar.replay.' + simulation.demoMode),
            substep: t('scene.multiCar.replay.' + simulation.demoMode + 'Sub')
          };
        }
        const event = demo.currentEvent || demo.events[Math.min(demo.eventIndex, demo.events.length - 1)];
        if (!event) return { step: '', substep: '' };
        if (event.earlyRecognition) {
          return { step: t('scene.multiCar.demo.early'), substep: t('scene.multiCar.demo.earlySub') };
        }
        return { step: t('scene.multiCar.demo.observe'), substep: t('scene.multiCar.demo.observeSub') };
      }
    }
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
