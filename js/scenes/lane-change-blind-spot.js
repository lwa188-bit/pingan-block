(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const Model = Game.Model;
  const Draw = Game.Draw;
  const t = Game.I18N.t;

  const clamp = Model.clamp;
  const lerp = Model.lerp;
  const moveToward = Model.moveToward;

  const C = Object.assign({}, Game.C, {
    CAR_X: 230,
    CAR_Y: 482,
    LANE_WIDTH: 3.5,
    LANE_PIXELS: 100,
    X_PIXELS_PER_METER: 100 / 3.5,
    PIXELS_PER_METER: 7.2,
    START_SPEED: 50,
    MIN_SPEED: 0,
    MAX_SPEED: 66,
    ACCELERATION: 1.35,
    BRAKE_DECELERATION: 3.0,
    EMERGENCY_BRAKE_DECELERATION: 6.4,
    NATURAL_DECELERATION: 0.45,
    PLAYER_LENGTH: 4.4,
    PLAYER_WIDTH: 1.8,
    SEGMENT_START_TO_CLOSURE: 185,
    SEGMENT_END: 250,
    SIGNAL_LEAD: 0.5,
    LANE_CHANGE_TIME: 2.8,
    ABORT_TIME: 1.2,
    COMMIT_PROGRESS: 0.55,
    MIRROR_PHASE_START: 0.18,
    MIRROR_PHASE_END: 0.75,
    SHOULDER_PHASE_START: 0.95,
    LOOK_MAX: 2.4,
    MIRROR_VALID_DWELL: 0.3,
    SHOULDER_VALID_DWELL: 0.4,
    OBS_VALIDITY: 2.5,
    BLIND_ZONE_REAR: 12,
    MIRROR_ZONE_NEAR: 12,
    MIRROR_ZONE_FAR: 45,
    SHOULDER_ZONE_FAR: 22,
    FOLLOW_COMFORT_DECEL: 2.8,
    FOLLOW_HARD_DECEL: 4.5,
    GAP_BUFFER: 2.0,
    CLEARANCE_BUFFER: 0.35,
    PREDICTION_STEP: 0.05,
    PREDICTION_HORIZON: 3.0,
    IMMEDIATE_HORIZON: 0.35,
    STABLE_DWELL: 0.5,
    SEGMENT_TRANSITION: 1.2,
    MAX_TIME: 100,
    CRUISE_MIN_KMH: 42,
    CRUISE_MAX_KMH: 55,
    HARD_BRAKE_DECEL: 5.0,
    CONFLICT_LENGTH: 4.4,
    CONFLICT_WIDTH: 1.8,
    LEAD_LENGTH: 4.6,
    LEAD_WIDTH: 1.9
  });

  const REASONS = ['side', 'rear', 'closure', 'follower', 'timeout'];

  function smooth5(u) {
    u = clamp(u, 0, 1);
    return u * u * u * (10 + u * (-15 + 6 * u));
  }

  function smooth5Derivative(u) {
    u = clamp(u, 0, 1);
    return 30 * u * u * (1 - 2 * u + u * u);
  }

  function sideSign(side) {
    return side === 'left' ? -1 : 1;
  }

  function laneCenterX(side) {
    return sideSign(side) * C.LANE_WIDTH;
  }

  function sourceSide(side) {
    return side === 'left' ? 'right' : 'left';
  }

  function normalizeInput(input) {
    input = input || {};
    return {
      left: Boolean(input.left),
      right: Boolean(input.right),
      throttle: Boolean(input.throttle),
      brake: Boolean(input.brake),
      lookLeft: Boolean(input.lookLeft),
      lookRight: Boolean(input.lookRight)
    };
  }

  // --- Geometry -----------------------------------------------------------

  function boxCorners(vehicle) {
    const yaw = vehicle.yaw || 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const forward = { x: sin, s: cos };
    const right = { x: cos, s: -sin };
    const hl = (vehicle.length || 4.4) / 2;
    const hw = (vehicle.width || 1.8) / 2;
    const cx = vehicle.x || 0;
    const cs = vehicle.s || 0;
    return [
      { x: cx - right.x * hw - forward.x * hl, s: cs - right.s * hw - forward.s * hl },
      { x: cx + right.x * hw - forward.x * hl, s: cs + right.s * hw - forward.s * hl },
      { x: cx + right.x * hw + forward.x * hl, s: cs + right.s * hw + forward.s * hl },
      { x: cx - right.x * hw + forward.x * hl, s: cs - right.s * hw + forward.s * hl }
    ];
  }

  function projection(corners, axis) {
    let min = Infinity;
    let max = -Infinity;
    corners.forEach(function (corner) {
      const value = corner.x * axis.x + corner.s * axis.s;
      min = Math.min(min, value);
      max = Math.max(max, value);
    });
    return { min: min, max: max };
  }

  function satClearance(a, b) {
    const cornersA = boxCorners(a);
    const cornersB = boxCorners(b);
    let minOverlap = Infinity;
    [cornersA, cornersB].forEach(function (corners) {
      for (let i = 0; i < 4; i += 1) {
        const p1 = corners[i];
        const p2 = corners[(i + 1) % 4];
        let ax = -(p2.s - p1.s);
        let as = p2.x - p1.x;
        const length = Math.sqrt(ax * ax + as * as);
        if (length < 1e-9) continue;
        ax /= length;
        as /= length;
        const pa = projection(cornersA, { x: ax, s: as });
        const pb = projection(cornersB, { x: ax, s: as });
        const overlap = Math.min(pa.max, pb.max) - Math.max(pa.min, pb.min);
        if (overlap < minOverlap) minOverlap = overlap;
      }
    });
    return minOverlap;
  }

  function obbIntersects(a, b) {
    return satClearance(a, b) >= 0;
  }

  function obbClearance(a, b) {
    const overlap = satClearance(a, b);
    return overlap >= 0 ? 0 : -overlap;
  }

  function mirrorCovers(simulation, vehicle) {
    if (!vehicle) return false;
    const behind = simulation.player.s - vehicle.s + (simulation.player.length - vehicle.length) / 2;
    return behind >= C.MIRROR_ZONE_NEAR && behind <= C.MIRROR_ZONE_FAR;
  }

  function shoulderCovers(simulation, vehicle) {
    if (!vehicle) return false;
    const behind = simulation.player.s - vehicle.s + (simulation.player.length - vehicle.length) / 2;
    return behind >= 0 && behind <= C.SHOULDER_ZONE_FAR;
  }

  function carBehindDistance(simulation, vehicle) {
    if (!vehicle) return -Infinity;
    return simulation.player.s - vehicle.s;
  }

  // --- Plan generation ----------------------------------------------------

  function createPlan(seed) {
    const random = Model.mulberry32(Model.hashSeed(seed));
    const firstSide = random() < 0.5 ? 'left' : 'right';
    const sides = [firstSide, firstSide === 'left' ? 'right' : 'left', random() < 0.5 ? 'left' : 'right'];
    const templates = ['clear-change', 'blind-spot-car', 'fast-closing'];
    for (let i = templates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const swap = templates[i];
      templates[i] = templates[j];
      templates[j] = swap;
    }
    const closureTypes = ['works', 'broken-truck', 'barrier', 'bus-stop'];
    const events = templates.map(function (template, index) {
      const side = sides[index];
      const initialSpeed = 13.2 + random() * 1.0;
      let conflict = { kind: 'none' };
      if (template === 'blind-spot-car') {
        conflict = {
          kind: 'blind',
          initialCenterS: -(7.5 + random() * 1.5),
          initialSpeed: initialSpeed,
          pacingDuration: 0.6 + random() * 0.4,
          passRelativeSpeed: 3.5 + random() * 1.0,
          color: '#e7bd5c'
        };
      } else if (template === 'fast-closing') {
        const near = random() < 0.5;
        conflict = {
          kind: 'fast',
          subType: near ? 'fast-near' : 'fast-far',
          initialCenterS: near ? -(16 + random() * 6) : -(28 + random() * 6),
          initialSpeed: initialSpeed,
          pacingDuration: 0,
          passRelativeSpeed: near ? 5.5 + random() * 1.5 : 3.5 + random() * 1.0,
          color: '#7fa6b2'
        };
      }
      return {
        id: index,
        template: template,
        side: side,
        laneWidth: C.LANE_WIDTH,
        segmentStartS: 0,
        closureLineS: C.SEGMENT_START_TO_CLOSURE,
        taperStartS: C.SEGMENT_START_TO_CLOSURE,
        segmentEndS: C.SEGMENT_END,
        player: {
          initialSpeed: initialSpeed,
          initialLaneCenterX: 0
        },
        closure: {
          type: closureTypes[Math.floor(random() * closureTypes.length)],
          warningSignS: 10,
          arrowBoardS: 55,
          taperLength: 35
        },
        targetTraffic: {
          conflict: conflict,
          leadAhead: {
            present: true,
            initialCenterS: 95 + random() * 35,
            speed: initialSpeed + 0.4,
            length: C.LEAD_LENGTH,
            width: C.LEAD_WIDTH,
            color: '#8fc7c2'
          },
          safeFollower: { present: false }
        },
        safeWindow: {
          earliestChangeS: 25,
          latestChangeS: 170
        }
      };
    });
    return { seed: seed, events: events };
  }

  // --- Observation --------------------------------------------------------

  class ObservationController {
    constructor(simulation) {
      this.simulation = simulation;
      this.reset();
    }

    reset() {
      this.view = 'front';
      this.viewSide = null;
      this.lookSide = null;
      this.lookTime = 0;
      this.phase = 'none';
      this.phaseDwell = 0;
      this.forcedFront = false;
      this.returnTimer = 0;
      this.mirrorEnds = { left: null, right: null };
      this.shoulderEnds = { left: null, right: null };
      this.mirrorDwellMax = { left: 0, right: 0 };
      this.shoulderDwellMax = { left: 0, right: 0 };
      this.everComplete = { left: false, right: false };
      this.lastPhaseEndAt = null;
    }

    endPhase(now) {
      if (this.phase === 'mirror' && this.lookSide) {
        if (this.phaseDwell >= C.MIRROR_VALID_DWELL) {
          this.mirrorEnds[this.lookSide] = now;
          this.mirrorDwellMax[this.lookSide] = Math.max(this.mirrorDwellMax[this.lookSide], this.phaseDwell);
        }
      } else if (this.phase === 'shoulder' && this.lookSide) {
        if (this.phaseDwell >= C.SHOULDER_VALID_DWELL) {
          this.shoulderEnds[this.lookSide] = now;
          this.shoulderDwellMax[this.lookSide] = Math.max(this.shoulderDwellMax[this.lookSide], this.phaseDwell);
        }
      }
      if (this.phase !== 'none') this.lastPhaseEndAt = now;
      this.phase = 'none';
      this.phaseDwell = 0;
    }

    forceFront(now) {
      if (this.lookSide != null) this.endPhase(now);
      this.lookSide = null;
      this.lookTime = 0;
      this.phase = 'none';
      this.view = 'front';
      this.viewSide = null;
      this.forcedFront = true;
      this.returnTimer = 0.2;
    }

    update(dt, input, targetSide, now) {
      const side = input.lookLeft ? 'left' : (input.lookRight ? 'right' : null);
      if (side == null) {
        if (this.lookSide != null) {
          this.endPhase(now);
          this.lookSide = null;
          this.lookTime = 0;
          this.view = 'front';
          this.viewSide = null;
          this.returnTimer = 0.2;
        }
        this.forcedFront = false;
        if (this.returnTimer > 0) this.returnTimer = Math.max(0, this.returnTimer - dt);
        return;
      }

      if (this.forcedFront) return;

      if (side !== this.lookSide) {
        if (this.lookSide != null) this.endPhase(now);
        this.lookSide = side;
        this.lookTime = 0;
        this.phase = 'none';
        this.phaseDwell = 0;
        this.returnTimer = 0;
      }

      this.lookTime += dt;
      let nextPhase = 'none';
      if (this.lookTime < C.MIRROR_PHASE_START) nextPhase = 'transition';
      else if (this.lookTime < C.MIRROR_PHASE_END) nextPhase = 'mirror';
      else if (this.lookTime < C.SHOULDER_PHASE_START) nextPhase = 'transition';
      else nextPhase = 'shoulder';

      if (nextPhase !== this.phase) {
        this.endPhase(now);
        this.phase = nextPhase;
        this.phaseDwell = 0;
      }

      if (this.phase === 'mirror' || this.phase === 'shoulder') this.phaseDwell += dt;

      if (this.phase === 'transition') {
        this.view = 'transition';
      } else if (this.phase === 'mirror') {
        this.view = 'mirror';
      } else if (this.phase === 'shoulder') {
        this.view = 'shoulder';
      }
      this.viewSide = this.lookSide;

      if (this.lookTime >= C.LOOK_MAX) {
        this.endPhase(now);
        this.view = 'front';
        this.viewSide = null;
        this.forcedFront = true;
        this.lookTime = C.LOOK_MAX;
        this.phase = 'none';
      }
    }

    mirrorEnd(side) {
      return this.mirrorEnds[side];
    }

    shoulderEnd(side) {
      return this.shoulderEnds[side];
    }

    isComplete(side, now) {
      const mirror = this.mirrorEnds[side];
      const shoulder = this.shoulderEnds[side];
      return mirror != null && shoulder != null &&
        now - mirror <= C.OBS_VALIDITY && now - shoulder <= C.OBS_VALIDITY;
    }

    everWasComplete(side, now) {
      return Boolean(this.everComplete[side]);
    }

    mirrorOk(side, now) {
      const end = this.mirrorEnds[side];
      return end != null && now - end <= C.OBS_VALIDITY;
    }

    shoulderOk(side, now) {
      const end = this.shoulderEnds[side];
      return end != null && now - end <= C.OBS_VALIDITY;
    }

    noteComplete(side, now) {
      if (this.isComplete(side, now)) this.everComplete[side] = true;
    }
  }

  // --- Lane change --------------------------------------------------------

  class LaneChangeController {
    constructor(simulation) {
      this.simulation = simulation;
      this.reset();
    }

    reset() {
      this.state = 'LANE_KEEP';
      this.signalSide = null;
      this.signalOnAt = null;
      this.movementStartAt = null;
      this.movementElapsed = 0;
      this.progress = 0;
      this.committed = false;
      this.abortAt = null;
      this.abortFromX = 0;
      this.abortFromVx = 0;
      this.abortElapsed = 0;
      this.abortJustified = false;
      this.settleStartAt = null;
      this.completedAt = null;
      this.fullyInAt = null;
      this.laneKeepX = 0;
      this.requireNewRequest = false;
      this.lastReleasedAt = 0;
      this.lastAbortAt = null;
      this.aborts = 0;
      this.requests = 0;
    }

    get fullyIn() {
      return this.progress >= 1 || this.completedAt != null || this.state === 'SETTLING';
    }

    poseAt(now, speed) {
      const sign = sideSign(this.simulation.currentEvent ? this.simulation.currentEvent.side : 'left');
      const v = Math.max(speed, 1);
      if (this.state === 'MOVING') {
        const u = clamp((now - this.movementStartAt) / C.LANE_CHANGE_TIME, 0, 1);
        const x = sign * C.LANE_WIDTH * smooth5(u);
        const vx = sign * C.LANE_WIDTH * smooth5Derivative(u) / C.LANE_CHANGE_TIME;
        return { x: x, vx: vx, yaw: clamp(Math.atan2(vx, v), -0.38, 0.38) };
      }
      if (this.state === 'ABORTING') {
        const u = clamp((now - this.abortAt) / C.ABORT_TIME, 0, 1);
        const x = this.abortX(u);
        const vx = this.abortVx(u);
        return { x: x, vx: vx, yaw: clamp(Math.atan2(vx, v), -0.38, 0.38) };
      }
      if (this.state === 'SETTLING' || (this.state === 'LANE_KEEP' && this.completedAt != null)) {
        return { x: this.laneKeepX, vx: 0, yaw: 0 };
      }
      return { x: this.laneKeepX, vx: 0, yaw: 0 };
    }

    abortX(u) {
      return this.abortFromX * (1 - 3 * u * u + 2 * u * u * u) +
        this.abortFromVx * C.ABORT_TIME * (u - 2 * u * u + u * u * u);
    }

    abortVx(u) {
      return this.abortFromX * (-6 * u + 6 * u * u) / C.ABORT_TIME +
        this.abortFromVx * (1 - 4 * u + 3 * u * u);
    }

    requestSide(input) {
      if (input.left && input.right) return null;
      if (input.left) return 'left';
      if (input.right) return 'right';
      return null;
    }

    update(dt, input, targetSide, now) {
      const sim = this.simulation;
      const pressed = this.requestSide(input);

      switch (this.state) {
        case 'LANE_KEEP':
          if (this.requireNewRequest) {
            if (pressed == null) this.requireNewRequest = false;
            break;
          }
          if (this.completedAt != null) break;
          if (pressed === targetSide) {
            this.state = 'SIGNALING';
            this.signalSide = targetSide;
            this.signalOnAt = now;
            this.lastReleasedAt = now;
            this.requests += 1;
            sim.captureCommit();
            sim.observation.forceFront(now);
          }
          break;
        case 'SIGNALING':
          if (pressed !== this.signalSide) {
            this.state = 'LANE_KEEP';
            this.signalSide = null;
            break;
          }
          if (now - this.signalOnAt >= C.SIGNAL_LEAD) {
            this.state = 'MOVING';
            this.movementStartAt = now;
            this.movementElapsed = 0;
            this.progress = 0;
          }
          break;
        case 'MOVING':
          this.movementElapsed = now - this.movementStartAt;
          this.progress = clamp(this.movementElapsed / C.LANE_CHANGE_TIME, 0, 1);
          if (pressed != null && pressed !== this.signalSide && this.progress < C.COMMIT_PROGRESS) {
            this.state = 'ABORTING';
            this.abortAt = now;
            this.abortElapsed = 0;
            this.abortFromX = sim.player.x;
            this.abortFromVx = sim.player.vx;
            this.aborts += 1;
            this.lastAbortAt = now;
            this.abortJustified = sim.justifiedAbort();
            sim.currentEvent.abortedAt = now;
            if (!this.abortJustified) sim.scoring.dithering += 1;
            if (this.progress > 0.4) sim.scoring.lateAborts += 1;
          } else if (this.progress >= C.COMMIT_PROGRESS) {
            this.committed = true;
          }
          if (this.progress >= 1) {
            this.state = 'SETTLING';
            this.settleStartAt = now;
            this.fullyInAt = now;
            this.laneKeepX = sideSign(targetSide) * C.LANE_WIDTH;
            sim.observation.forceFront(now);
          }
          break;
        case 'ABORTING':
          this.abortElapsed = now - this.abortAt;
          if (this.abortElapsed >= C.ABORT_TIME) {
            this.state = 'LANE_KEEP';
            this.signalSide = null;
            this.progress = 0;
            this.requireNewRequest = true;
            this.laneKeepX = 0;
            this.abortsAlreadyHandled = true;
          }
          break;
        case 'SETTLING':
          if (now - this.settleStartAt >= C.STABLE_DWELL) {
            this.state = 'LANE_KEEP';
            this.completedAt = now;
            this.laneKeepX = sideSign(targetSide) * C.LANE_WIDTH;
            this.signalSide = null;
          }
          break;
      }

      const pose = this.poseAt(now, sim.player.v);
      sim.player.x = pose.x;
      sim.player.vx = pose.vx;
      sim.player.yaw = pose.yaw;
      if (this.state === 'LANE_KEEP' && pressed == null) this.lastReleasedAt = now;
    }
  }

  // --- Traffic ------------------------------------------------------------

  function createConflict(event) {
    const plan = event.plan.targetTraffic.conflict;
    if (!plan || plan.kind === 'none') return null;
    const s = plan.initialCenterS;
    const pacingUntil = plan.pacingDuration > 0 ? plan.pacingDuration : null;
    return {
      kind: plan.kind,
      subType: plan.subType || null,
      x: laneCenterX(event.side),
      s: s,
      v: plan.kind === 'blind' ? plan.initialSpeed : plan.initialSpeed + plan.passRelativeSpeed,
      startS: s,
      targetSpeed: plan.initialSpeed + plan.passRelativeSpeed,
      pacingUntil: pacingUntil,
      pacingDuration: plan.pacingDuration,
      accel: plan.kind === 'blind' ? 3.0 : 1.3,
      length: C.CONFLICT_LENGTH,
      width: C.CONFLICT_WIDTH,
      color: plan.color,
      braking: false,
      signalVisible: false
    };
  }

  function createLead(event) {
    const plan = event.plan.targetTraffic.leadAhead;
    if (!plan || !plan.present) return null;
    return {
      kind: 'lead',
      x: laneCenterX(event.side),
      s: plan.initialCenterS,
      v: plan.speed,
      targetSpeed: plan.speed,
      length: plan.length,
      width: plan.width,
      color: plan.color,
      braking: false,
      signalVisible: false
    };
  }

  // --- Simulation ---------------------------------------------------------

  class Simulation {
    constructor(seed, options) {
      options = options || {};
      this.seed = seed == null ? 'lane-change' : seed;
      this.plan = options.plan || createPlan(this.seed);
      this.options = options;
      this.eventIndex = options.eventId != null ? options.eventId : 0;
      this.events = this.plan.events.map(function (planEvent) {
        return {
          id: planEvent.id,
          template: planEvent.template,
          side: planEvent.side,
          plan: planEvent,
          active: false,
          resolved: false,
          failed: false,
          failureReason: null,
          attempts: 0,
          elapsed: 0,
          commits: [],
          commit: null,
          abortJustified: false,
          aborts: 0,
          abortedAt: null,
          requestCount: 0,
          dithering: 0,
          forcedFollower: false,
          forcedFollowerHard: false,
          nearConflict: false,
          unsafeMerge: false,
          mergeDecel: null,
          minSideClearance: Infinity,
          minRearGap: Infinity,
          maxFollowerDecel: 0,
          completed: false,
          completedAt: null,
          fullyInAt: null,
          speedMismatch: false,
          postHardBrake: false,
          canChangeSince: null,
          observationScore: 0,
          safe: false,
          history: [],
          lastHistoryAt: -1
        };
      });
      this.status = 'ready';
      this.elapsed = 0;
      this.speed = this.plan.events[this.eventIndex].player.initialSpeed * 3.6;
      this.player = {
        x: 0,
        s: 0,
        v: this.plan.events[this.eventIndex].player.initialSpeed,
        vx: 0,
        yaw: 0,
        length: C.PLAYER_LENGTH,
        width: C.PLAYER_WIDTH
      };
      this.prevV = this.player.v;
      this.lastDeceleration = 0;
      this.conflict = null;
      this.lead = null;
      this.currentEvent = null;
      this.observation = new ObservationController(this);
      this.laneChange = new LaneChangeController(this);
      this.assessment = null;
      this.scoring = {
        efficiencyTime: 0,
        efficiencyIntegral: 0,
        hardBrakes: 0,
        hardBrakeLatch: false,
        dithering: 0,
        lateAborts: 0,
        firstFailure: false
      };
      this.transition = 0;
      this.transitionTotal = 0;
      this.justResolved = null;
      this.justHardBrake = false;
      this.freezeInfo = null;
      this.demo = null;
      this.demoMode = null;
      this.defensiveControl = null;
      this._predictionCache = null;
      this._lastAssessmentAt = null;
      this._risk = null;
    }

    get distance() {
      return this.player.s;
    }

    start() {
      this.status = 'driving';
      this.elapsed = 0;
      this.activateEvent(this.eventIndex);
    }

    activateEvent(index) {
      this.eventIndex = index;
      const event = this.events[index];
      const plan = this.plan.events[index];
      event.active = true;
      event.resolved = false;
      event.elapsed = 0;
      event.commit = null;
      event.commits = [];
      event.abortedAt = null;
      event.requestCount = 0;
      event.dithering = 0;
      event.forcedFollower = false;
      event.forcedFollowerHard = false;
      event.nearConflict = false;
      event.unsafeMerge = false;
      event.mergeDecel = null;
      event.minSideClearance = Infinity;
      event.minRearGap = Infinity;
      event.maxFollowerDecel = 0;
      event.completed = false;
      event.completedAt = null;
      event.fullyInAt = null;
      event.speedMismatch = false;
      event.postHardBrake = false;
      event.canChangeSince = null;
      event.observationScore = 0;
      event.safe = false;
      event.history = [];
      event.lastHistoryAt = -1;
      this.currentEvent = event;
      this.player.x = 0;
      this.player.s = 0;
      this.player.v = plan.player.initialSpeed;
      this.player.vx = 0;
      this.player.yaw = 0;
      this.prevV = this.player.v;
      this.conflict = createConflict(event);
      this.lead = createLead(event);
      this.observation.reset();
      this.laneChange.reset();
      this.assessment = null;
      this.transition = 0;
      this.transitionTotal = 0;
      this.defensiveControl = null;
      this._predictionCache = null;
      this.justResolved = null;
      this.freezeInfo = null;
      this.speed = this.player.v * 3.6;
    }

    captureCommit() {
      const event = this.currentEvent;
      // Snapshot what the driver could see when they made the decision,
      // not a re-evaluation from one frame later.
      const assessment = this.assessment || this.assess();
      const now = this.elapsed;
      const commit = {
        at: now,
        mirrorOk: assessment.mirrorOk,
        shoulderOk: assessment.shoulderOk,
        observationFresh: assessment.observationFresh,
        safeDecision: assessment.canChange,
        blindSpotOccupied: assessment.blindSpotOccupied,
        aReq: assessment.aReq,
        predictedMinClearance: assessment.predicted ? assessment.predicted.minClearance : Infinity,
        closureRemaining: assessment.closureRemaining,
        lateCheck: this.laneChange.movementStartAt != null && this.observation.lookSide != null
      };
      event.commit = commit;
      event.commits.push(commit);
      event.requestCount = this.laneChange.requests;
      if (event.abortedAt != null && now - event.abortedAt < 2) event.dithering += 1;
      if (event.requestCount > 2) event.dithering += 1;
      event.abortJustified = this.laneChange.abortJustified;
    }

    justifiedAbort() {
      const assessment = this.assess();
      return assessment.blindSpotOccupied || assessment.aReq > C.FOLLOW_HARD_DECEL ||
        (assessment.predicted && assessment.predicted.minClearance < C.CLEARANCE_BUFFER);
    }

    updateTraffic(dt) {
      const event = this.currentEvent;
      const conflict = this.conflict;
      if (conflict) {
        const following = this.laneChange.fullyIn && conflict.s < this.player.s;
        if (following) {
          const desired = Math.min(conflict.targetSpeed, this.player.v);
          const prev = conflict.v;
          conflict.v = moveToward(conflict.v, desired, 3.2 * dt);
          conflict.braking = conflict.v < prev - 1e-6;
        } else if (conflict.pacingUntil != null && event.elapsed < conflict.pacingUntil) {
          conflict.v = this.player.v;
        } else {
          const prev = conflict.v;
          conflict.v = moveToward(conflict.v, conflict.targetSpeed, conflict.accel * dt);
          conflict.braking = conflict.v < prev - 1e-6;
        }
        conflict.s += conflict.v * dt;
        if (event.elapsed - event.lastHistoryAt >= 0.12) {
          event.history.push({ s: conflict.s, x: conflict.x });
          event.lastHistoryAt = event.elapsed;
        }
      }
      if (this.lead) {
        this.lead.s += this.lead.v * dt;
      }
    }

    advancePredictionCar(car, dt, playerV, clock) {
      if (!car) return;
      if (car.pacingUntil != null && clock < car.pacingUntil) {
        car.v = playerV;
      } else {
        car.v = moveToward(car.v, car.targetSpeed, car.accel * dt);
      }
      car.s += car.v * dt;
    }

    predictLaneChange(includeSignal) {
      const sim = this;
      const event = this.currentEvent;
      const conflict = this.conflict;
      if (!conflict || !event) return { minClearance: Infinity, collide: false };
      const side = event.side;
      const sign = sideSign(side);
      const leadTime = includeSignal ? C.SIGNAL_LEAD : 0;
      const total = leadTime + C.LANE_CHANGE_TIME + 0.2;
      const dt = 0.08;
      const player = {
        x: this.player.x,
        s: this.player.s,
        v: this.player.v,
        vx: 0,
        yaw: 0,
        length: C.PLAYER_LENGTH,
        width: C.PLAYER_WIDTH
      };
      const car = {
        s: conflict.s,
        v: conflict.v,
        x: conflict.x,
        length: conflict.length,
        width: conflict.width,
        yaw: 0,
        pacingUntil: conflict.pacingUntil,
        targetSpeed: conflict.targetSpeed,
        accel: conflict.accel
      };
      let clock = this.currentEvent.elapsed;
      let minClearance = Infinity;
      for (let time = 0; time <= total; time += dt) {
        let x = 0;
        let vx = 0;
        let yaw = 0;
        if (time > leadTime) {
          const u = clamp((time - leadTime) / C.LANE_CHANGE_TIME, 0, 1);
          x = sign * C.LANE_WIDTH * smooth5(u);
          vx = sign * C.LANE_WIDTH * smooth5Derivative(u) / C.LANE_CHANGE_TIME;
          yaw = clamp(Math.atan2(vx, Math.max(this.player.v, 1)), -0.38, 0.38);
        }
        const playerBox = {
          x: x,
          s: this.player.s + this.player.v * time,
          vx: vx,
          yaw: yaw,
          length: player.length,
          width: player.width
        };
        const carBox = {
          x: car.x,
          s: car.s,
          yaw: 0,
          length: car.length,
          width: car.width
        };
        const clearance = obbClearance(playerBox, carBox);
        if (clearance < minClearance) minClearance = clearance;
        if (minClearance <= 0) break;
        this.advancePredictionCar(car, dt, this.player.v, clock);
        clock += dt;
      }
      return { minClearance: minClearance, collide: minClearance <= 0.02 };
    }

    predictionForAssess() {
      const event = this.currentEvent;
      if (!event) return { minClearance: Infinity, collide: false };
      const cache = this._predictionCache;
      const stateKey = this.laneChange.state + ':' + this.observation.mirrorEnds[event.side] + ':' +
        this.observation.shoulderEnds[event.side];
      if (cache && this.elapsed - cache.at < 0.12 && cache.stateKey === stateKey) return cache.value;
      const value = this.predictLaneChange(this.laneChange.state !== 'MOVING' && this.laneChange.state !== 'ABORTING');
      this._predictionCache = { at: this.elapsed, stateKey: stateKey, value: value };
      return value;
    }

    assess() {
      const event = this.currentEvent;
      const now = this.elapsed;
      const player = this.player;
      const side = event.side;
      const conflict = this.conflict;
      const observationFresh = this.observation.isComplete(side, now);
      this.observation.noteComplete(side, now);

      let aReq = 0;
      let followerGap = Infinity;
      let leadGap = Infinity;
      let blindSpotOccupied = false;
      let targetRearConflict = false;
      let speedMismatch = false;
      let conflictBehind = false;
      let relativeSpeed = 0;
      let projectedFollowerDecel = 0;

      if (conflict) {
        const carFront = conflict.s + conflict.length / 2;
        const carRear = conflict.s - conflict.length / 2;
        const playerFront = player.s + player.length / 2;
        const playerRear = player.s - player.length / 2;
        followerGap = playerRear - carFront;
        leadGap = carRear - playerFront;
        relativeSpeed = conflict.v - player.v;
        conflictBehind = conflict.s <= player.s;
        if (followerGap > 0) {
          if (relativeSpeed > 0) aReq = relativeSpeed * relativeSpeed / (2 * Math.max(followerGap - C.GAP_BUFFER, 0.3));
          targetRearConflict = followerGap < 25 && relativeSpeed > 1.0;
        }
        if (conflictBehind && relativeSpeed > 0) {
          const remainingMerge = this.laneChange.state === 'MOVING'
            ? (1 - this.laneChange.progress) * C.LANE_CHANGE_TIME
            : C.SIGNAL_LEAD + C.LANE_CHANGE_TIME;
          const projectedGap = followerGap - relativeSpeed * remainingMerge;
          projectedFollowerDecel = relativeSpeed * relativeSpeed /
            (2 * Math.max(projectedGap - C.GAP_BUFFER, 0.3));
        }
        blindSpotOccupied = conflict.s > player.s - C.BLIND_ZONE_REAR && conflict.s < player.s + 2;
        if (leadGap > 0 && conflict.v < player.v - 2.5 && leadGap < 20) speedMismatch = true;
      }

      const closureRemaining = C.SEGMENT_START_TO_CLOSURE - (player.s + player.length / 2);
      const needed = player.v * (C.LANE_CHANGE_TIME + C.SIGNAL_LEAD) + 2.5;
      const predicted = observationFresh ? this.predictionForAssess() : { minClearance: Infinity, collide: false };
      const observationComplete = observationFresh;
      const rearMarginOk = conflict
        ? (conflictBehind
          ? projectedFollowerDecel <= C.FOLLOW_COMFORT_DECEL
          : leadGap > 4.5)
        : true;
      const canChange = observationComplete &&
        !blindSpotOccupied &&
        aReq <= C.FOLLOW_HARD_DECEL &&
        rearMarginOk &&
        predicted.minClearance > C.CLEARANCE_BUFFER &&
        closureRemaining > needed;

      if (canChange && this.laneChange.state === 'LANE_KEEP' && !event.completed) {
        if (event.canChangeSince == null) event.canChangeSince = now;
      } else {
        event.canChangeSince = null;
      }
      const overWait = event.canChangeSince != null && !event.completed &&
        now - event.canChangeSince > 1.2;

      return {
        observationFresh: observationFresh,
        observationComplete: observationComplete,
        mirrorOk: this.observation.mirrorOk(side, now),
        shoulderOk: this.observation.shoulderOk(side, now),
        everComplete: this.observation.everComplete[side],
        blindSpotOccupied: blindSpotOccupied,
        targetRearConflict: targetRearConflict,
        aReq: aReq,
        relativeSpeed: relativeSpeed,
        projectedFollowerDecel: projectedFollowerDecel,
        conflictBehind: conflictBehind,
        followerGap: followerGap,
        leadGap: leadGap,
        speedMismatch: speedMismatch,
        closureRemaining: closureRemaining,
        needed: needed,
        predicted: predicted,
        canChange: canChange,
        overWait: overWait
      };
    }

    predictiveCollision() {
      const conflict = this.conflict;
      if (!conflict) return { collide: false, clearance: Infinity };
      if (this.player.x === 0 && this.laneChange.state !== 'MOVING' && this.laneChange.state !== 'ABORTING') {
        return { collide: false, clearance: Infinity };
      }
      if (Math.abs(conflict.s - this.player.s) > 45) {
        return { collide: false, clearance: Infinity };
      }
      const dt = 0.025;
      const horizon = C.IMMEDIATE_HORIZON;
      const car = {
        s: conflict.s,
        v: conflict.v,
        x: conflict.x,
        length: conflict.length,
        width: conflict.width,
        yaw: 0,
        pacingUntil: conflict.pacingUntil,
        targetSpeed: conflict.targetSpeed,
        accel: conflict.accel
      };
      let clock = this.currentEvent ? this.currentEvent.elapsed : 0;
      let minClearance = Infinity;
      for (let time = 0; time <= horizon; time += dt) {
        const pose = this.laneChange.poseAt(this.elapsed + time, this.player.v);
        const playerBox = {
          x: pose.x,
          s: this.player.s + this.player.v * time,
          vx: pose.vx,
          yaw: pose.yaw,
          length: C.PLAYER_LENGTH,
          width: C.PLAYER_WIDTH
        };
        const carBox = { x: car.x, s: car.s, yaw: 0, length: car.length, width: car.width };
        const clearance = obbClearance(playerBox, carBox);
        if (clearance < minClearance) minClearance = clearance;
        if (minClearance <= 0) break;
        this.advancePredictionCar(car, dt, this.player.v, clock);
        clock += dt;
      }
      return { collide: minClearance <= 0.02, clearance: minClearance };
    }

    playerSpeedStep(input, dt, risk) {
      let accel = -C.NATURAL_DECELERATION;
      risk = risk || { collide: false };
      if (input.brake) {
        accel = -(risk.collide ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);
      } else if (input.throttle) {
        accel = C.ACCELERATION;
      }
      this.player.v = clamp(this.player.v + accel * dt, 0, C.MAX_SPEED / 3.6);
      this.player.s += this.player.v * dt;
      this.speed = this.player.v * 3.6;
    }

    updateScoring(dt) {
      const state = this.scoring;
      const decel = (this.prevV - this.player.v) / dt;
      if (decel >= C.HARD_BRAKE_DECEL - 0.01 && this.player.v < this.prevV) {
        if (!state.hardBrakeLatch) {
          state.hardBrakes += 1;
          state.hardBrakeLatch = true;
          this.justHardBrake = true;
          if (this.laneChange.fullyIn && this.currentEvent) this.currentEvent.postHardBrake = true;
        }
      } else if (decel < 1.0) {
        state.hardBrakeLatch = false;
      }
      this.lastDeceleration = Math.max(0, decel);
      this.prevV = this.player.v;

      const event = this.currentEvent;
      const a = this.assessment;
      if (event && !event.resolved) {
        const exempt = a && a.observationComplete && !a.canChange;
        if (!exempt) {
          state.efficiencyTime += dt;
          const kmh = this.player.v * 3.6;
          if (kmh >= C.CRUISE_MIN_KMH && kmh <= C.CRUISE_MAX_KMH && !(a && a.overWait)) {
            state.efficiencyIntegral += dt;
          }
        }
      }
    }

    recordConflictState() {
      const event = this.currentEvent;
      if (!event || !this.conflict) return;
      const clearance = obbClearance(this.player, this.conflict);
      if (event.fullyInAt == null) event.minSideClearance = Math.min(event.minSideClearance, clearance);
      const assessment = this.assessment;
      if (assessment) {
        event.minRearGap = Math.min(event.minRearGap, assessment.followerGap);
        event.maxFollowerDecel = Math.max(event.maxFollowerDecel, assessment.aReq);
        if (assessment.aReq > C.FOLLOW_HARD_DECEL && this.laneChange.state === 'MOVING') {
          event.forcedFollower = true;
          event.forcedFollowerHard = true;
          event.failed = true;
        }
        if (this.laneChange.state === 'MOVING' && clearance < C.CLEARANCE_BUFFER && clearance > 0) {
          event.nearConflict = true;
        }
        if (this.laneChange.fullyIn && event.mergeDecel == null &&
          assessment.followerGap > 0 && assessment.relativeSpeed > 0) {
          const rel = assessment.relativeSpeed;
          event.mergeDecel = rel * rel / (2 * Math.max(assessment.followerGap - C.GAP_BUFFER, 0.3));
          if (event.mergeDecel > C.FOLLOW_COMFORT_DECEL + 0.15) event.unsafeMerge = true;
        }
      }
    }

    resolveEvent() {
      const event = this.currentEvent;
      event.resolved = true;
      event.completed = true;
      event.completedAt = event.elapsed;
      event.fullyInAt = event.fullyInAt != null ? event.fullyInAt : event.elapsed;
      this.finishEventScoring(event);
      this.justResolved = event;
      this.transition = C.SEGMENT_TRANSITION;
      this.transitionTotal = C.SEGMENT_TRANSITION;
    }

    finishEventScoring(event) {
      let score = 0;
      const commit = event.commit;
      if (commit) {
        if (commit.mirrorOk) score += 2;
        if (commit.shoulderOk) score += 3;
        if (commit.safeDecision) score += 3;
        if (event.completed && !event.speedMismatch && !event.postHardBrake) score += 2;
      }
      event.observationScore = clamp(Math.round(score), 0, 10);
      event.safe = Boolean(event.resolved && !event.failed && !event.forcedFollowerHard &&
        !event.nearConflict && !event.unsafeMerge);
    }

    freeze(reason, detail) {
      const event = this.currentEvent;
      if (!event) return;
      event.failed = true;
      event.failureReason = reason;
      this.status = 'frozen';
      this.justResolved = null;
      this.scoring.firstFailure = true;
      const conflict = this.conflict;
      let gap = detail && detail.gap != null ? detail.gap : 0;
      if (detail == null && conflict) {
        const carFront = conflict.s + conflict.length / 2;
        const carRear = conflict.s - conflict.length / 2;
        const playerRear = this.player.s - this.player.length / 2;
        const playerFront = this.player.s + this.player.length / 2;
        gap = conflict.s < this.player.s ? playerRear - carFront : carRear - playerFront;
      }
      this.freezeInfo = {
        eventId: event.id,
        reason: reason,
        side: event.side,
        speed: this.player.v * 3.6,
        gap: gap,
        mirror: this.observation.mirrorDwellMax[event.side],
        shoulder: this.observation.shoulderDwellMax[event.side],
        closure: Math.max(0, C.SEGMENT_START_TO_CLOSURE - (this.player.s + this.player.length / 2)),
        aReq: this.assessment ? this.assessment.aReq : 0,
        minSideClearance: conflict ? obbClearance(this.player, conflict) : null
      };
      this.speed = this.player.v * 3.6;
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      this.justResolved = null;
      this.justHardBrake = false;
      input = normalizeInput(input);
      if (this.transition > 0) {
        this.transition = Math.max(0, this.transition - dt);
        if (this.transition <= 0) {
          if (this.eventIndex + 1 < this.events.length) {
            this.activateEvent(this.eventIndex + 1);
          } else {
            this.status = 'complete';
            this.currentEvent = null;
          }
        }
        return;
      }
      if (!this.currentEvent) {
        this.status = 'complete';
        return;
      }

      const event = this.currentEvent;
      this.elapsed += dt;
      event.elapsed += dt;

      this.observation.update(dt, input, event.side, this.elapsed);
      this.laneChange.update(dt, input, event.side, this.elapsed);
      this.updateTraffic(dt);
      this.assessment = this.assess();
      this.recordConflictState();
      if (event.mergeDecel != null && event.mergeDecel > C.FOLLOW_HARD_DECEL) {
        this.freeze('follower', { gap: this.assessment.followerGap });
        return;
      }

      if (this.assessment.observationFresh) {
        if (this.observation.mirrorEnds[event.side] != null) {
          this.observation.everComplete[event.side] = true;
        }
      }

      const risk = this.predictiveCollision();
      this._risk = risk;
      if (risk.collide && this.conflict && obbClearance(this.player, this.conflict) > 0.02) {
        const reason = this.laneChange.state === 'MOVING' ||
          (this.laneChange.progress > 0 && this.laneChange.progress < 1) ? 'side' : 'rear';
        this.freeze(reason);
        return;
      }
      if (this.conflict && obbClearance(this.player, this.conflict) <= 0.02) {
        this.freeze(this.laneChange.state === 'MOVING' ? 'side' : 'rear');
        return;
      }

      const front = this.player.s + this.player.length / 2;
      if (front >= C.SEGMENT_START_TO_CLOSURE && !this.laneChange.fullyIn) {
        this.freeze('closure', { gap: C.SEGMENT_START_TO_CLOSURE - front });
        return;
      }

      if (this.laneChange.state === 'MOVING' &&
        this.assessment.aReq > C.FOLLOW_HARD_DECEL &&
        this.assessment.followerGap > 0) {
        this.freeze('follower', { gap: this.assessment.followerGap });
        return;
      }

      this.playerSpeedStep(input, dt, risk);
      this.updateScoring(dt);

      if (this.laneChange.state === 'LANE_KEEP' && this.laneChange.completedAt != null && !event.resolved) {
        this.resolveEvent();
        return;
      }

      if (this.elapsed >= C.MAX_TIME) {
        this.status = 'timeout';
        this.currentEvent = null;
      }
    }

    stepDemo(dt, input) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demo.step(defensiveInput(this.demo), dt);
      if (this.demo.status !== 'driving' ||
        (this.demo.currentEvent && this.demo.currentEvent.resolved)) {
        this.finishReplay();
      }
    }

    startDemo() {
      if (!this.freezeInfo) return;
      const id = this.freezeInfo.eventId;
      this.demo = new Simulation(this.seed, { plan: this.plan, eventId: id, demo: true });
      this.demo.start();
      this.demoMode = 'driver';
      this.status = 'demonstrating';
    }

    finishReplay() {
      this.demo = null;
      this.demoMode = null;
      this.retryEvent();
    }

    retryEvent() {
      if (!this.freezeInfo) {
        if (this.status !== 'driving') this.status = 'driving';
        return;
      }
      const id = this.freezeInfo.eventId;
      const event = this.events[id];
      event.attempts += 1;
      event.failed = true;
      this.freezeInfo = null;
      this.status = 'driving';
      this.activateEvent(id);
      this.currentEvent.failed = true;
    }

    timeout() {
      this.status = 'timeout';
      this.currentEvent = null;
    }

    makeDemo() {
      return this.demo;
    }
  }

  // --- Defensive policy ---------------------------------------------------

  function defensiveInput(sim) {
    const input = {
      left: false,
      right: false,
      throttle: false,
      brake: false,
      lookLeft: false,
      lookRight: false
    };
    if (!sim || sim.status !== 'driving') return input;
    const event = sim.currentEvent;
    if (!event || event.resolved || sim.transition > 0) return input;

    const target = event.side;
    const cruise = event.plan.player.initialSpeed;
    if (sim.player.v < cruise + 0.1) input.throttle = true;
    if (sim.player.v > cruise + 1.4) {
      input.throttle = false;
      input.brake = true;
    }

    const control = sim.defensiveControl || (sim.defensiveControl = {
      phase: 'observe',
      nextAt: 0,
      pressAt: 0
    });
    const laneChange = sim.laneChange;
    const observation = sim.observation;

    function pressSide() {
      if (target === 'left') input.left = true;
      else input.right = true;
    }

    function pressLook() {
      if (target === 'left') input.lookLeft = true;
      else input.lookRight = true;
    }

    if (laneChange.state === 'SIGNALING') {
      control.phase = 'move';
      pressSide();
      return input;
    }
    if (laneChange.state === 'MOVING' || laneChange.state === 'SETTLING') {
      control.phase = 'move';
      return input;
    }
    if (laneChange.state === 'ABORTING') {
      control.phase = 'observe';
      control.nextAt = sim.elapsed + 0.7;
      return input;
    }
    if (laneChange.completedAt != null) {
      control.phase = 'done';
      return input;
    }

    if (control.phase === 'request') {
      if (laneChange.requireNewRequest) {
        control.phase = 'observe';
        control.nextAt = sim.elapsed + 0.2;
        return input;
      }
      pressSide();
      return input;
    }

    if (control.phase === 'evaluate') {
      if (sim.elapsed < control.nextAt) return input;
      const assessment = sim.assessment;
      if (assessment && assessment.canChange && assessment.observationFresh) {
        control.phase = 'request';
        return input;
      }
      if (assessment && assessment.observationFresh) {
        control.nextAt = sim.elapsed + 0.25;
      } else {
        control.phase = 'observe';
        control.nextAt = sim.elapsed + 0.1;
      }
      return input;
    }

    if (control.phase === 'done') return input;

    // observe
    if (sim.elapsed < control.nextAt) return input;
    if (observation.lookSide === target) {
      if (observation.lookTime < 1.5) {
        pressLook();
      } else {
        control.phase = 'evaluate';
        control.nextAt = sim.elapsed + 0.28;
      }
      return input;
    }
    if (observation.lookSide != null) return input;
    if (observation.forcedFront) return input;
    if (observation.returnTimer > 0.01) return input;
    pressLook();
    return input;
  }

  // --- Scoring ------------------------------------------------------------

  const Scoring = {
    eventObservation: function (event) {
      return event && event.observationScore ? event.observationScore : 0;
    },
    eventSafe: function (event) {
      return Boolean(event && event.safe);
    },
    smoothScore: function (state) {
      const penalties = state.hardBrakes * 2 + state.dithering * 1.5 + state.lateAborts * 2;
      return clamp(Math.round(10 - penalties), 0, 10);
    },
    summarize: function (simulation, timedOut) {
      const events = simulation.events;
      const resolved = events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(function (event) { return event.safe; });
      const observation = resolved.reduce(function (sum, event) {
        return sum + Scoring.eventObservation(event);
      }, 0);
      const safety = Math.round(clean.length * 40 / events.length);
      const state = simulation.scoring;
      const efficiency = state.efficiencyTime > 0
        ? 20 * state.efficiencyIntegral / state.efficiencyTime
        : 20;
      const smooth = Scoring.smoothScore(state);
      const failed = events.some(function (event) { return event.failed; });
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
        summaryKey = 'scene.laneChange.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }

      let adviceKey = 'scene.laneChange.result.advice.default';
      if (failed) adviceKey = 'scene.laneChange.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.laneChange.result.advice.observation';
      else if (state.hardBrakes > 0) adviceKey = 'scene.laneChange.result.advice.smooth';
      else if (timedOut || efficiency < 12) adviceKey = 'scene.laneChange.result.advice.efficiency';

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
        completedCount: resolved.filter(function (event) { return event.completed; }).length,
        passedCount: clean.length,
        timedOut: Boolean(timedOut),
        failed: failed,
        adviceKey: adviceKey
      };
    }
  };

  // --- Renderer -----------------------------------------------------------

  const PLAYER_SCREEN_X = { left: 230, right: 130 };

  function playerLaneCenter(simulation) {
    const event = simulation.currentEvent ||
      simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    if (!event) return 180;
    return PLAYER_SCREEN_X[sourceSide(event.side)] || 230;
  }

  function screenX(simulation, worldX) {
    return playerLaneCenter(simulation) + (worldX || 0) * C.X_PIXELS_PER_METER;
  }

  function worldY(simulation, position) {
    return Draw.worldY(C, simulation, position);
  }

  function drawRoad(ctx, simulation) {
    Draw.rect(ctx, '#42634d', 0, 0, C.WIDTH, C.HEIGHT);
    Draw.rect(ctx, '#adae99', 58, 0, 22, C.HEIGHT);
    Draw.rect(ctx, '#adae99', 280, 0, 22, C.HEIGHT);
    Draw.rect(ctx, '#d4ceb3', 78, 0, 5, C.HEIGHT);
    Draw.rect(ctx, '#d4ceb3', 278, 0, 5, C.HEIGHT);
    Draw.rect(ctx, '#3b484b', 80, 0, 200, C.HEIGHT);
    Draw.rect(ctx, '#334145', 83, 0, 2, C.HEIGHT);
    Draw.rect(ctx, '#334145', 275, 0, 2, C.HEIGHT);

    const scroll = (simulation.distance * C.PIXELS_PER_METER) % 32;
    for (let y = -32 + scroll; y < C.HEIGHT + 32; y += 32) {
      Draw.rect(ctx, '#8d9686', 58, y, 22, 2);
      Draw.rect(ctx, '#8d9686', 280, y, 22, 2);
      Draw.rect(ctx, '#526064', 178, y, 4, 17);
    }

    const firstSegment = Math.floor((simulation.distance - 35) / 22);
    for (let i = 0; i < 9; i += 1) {
      const segment = firstSegment + i;
      const y = worldY(simulation, segment * 22);
      if (segment % 3 === 0) {
        Draw.rect(ctx, '#29443d', 0, y - 19, 32, 38);
        Draw.rect(ctx, '#36584b', 3, y - 16, 26, 30);
        Draw.rect(ctx, '#87a06e', 7, y - 10, 5, 5);
        Draw.rect(ctx, '#87a06e', 19, y + 2, 5, 5);
      } else {
        Draw.drawTree(ctx, 17, y, segment % 2);
      }
      if (segment % 2 === 0) Draw.drawTree(ctx, 343, y + 8, segment % 3);
      else {
        Draw.rect(ctx, '#203a39', 333, y - 12, 27, 34);
        Draw.rect(ctx, '#557360', 337, y - 8, 19, 24);
      }
    }
  }

  function drawClosure(ctx, simulation) {
    const event = simulation.currentEvent ||
      simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    if (!event) return;
    const plan = event.plan;
    const source = sourceSide(event.side);
    const center = PLAYER_SCREEN_X[source] || 230;
    const closureY = worldY(simulation, plan.closureLineS);
    const endY = worldY(simulation, plan.segmentEndS);
    if (endY < C.HEIGHT + 20 && closureY > -40) {
      const top = Math.max(-40, closureY);
      const bottom = Math.min(C.HEIGHT + 40, endY);
      if (bottom > top) {
        ctx.save();
        Draw.rect(ctx, '#2d2f2c', center - 50, top, 100, bottom - top);
        ctx.globalAlpha = 0.35;
        for (let stripe = top - 80; stripe < bottom + 80; stripe += 20) {
          ctx.fillStyle = '#e0b34f';
          ctx.beginPath();
          ctx.moveTo(center - 50, stripe);
          ctx.lineTo(center - 38, stripe);
          ctx.lineTo(center + 50, stripe + 58);
          ctx.lineTo(center + 50, stripe + 70);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        Draw.rect(ctx, '#4a3a22', center - 50, top, 100, 4);
        for (let i = -2; i <= 2; i += 1) {
          const coneY = worldY(simulation, plan.closureLineS + 1.2 + i * 1.6);
          if (coneY > 90 && coneY < C.HEIGHT) {
            Draw.rect(ctx, '#d76b35', center + i * 20 - 5, coneY - 4, 10, 10);
            Draw.rect(ctx, '#f7e6c4', center + i * 20 - 5, coneY, 10, 3);
          }
        }
      }
    }

    const warnY = worldY(simulation, plan.warningSignS);
    if (warnY > -30 && warnY < C.HEIGHT + 30) {
      Draw.rect(ctx, '#263c3d', 300, warnY, 4, 24);
      Draw.rect(ctx, '#d9cf9b', 286, warnY - 16, 32, 18);
      Draw.rect(ctx, '#4a6862', 289, warnY - 13, 26, 12);
      Draw.fillFittedText(ctx, t('scene.laneChange.canvas.closedAhead'), 291, warnY - 4, 22, 7, 'monospace');
    }

    const arrowY = worldY(simulation, plan.arrowBoardS);
    if (arrowY > -30 && arrowY < C.HEIGHT + 30) {
      const left = event.side === 'left';
      Draw.rect(ctx, '#263c3d', center - 2, arrowY, 4, 26);
      Draw.rect(ctx, '#22343a', center - 20, arrowY - 16, 40, 18);
      Draw.rect(ctx, '#ffd166', center - 17, arrowY - 13, 34, 12);
      Draw.fillFittedText(ctx, left ? '◀◀' : '▶▶', center - 14, arrowY - 4, 28, 9, 'monospace');
    }
  }

  function drawVehicle(ctx, simulation, vehicle, color, options) {
    options = options || {};
    if (!vehicle) return;
    const x = screenX(simulation, vehicle.x || 0);
    const y = worldY(simulation, vehicle.s);
    if (y < -70 || y > C.HEIGHT + 70) return;
    const width = 30;
    const length = 46;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(vehicle.yaw || 0);
    Draw.rect(ctx, '#10212a66', -width / 2 + 3, -length / 2 + 4, width, length);
    Draw.rect(ctx, '#14232b', -width / 2 - 2, -length / 2 + 6, 3, 9);
    Draw.rect(ctx, '#14232b', width / 2 - 1, -length / 2 + 6, 3, 9);
    Draw.rect(ctx, '#14232b', -width / 2 - 2, length / 2 - 14, 3, 9);
    Draw.rect(ctx, '#14232b', width / 2 - 1, length / 2 - 14, 3, 9);
    Draw.rect(ctx, color, -width / 2, -length / 2, width, length);
    Draw.rect(ctx, '#294651', -width / 2 + 3, -length / 2 + 8, width - 6, 9);
    Draw.rect(ctx, '#80b9c1', -width / 2 + 5, -length / 2 + 9, width - 10, 3);
    Draw.rect(ctx, '#1c343e', -width / 2 + 3, length / 2 - 15, width - 6, 8);
    Draw.rect(ctx, '#fff2bd', -width / 2 + 2, -length / 2, 5, 3);
    Draw.rect(ctx, '#fff2bd', width / 2 - 7, -length / 2, 5, 3);
    const braking = options.player ? simulation.lastDeceleration > 0.6 : vehicle.braking;
    if (braking) {
      Draw.rect(ctx, '#ff665c', -width / 2 + 2, length / 2 - 4, 6, 4);
      Draw.rect(ctx, '#ff665c', width / 2 - 8, length / 2 - 4, 6, 4);
    } else {
      Draw.rect(ctx, '#a83b3f', -width / 2 + 2, length / 2 - 3, 6, 3);
      Draw.rect(ctx, '#a83b3f', width / 2 - 8, length / 2 - 3, 6, 3);
    }
    if (vehicle.signalVisible) {
      const left = vehicle.signalSide === 'left';
      const blink = Math.floor((simulation.elapsed || 0) * 3) % 2 === 0;
      if (blink) {
        const sx = left ? -width / 2 + 1 : width / 2 - 6;
        Draw.rect(ctx, '#ffd166', sx, -length / 2 + 4, 5, 5);
        Draw.rect(ctx, '#ffd166', sx, length / 2 - 9, 5, 5);
      }
    }
    ctx.restore();
  }

  function drawTraffic(ctx, simulation, demo) {
    const playerS = simulation.player.s;
    const conflict = simulation.conflict;
    if (simulation.lead) drawVehicle(ctx, simulation, simulation.lead, simulation.lead.color, {});
    if (conflict) {
      const behind = conflict.s < playerS - 0.5;
      if (demo || !behind) {
        drawVehicle(ctx, simulation, conflict, demo ? '#65d6a1' : conflict.color, {});
      }
    }
  }

  function drawPlayer(ctx, simulation, demo) {
    const event = simulation.currentEvent;
    const laneChange = simulation.laneChange;
    const vehicle = {
      x: simulation.player.x,
      s: simulation.player.s,
      yaw: simulation.player.yaw,
      length: C.PLAYER_LENGTH,
      width: C.PLAYER_WIDTH,
      signalVisible: Boolean(event) && (laneChange.state === 'SIGNALING' || laneChange.state === 'MOVING'),
      signalSide: laneChange.signalSide,
      braking: false
    };
    drawVehicle(ctx, simulation, vehicle, demo ? '#65d6a1' : '#e7685b', { player: true });
  }

  function drawMirrorOverlay(ctx, simulation) {
    const side = simulation.observation.viewSide;
    const conflict = simulation.conflict;
    const left = side === 'left';
    const x = left ? 10 : 200;
    const y = 132;
    const width = 150;
    const height = 116;
    Draw.rect(ctx, '#0d1c24ee', x, y, width, height);
    ctx.save();
    ctx.strokeStyle = '#80e0b1';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    ctx.restore();
    Draw.rect(ctx, '#1d323d', x + 4, y + 4, width - 8, 20);
    Draw.fillFittedText(ctx, t(left ? 'scene.laneChange.view.mirrorLeft' : 'scene.laneChange.view.mirrorRight'),
      x + 8, y + 18, width - 16, 9, 'sans-serif');
    Draw.rect(ctx, '#334145', x + 30, y + 30, 3, height - 38);
    Draw.rect(ctx, '#334145', x + width - 33, y + 30, 3, height - 38);
    Draw.rect(ctx, '#526064', x + width / 2 - 1, y + 30, 3, height - 38);
    if (conflict && mirrorCovers(simulation, conflict)) {
      const distance = carBehindDistance(simulation, conflict);
      const ratio = clamp((distance - C.MIRROR_ZONE_NEAR) / (C.MIRROR_ZONE_FAR - C.MIRROR_ZONE_NEAR), 0, 1);
      const carY = y + height - 26 - ratio * (height - 58);
      const scale = 1 - ratio * 0.35;
      ctx.save();
      ctx.translate(x + width / 2, carY);
      ctx.scale(scale, scale);
      Draw.rect(ctx, '#e7bd5c', -9, -15, 18, 30);
      Draw.rect(ctx, '#294651', -7, -12, 14, 7);
      Draw.rect(ctx, '#fff2bd', -8, -15, 4, 2);
      Draw.rect(ctx, '#fff2bd', 4, -15, 4, 2);
      ctx.restore();
    } else if (simulation.lead) {
      const distance = carBehindDistance(simulation, simulation.lead);
      if (distance >= C.MIRROR_ZONE_NEAR && distance <= C.MIRROR_ZONE_FAR) {
        Draw.rect(ctx, '#8fc7c2', x + width / 2 - 7, y + 44, 14, 22);
      }
    }
    Draw.rect(ctx, '#132633dd', x + 4, y + height - 20, width - 8, 16);
    Draw.fillFittedText(ctx, t('scene.laneChange.view.lookHint'), x + 8, y + height - 9, width - 16, 8, 'sans-serif');
  }

  function drawShoulderOverlay(ctx, simulation) {
    const side = simulation.observation.lookSide;
    const left = side === 'left';
    Draw.rect(ctx, '#0b1a22ee', 0, 90, C.WIDTH, C.HEIGHT - 90);
    Draw.rect(ctx, '#142a34', 8, 98, 344, 34);
    Draw.fillFittedText(ctx,
      t(left ? 'scene.laneChange.view.shoulderLeft' : 'scene.laneChange.view.shoulderRight'),
      20, 120, 250, 12, 'sans-serif');
    Draw.fillFittedText(ctx, t('scene.laneChange.canvas.shoulderChecking'), 250, 120, 96, 8, 'sans-serif');

    Draw.rect(ctx, '#2d3c40', 100, 150, 160, 430);
    Draw.rect(ctx, '#3b4a4c', 176, 150, 4, 430);
    Draw.rect(ctx, '#d4ceb3', 96, 150, 5, 430);
    Draw.rect(ctx, '#d4ceb3', 259, 150, 5, 430);
    for (let y = 158; y < 580; y += 30) {
      Draw.rect(ctx, '#526064', 176, y, 4, 15);
    }

    const conflict = simulation.conflict;
    if (conflict) {
      const distance = carBehindDistance(simulation, conflict);
      if (distance >= -2 && distance <= C.SHOULDER_ZONE_FAR + 2) {
        const y = 552 - distance * 15;
        if (y > 160 && y < 570) {
          ctx.save();
          ctx.translate(178, y);
          Draw.rect(ctx, '#10212a88', -12, -20, 24, 40);
          Draw.rect(ctx, conflict.kind === 'lead' ? '#8fc7c2' : '#e7bd5c', -11, -19, 22, 38);
          Draw.rect(ctx, '#294651', -8, -15, 16, 8);
          Draw.rect(ctx, '#fff2bd', -10, -19, 4, 2);
          Draw.rect(ctx, '#fff2bd', 6, -19, 4, 2);
          Draw.rect(ctx, '#a83b3f', -10, 16, 4, 3);
          Draw.rect(ctx, '#a83b3f', 6, 16, 4, 3);
          ctx.restore();
        }
      }
    }

    Draw.rect(ctx, '#132633dd', 118, 590, 124, 20);
    Draw.fillFittedText(ctx, t('scene.laneChange.canvas.blindZone'), 126, 603, 108, 8, 'sans-serif');

    const ratio = clamp(simulation.observation.lookTime / C.LOOK_MAX, 0, 1);
    ctx.save();
    ctx.strokeStyle = '#80e0b1';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(330, 590, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
    ctx.stroke();
    ctx.restore();
    Draw.fillFittedText(ctx, '2.4s', 314, 594, 32, 7, 'monospace');
  }

  function drawCanvasHud(ctx, simulation) {
    const event = simulation.currentEvent;
    if (!event) return;
    const assessment = simulation.assessment;
    const left = event.side === 'left';
    const closure = assessment ? assessment.closureRemaining : C.SEGMENT_START_TO_CLOSURE;
    const distanceKey = closure < 35 ? 'veryNear' : (closure < 85 ? 'near' : 'far');

    Draw.rect(ctx, '#132633dd', 8, 592, 190, 38);
    Draw.fillFittedText(ctx,
      t('scene.laneChange.laneTask', { side: t(left ? 'scene.laneChange.view.targetLeft' : 'scene.laneChange.view.targetRight') }),
      14, 606, 178, 9, 'sans-serif');
    Draw.fillFittedText(ctx, t('scene.laneChange.closureDistance.' + distanceKey), 14, 622, 178, 8, 'sans-serif');

    const observation = simulation.observation;
    const mirrorOk = observation.mirrorEnds[event.side] != null;
    const shoulderOk = observation.shoulderEnds[event.side] != null;
    Draw.rect(ctx, '#132633dd', 204, 592, 148, 38);
    Draw.fillFittedText(ctx,
      t('scene.laneChange.canvas.mirrorShort') + ' ' + (mirrorOk ? '✓' : '·') + '   ' +
      t('scene.laneChange.canvas.shoulderShort') + ' ' + (shoulderOk ? '✓' : '·'),
      212, 607, 132, 9, 'sans-serif');
    Draw.fillFittedText(ctx,
      t(left ? 'scene.laneChange.view.mirrorLeft' : 'scene.laneChange.view.mirrorRight'),
      212, 622, 132, 8, 'sans-serif');
  }

  function drawBlindWedge(ctx, simulation) {
    const event = simulation.currentEvent;
    if (!event) return;
    const center = PLAYER_SCREEN_X[sourceSide(event.side)] || 230;
    const target = PLAYER_SCREEN_X[event.side] || 130;
    const yNear = worldY(simulation, simulation.player.s + 2);
    const yFar = worldY(simulation, simulation.player.s - C.BLIND_ZONE_REAR);
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(center + (event.side === 'left' ? -22 : 22), yNear);
    ctx.lineTo(target - 46, yFar);
    ctx.lineTo(target + 46, yFar);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawHistory(ctx, simulation) {
    const event = simulation.currentEvent;
    if (!event || event.history.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#80e0b188';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    event.history.forEach(function (sample, index) {
      const x = screenX(simulation, sample.x);
      const y = worldY(simulation, sample.s);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawFreeze(ctx, simulation) {
    Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
    const car = simulation.conflict;
    if (car) {
      ctx.save();
      ctx.strokeStyle = '#fff0a8';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(screenX(simulation, simulation.player.x), C.CAR_Y);
      ctx.lineTo(screenX(simulation, car.x), worldY(simulation, car.s));
      ctx.stroke();
      ctx.restore();
    }
    Draw.rect(ctx, '#fff0b0', C.CAR_X + 24, C.CAR_Y - 34, 24, 26);
    Draw.rect(ctx, '#3b2a0e', C.CAR_X + 34, C.CAR_Y - 29, 4, 11);
    Draw.rect(ctx, '#3b2a0e', C.CAR_X + 34, C.CAR_Y - 15, 4, 4);
  }

  function drawDemoNotes(ctx, simulation) {
    drawBlindWedge(ctx, simulation);
    drawHistory(ctx, simulation);
    Draw.rect(ctx, '#0e202ddd', 10, 548, 340, 40);
    Draw.fillFittedText(ctx, t('scene.laneChange.demo.principles'), 20, 573, 320, 10, 'sans-serif');
  }

  function renderScene(ctx, simulation, demo) {
    drawRoad(ctx, simulation);
    drawClosure(ctx, simulation);
    if (demo) {
      drawBlindWedge(ctx, simulation);
      drawHistory(ctx, simulation);
    }
    drawTraffic(ctx, simulation, demo);
    drawPlayer(ctx, simulation, demo);
    drawCanvasHud(ctx, simulation);
    if (!demo) {
      if (simulation.observation.view === 'mirror') drawMirrorOverlay(ctx, simulation);
      else if (simulation.observation.view === 'shoulder') drawShoulderOverlay(ctx, simulation);
    }
    if (demo) drawDemoNotes(ctx, simulation);
    if (simulation.transition > 0 && simulation.transitionTotal > 0) {
      const ratio = simulation.transition / simulation.transitionTotal;
      ctx.save();
      ctx.globalAlpha = ratio > 0.5 ? (1 - ratio) * 1.2 : ratio * 1.2;
      Draw.rect(ctx, '#0a151b', 0, 0, C.WIDTH, C.HEIGHT);
      ctx.restore();
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        renderScene(ctx, simulation.demo, true);
      } else {
        renderScene(ctx, simulation, false);
        if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
      }
    },
    screenX: screenX,
    worldY: worldY
  };

  // --- Scene pack ---------------------------------------------------------

  const Scene = {
    id: 'lane-change-blind-spot',
    Constants: C,
    Plan: { createPlan: createPlan },
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    ObservationController: ObservationController,
    LaneChangeController: LaneChangeController,
    Geometry: {
      boxCorners: boxCorners,
      obbIntersects: obbIntersects,
      obbClearance: obbClearance,
      mirrorCovers: mirrorCovers,
      shoulderCovers: shoulderCovers
    },
    createPlan: createPlan,
    validatePlan: function (plan) {
      const failures = [];
      plan.events.forEach(function (event) {
        const simulation = new Simulation(plan.seed, { plan: plan, eventId: event.id });
        simulation.start();
        let steps = 0;
        while (simulation.status === 'driving' && !simulation.events[event.id].resolved && steps < 6000) {
          simulation.step(defensiveInput(simulation), C.FIXED_STEP);
          steps += 1;
        }
        const record = simulation.events[event.id];
        if (!record.resolved || !record.safe || record.observationScore < 10) {
          failures.push({
            eventId: event.id,
            template: event.template,
            status: simulation.status,
            resolved: record.resolved,
            safe: record.safe,
            observation: record.observationScore
          });
        }
      });
      return { ok: failures.length === 0, failures: failures };
    },
    defensiveInput: defensiveInput,
    ui: {
      progress: function (simulation) {
        return t('scene.laneChange.hud.progress', {
          resolved: simulation.events.filter(function (event) { return event.resolved; }).length
        });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.completed && event.resolved; }).length,
          simulation.scoring.hardBrakes + simulation.scoring.dithering,
          simulation.events.filter(function (event) { return event.safe; }).length
        ];
      },
      smoothScore: function (simulation) {
        return Scoring.smoothScore(simulation.scoring);
      },
      coach: function (simulation, displaySpeed) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (!event || event.resolved) {
          return { text: t('scene.laneChange.hud.cruise'), status: t('hud.cruiseGood'), coachTone: '', tone: '' };
        }
        const observation = current.observation;
        const laneChange = current.laneChange;
        const assessment = current.assessment;
        if (laneChange.state === 'SIGNALING') {
          return { text: t('scene.laneChange.hud.signal'), status: t('scene.laneChange.status.signal'), coachTone: '', tone: '' };
        }
        if (laneChange.state === 'MOVING') {
          return { text: t('scene.laneChange.hud.changing'), status: t('scene.laneChange.status.changing'), coachTone: '', tone: '' };
        }
        if (laneChange.state === 'ABORTING') {
          return { text: t('scene.laneChange.hud.aborted'), status: t('scene.laneChange.status.aborted'), coachTone: 'good', tone: '' };
        }
        if (laneChange.completedAt != null) {
          return { text: t('scene.laneChange.hud.completed'), status: t('scene.laneChange.status.completed'), coachTone: 'good', tone: '' };
        }
        if (observation.view === 'mirror') {
          return { text: t('scene.laneChange.hud.mirror'), status: t('scene.laneChange.status.mirror'), coachTone: '', tone: '' };
        }
        if (observation.view === 'shoulder') {
          return { text: t('scene.laneChange.hud.shoulder'), status: t('scene.laneChange.status.shoulder'), coachTone: '', tone: '' };
        }
        if (assessment && assessment.everComplete && !assessment.observationFresh) {
          return { text: t('scene.laneChange.hud.stale'), status: t('scene.laneChange.status.stale'), coachTone: 'warn', tone: 'warn' };
        }
        if (!assessment || !assessment.observationComplete) {
          return { text: t('scene.laneChange.hud.approach'), status: t('scene.laneChange.status.approach'), coachTone: '', tone: '' };
        }
        if (assessment.overWait) {
          return { text: t('scene.laneChange.hud.overWait'), status: t('scene.laneChange.status.overWait'), coachTone: 'warn', tone: 'warn' };
        }
        if (assessment.canChange) {
          return { text: t('scene.laneChange.hud.clear'), status: t('scene.laneChange.status.clear'), coachTone: 'good', tone: '' };
        }
        if (assessment.blindSpotOccupied || assessment.targetRearConflict) {
          return { text: t('scene.laneChange.hud.traffic'), status: t('scene.laneChange.status.traffic'), coachTone: 'warn', tone: 'warn' };
        }
        if (assessment.closureRemaining < 45) {
          return { text: t('scene.laneChange.hud.close'), status: t('scene.laneChange.status.close'), coachTone: 'warn', tone: 'warn' };
        }
        const speedStatus = displaySpeed >= 42 && displaySpeed <= 55
          ? 'hud.cruiseGood'
          : (displaySpeed < 42 ? 'hud.speedUp' : 'hud.nearLimit');
        return { text: t('scene.laneChange.hud.wait'), status: t(speedStatus), coachTone: '', tone: '' };
      },
      retryToast: function () {
        return { key: 'scene.laneChange.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return {
          key: score === 10 ? 'scene.laneChange.toast.safe' : 'scene.laneChange.toast.improve',
          params: { score: score },
          neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        const key = 'scene.laneChange.failure.' + (REASONS.indexOf(info.reason) >= 0 ? info.reason : 'generic');
        return t(key, {
          side: t(info.side === 'left' ? 'scene.laneChange.view.targetLeft' : 'scene.laneChange.view.targetRight'),
          speed: Math.round(info.speed),
          gap: Math.max(0, info.gap).toFixed(1),
          mirror: info.mirror ? info.mirror.toFixed(1) : '0.0',
          shoulder: info.shoulder ? info.shoulder.toFixed(1) : '0.0',
          closure: Math.max(0, info.closure).toFixed(0),
          aReq: info.aReq ? info.aReq.toFixed(1) : '0.0'
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        if (!demo) return { step: '', substep: '' };
        const event = demo.currentEvent;
        if (!event) return { step: t('scene.laneChange.demo.done'), substep: t('scene.laneChange.demo.doneSub') };
        if (demo.laneChange.state === 'MOVING' || demo.laneChange.state === 'SETTLING') {
          return { step: t('scene.laneChange.demo.change'), substep: t('scene.laneChange.demo.changeSub') };
        }
        if (demo.observation.view === 'mirror') {
          return { step: t('scene.laneChange.demo.mirror'), substep: t('scene.laneChange.demo.mirrorSub') };
        }
        if (demo.observation.view === 'shoulder') {
          return { step: t('scene.laneChange.demo.shoulder'), substep: t('scene.laneChange.demo.shoulderSub') };
        }
        if (event.template === 'blind-spot-car') {
          return { step: t('scene.laneChange.demo.blindSpot'), substep: t('scene.laneChange.demo.blindSpotSub') };
        }
        if (event.template === 'fast-closing' && event.plan.targetTraffic.conflict.subType === 'fast-near') {
          return { step: t('scene.laneChange.demo.fastNear'), substep: t('scene.laneChange.demo.fastNearSub') };
        }
        if (event.template === 'fast-closing') {
          return { step: t('scene.laneChange.demo.fastFar'), substep: t('scene.laneChange.demo.fastFarSub') };
        }
        return { step: t('scene.laneChange.demo.clear'), substep: t('scene.laneChange.demo.clearSub') };
      },
      updateControls: function (doc, simulation) {
        const replay = simulation.status === 'demonstrating' && simulation.demoMode !== 'driver';
        const badge = doc.querySelector('#demo-screen .demo-badge');
        const skip = doc.getElementById('skip-demo-button');
        if (badge) badge.textContent = t(replay ? 'scene.laneChange.replay.badge' : 'game.demoBadge');
        if (skip) skip.textContent = t(replay ? 'scene.laneChange.replay.skip' : 'game.skipDemo');
        const proceed = doc.getElementById('demo-proceed-button');
        if (proceed) proceed.hidden = true;
      },
      controls: function () {
        return {
          throttle: {
            label: t('game.accelerate'),
            icon: '▲',
            aria: t('game.accelerate')
          },
          brake: {
            label: t('game.brake'),
            icon: '▼',
            aria: t('game.brake')
          },
          left: {
            label: t('scene.laneChange.controls.changeLeft'),
            icon: '◀',
            aria: t('scene.laneChange.controls.changeLeft')
          },
          right: {
            label: t('scene.laneChange.controls.changeRight'),
            icon: '▶',
            aria: t('scene.laneChange.controls.changeRight')
          },
          lookLeft: {
            label: t('scene.laneChange.controls.lookLeft'),
            icon: 'Q',
            aria: t('scene.laneChange.controls.lookLeftAria')
          },
          lookRight: {
            label: t('scene.laneChange.controls.lookRight'),
            icon: 'E',
            aria: t('scene.laneChange.controls.lookRightAria')
          }
        };
      }
    }
  };

  Scene.trajectoryAt = function (simulation, now) {
    return simulation.laneChange.poseAt(now, simulation.player.v);
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
