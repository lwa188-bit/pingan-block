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
  const PI = Math.PI;

  const C = Object.assign({}, Game.C, {
    CAR_Y: 482,
    ROAD_LEFT: 80,
    ROAD_RIGHT: 280,
    ROAD_CENTER: 180,
    LANE_WIDTH: 3.5,
    LANE_PIXELS: 100,
    X_PIXELS_PER_METER: 100 / 3.5,
    PIXELS_PER_METER: 7.2,
    START_SPEED: 45,
    MIN_SPEED: 0,
    MAX_SPEED: 66,
    ACCELERATION: 1.35,
    BRAKE_DECELERATION: 3.0,
    EMERGENCY_BRAKE_DECELERATION: 6.4,
    NATURAL_DECELERATION: 0.45,
    PLAYER_LENGTH: 4.4,
    PLAYER_WIDTH: 1.8,

    TRUCK_LENGTH: 9.0,
    TRUCK_WIDTH: 2.5,
    TRUCK_HEIGHT: 3.2,
    TRUCK_CAB_LENGTH: 2.2,
    TRUCK_EYE_HEIGHT: 2.25,
    TRUCK_EYE_FROM_FRONT: 1.4,
    TRUCK_MIRROR_Z: 2.05,
    DIRECT_HALF_ANGLE: 55 * PI / 180,
    MIRROR_MAIN_HALF_ANGLE: 11 * PI / 180,
    MIRROR_WIDE_HALF_ANGLE: 22 * PI / 180,
    MIRROR_VERTICAL_HALF_ANGLE: 10 * PI / 180,
    MIRROR_RANGE: 50,
    MIRROR_MIN_RANGE: 6,
    FRONT_BLIND_DISTANCE: 6,
    FRONT_VISIBLE_GAP: 12,
    REAR_BLIND_DISTANCE: 18,
    SIDE_BLIND_INNER: 0.8,
    SIDE_BLIND_OUTER: 3.6,
    SIDE_BLIND_MAX: 3.6,

    SIGNAL_LEAD: 0.5,
    LANE_CHANGE_TIME: 2.4,
    ABORT_TIME: 1.2,
    COMMIT_PROGRESS: 0.55,
    STABLE_DWELL: 0.5,
    SEGMENT_TRANSITION: 1.2,
    MAX_TIME: 100,

    PREDICTION_STEP: 0.025,
    PREDICTION_HORIZON: 3.0,
    IMMEDIATE_HORIZON: 0.4,
    FOLLOW_COMFORT_DECEL: 2.5,
    FOLLOW_HARD_DECEL: 4.5,
    GAP_BUFFER: 2.0,
    CLEARANCE_BUFFER: 0.35,
    CRUISE_MIN_KMH: 40,
    CRUISE_MAX_KMH: 55,
    HARD_BRAKE_DECEL: 5.0,

    A_PLAYER_SPEED: 12.5,
    A_TRUCK_SPEED: 11.67,
    A_TRUCK_SLOW: 11.11,
    B_PLAYER_SPEED: 15.28,
    B_TRUCK_SPEED: 11.11,
    B_CLOSURE: 180,
    B_WARNING: 8,
    B_ARROW: 55,
    B_QUEUE_SPEED: 8.0,
    C_PLAYER_SPEED: 11.11,
    C_TRUCK_REVERSE: 1.0,
    C_REVERSE_DISTANCE: 7.0,
    C_STOP_CLEARANCE: 5.0,
    C_PASS_CLEARANCE: 2.0,
    C_REVERSE_START: 1.5,
    C_TURN_TIME: 2.5,

    REASON_TIMEOUT: 'timeout'
  });

  const REASONS = ['sideSqueeze', 'frontRearEnd', 'frontClosure', 'rearBackover', 'timeout', 'generic'];

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
    return sideSign(side) * C.LANE_WIDTH / 2;
  }

  function otherSide(side) {
    return side === 'left' ? 'right' : 'left';
  }

  function normalizeInput(input) {
    input = input || {};
    return {
      left: Boolean(input.left),
      right: Boolean(input.right),
      throttle: Boolean(input.throttle),
      brake: Boolean(input.brake)
    };
  }

  // --- Geometry -----------------------------------------------------------

  function boxCorners(vehicle) {
    const yaw = vehicle.yaw || 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const forward = { x: sin, s: cos };
    const right = { x: cos, s: -sin };
    const hl = (vehicle.length || C.PLAYER_LENGTH) / 2;
    const hw = (vehicle.width || C.PLAYER_WIDTH) / 2;
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

  function truckLocal(truck, point) {
    const cos = Math.cos(truck.yaw || 0);
    const sin = Math.sin(truck.yaw || 0);
    const dx = (point.x || 0) - truck.x;
    const ds = (point.s || 0) - truck.s;
    return { x: dx * cos - ds * sin, s: dx * sin + ds * cos };
  }

  function truckWorld(truck, local) {
    const cos = Math.cos(truck.yaw || 0);
    const sin = Math.sin(truck.yaw || 0);
    return {
      x: truck.x + local.x * cos + local.s * sin,
      s: truck.s - local.x * sin + local.s * cos
    };
  }

  // --- Truck visibility ---------------------------------------------------

  function truckGeometry(truck) {
    const L = C.TRUCK_LENGTH;
    const W = C.TRUCK_WIDTH;
    const cab = C.TRUCK_CAB_LENGTH;
    return {
      eye: { x: 0, s: L / 2 - C.TRUCK_EYE_FROM_FRONT, z: C.TRUCK_EYE_HEIGHT },
      boxes: [
        {
          minX: -W / 2, maxX: W / 2,
          minS: -L / 2, maxS: L / 2 - cab,
          minZ: 0, maxZ: C.TRUCK_HEIGHT
        },
        {
          minX: -W / 2, maxX: W / 2,
          minS: L / 2 - cab, maxS: L / 2,
          minZ: 0, maxZ: 3.0
        }
      ],
      mirrors: [
        {
          side: 'left',
          x: -W / 2 - 0.2,
          s: L / 2 - 1.0,
          z: C.TRUCK_MIRROR_Z,
          dirX: -0.45,
          dirS: -1
        },
        {
          side: 'right',
          x: W / 2 + 0.2,
          s: L / 2 - 1.0,
          z: C.TRUCK_MIRROR_Z,
          dirX: 0.45,
          dirS: -1
        }
      ]
    };
  }

  function pointInBox(point, box, margin) {
    margin = margin || 0;
    return point.x >= box.minX - margin && point.x <= box.maxX + margin &&
      point.s >= box.minS - margin && point.s <= box.maxS + margin &&
      point.z >= box.minZ - margin && point.z <= box.maxZ + margin;
  }

  function segmentHitsBox(a, b, box) {
    let tmin = 0;
    let tmax = 1;
    const axes = ['x', 's', 'z'];
    for (let i = 0; i < axes.length; i += 1) {
      const axis = axes[i];
      const start = a[axis];
      const delta = b[axis] - start;
      const min = axis === 'x' ? box.minX : (axis === 's' ? box.minS : box.minZ);
      const max = axis === 'x' ? box.maxX : (axis === 's' ? box.maxS : box.maxZ);
      if (Math.abs(delta) < 1e-9) {
        if (start < min || start > max) return false;
      } else {
        let t1 = (min - start) / delta;
        let t2 = (max - start) / delta;
        if (t1 > t2) {
          const swap = t1;
          t1 = t2;
          t2 = swap;
        }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return false;
      }
    }
    return true;
  }

  function segmentBlocked(a, b, boxes) {
    for (let i = 0; i < boxes.length; i += 1) {
      if (segmentHitsBox(a, b, boxes[i])) return true;
    }
    return false;
  }

  function directVisible(truck, geo, point) {
    const local = truckLocal(truck, point);
    const dx = local.x - geo.eye.x;
    const ds = local.s - geo.eye.s;
    if (ds <= 0.2) return false;
    const horizontal = Math.atan2(dx, ds);
    if (Math.abs(horizontal) > C.DIRECT_HALF_ANGLE) return false;
    const gapFront = local.s - C.TRUCK_LENGTH / 2;
    if (gapFront > 0 && gapFront < C.FRONT_BLIND_DISTANCE && point.z < 1.6) return false;
    const start = { x: geo.eye.x, s: geo.eye.s, z: geo.eye.z };
    const end = { x: local.x, s: local.s, z: point.z };
    const blocks = geo.boxes.filter(function (box) { return !pointInBox(start, box, 0.02); });
    return !segmentBlocked(start, end, blocks);
  }

  function mirrorVisible(truck, geo, point) {
    const localPoint = truckLocal(truck, point);
    for (let i = 0; i < geo.mirrors.length; i += 1) {
      const mirror = geo.mirrors[i];
      const vx = localPoint.x - mirror.x;
      const vs = localPoint.s - mirror.s;
      const distance = Math.sqrt(vx * vx + vs * vs);
      if (distance < C.MIRROR_MIN_RANGE || distance > C.MIRROR_RANGE) continue;
      const dirLength = Math.sqrt(mirror.dirX * mirror.dirX + mirror.dirS * mirror.dirS);
      const dirX = mirror.dirX / dirLength;
      const dirS = mirror.dirS / dirLength;
      const dot = (vx * dirX + vs * dirS) / distance;
      const angle = Math.acos(clamp(dot, -1, 1));
      const wide = angle <= C.MIRROR_WIDE_HALF_ANGLE;
      const main = angle <= C.MIRROR_MAIN_HALF_ANGLE;
      if (!wide) continue;
      const vertical = Math.abs(Math.atan2(mirror.z - point.z, distance));
      if (vertical > C.MIRROR_VERTICAL_HALF_ANGLE) continue;
      // A main mirror is a subset of the wide-angle sector; both are modelled.
      if (!main && !wide) continue;
      const start = { x: mirror.x, s: mirror.s, z: mirror.z };
      const end = { x: localPoint.x, s: localPoint.s, z: point.z };
      // A mirror mounted just outside the body can see past the cargo box.
      const blocks = geo.boxes.filter(function (box) { return !pointInBox(start, box, 0.02); });
      if (!segmentBlocked(start, end, blocks)) return true;
    }
    return false;
  }

  function playerSamples(player) {
    const corners = boxCorners(player);
    return corners.map(function (corner) {
      return { x: corner.x, s: corner.s, z: 0.75 };
    }).concat([
      { x: player.x, s: player.s, z: 1.45 },
      { x: player.x - 0.35, s: player.s + 0.2, z: 1.2 },
      { x: player.x, s: player.s - player.length * 0.3, z: 0.95 }
    ]);
  }

  function driverVisibility(truck, player) {
    const geo = truckGeometry(truck);
    const samples = playerSamples(player);
    let visibleCount = 0;
    let directCount = 0;
    let mirrorCount = 0;
    samples.forEach(function (point) {
      const direct = directVisible(truck, geo, point);
      const mirror = mirrorVisible(truck, geo, point);
      if (direct) directCount += 1;
      if (mirror) mirrorCount += 1;
      if (direct || mirror) visibleCount += 1;
    });
    const fraction = visibleCount / samples.length;
    const center = truckLocal(truck, { x: player.x, s: player.s });
    const frontGap = (player.s - player.length / 2) - (truck.s + C.TRUCK_LENGTH / 2);
    const rearGap = (truck.s - C.TRUCK_LENGTH / 2) - (player.s + player.length / 2);
    let zone = 'clear';
    if (Math.abs(center.s) <= C.TRUCK_LENGTH / 2 + 0.6 &&
      Math.abs(center.x) >= C.TRUCK_WIDTH / 2 && Math.abs(center.x) <= C.SIDE_BLIND_MAX) {
      zone = center.x < 0 ? 'left' : 'right';
    }
    if (frontGap >= -0.5 && frontGap < C.FRONT_BLIND_DISTANCE + 0.5 && Math.abs(center.x) < 1.8) {
      zone = 'front';
    }
    if (rearGap >= -0.5 && rearGap < C.REAR_BLIND_DISTANCE && Math.abs(center.x) < 1.8) {
      zone = 'rear';
    }
    return {
      visible: visibleCount >= 2,
      visibleFraction: fraction,
      visibleSamples: visibleCount,
      directVisible: directCount > 0,
      mirrorVisible: mirrorCount > 0,
      zone: zone,
      center: center
    };
  }

  function zoneKey(zone) {
    if (zone === 'front') return 'scene.largeVehicle.zone.front';
    if (zone === 'rear') return 'scene.largeVehicle.zone.rear';
    if (zone === 'left') return 'scene.largeVehicle.zone.left';
    if (zone === 'right') return 'scene.largeVehicle.zone.right';
    return 'scene.largeVehicle.zone.visible';
  }

  // --- Plan ---------------------------------------------------------------

  function createPlan(seed) {
    const random = Model.mulberry32(Model.hashSeed(seed));
    const templates = ['side-blind-merge', 'front-blind-cut-in', 'rear-blind-reversing'];
    for (let i = templates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const swap = templates[i];
      templates[i] = templates[j];
      templates[j] = swap;
    }
    const events = templates.map(function (template, index) {
      if (template === 'side-blind-merge') {
        const side = random() < 0.5 ? 'left' : 'right';
        const truckStartS = 5 + random() * 1.1;
        return {
          id: index,
          template: template,
          mergeSide: side,
          playerLane: side,
          player: { initialSpeed: C.A_PLAYER_SPEED + random() * 0.35 },
          truck: {
            startX: laneCenterX(otherSide(side)),
            targetX: laneCenterX(side),
            s: truckStartS,
            speed: C.A_TRUCK_SPEED,
            slowSpeed: C.A_TRUCK_SLOW,
            brakeAt: 1.5,
            signalAt: 0.5,
            lateralStart: 2.5,
            lateralDuration: 8.0
          },
          route: { kind: 'two-lane' }
        };
      }
      if (template === 'front-blind-cut-in') {
        return {
          id: index,
          template: template,
          mergeSide: 'right',
          playerLane: 'left',
          player: { initialSpeed: C.B_PLAYER_SPEED },
          truck: {
            x: laneCenterX('right'),
            s: 12 + random() * 1.5,
            speed: C.B_TRUCK_SPEED
          },
          closure: { lineS: C.B_CLOSURE, warningS: C.B_WARNING, arrowS: C.B_ARROW },
          queue: {
            x: laneCenterX('right'),
            s: 120 + random() * 8,
            speed: C.B_QUEUE_SPEED,
            brakeAt: 6
          },
          route: { kind: 'closure' }
        };
      }
      return {
        id: index,
        template: template,
        passSide: 'left',
        playerLane: 'right',
        player: { initialSpeed: C.C_PLAYER_SPEED },
        truck: {
          x: 2.4,
          s: 62 + random() * 1.2,
          speed: 0,
          reverseStartAt: C.C_REVERSE_START,
          reverseSpeed: C.C_TRUCK_REVERSE,
          reverseDistance: C.C_REVERSE_DISTANCE,
          bayX: 10.5,
          turnTime: C.C_TURN_TIME
        },
        bay: { side: 'right', s: 62 + random() * 1.2 },
        route: { kind: 'loading-bay' }
      };
    });
    return { seed: seed == null ? 'large-vehicle' : seed, events: events };
  }

  // --- Player lane control ------------------------------------------------

  class LaneChangeController {
    constructor(sim) {
      this.sim = sim;
      this.reset('right');
    }

    reset(laneSide) {
      this.laneSide = laneSide || 'right';
      this.x = laneCenterX(this.laneSide);
      this.vx = 0;
      this.state = 'LANE_KEEP';
      this.signalSide = null;
      this.signalOnAt = null;
      this.movementStartAt = null;
      this.fromX = this.x;
      this.toX = this.x;
      this.progress = 0;
      this.settleStartAt = null;
      this.completedAt = null;
      this.fullyInAt = null;
      this.abortAt = null;
      this.abortFromX = 0;
      this.abortFromVx = 0;
      this.abortElapsed = 0;
      this.abortSource = this.laneSide;
      this.lastAbortAt = null;
      this.requests = 0;
      this.aborts = 0;
    }

    get fullyIn() {
      return this.fullyInAt != null && this.state !== 'MOVING' && this.state !== 'ABORTING';
    }

    requestTarget(input) {
      if (input.left && this.laneSide !== 'left') return 'left';
      if (input.right && this.laneSide !== 'right') return 'right';
      return null;
    }

    update(dt, input, now) {
      if (this.state === 'LANE_KEEP') {
        const target = this.requestTarget(input);
        if (target) {
          this.state = 'SIGNALING';
          this.signalSide = target;
          this.signalOnAt = now;
          this.requests += 1;
        }
      } else if (this.state === 'SIGNALING') {
        if ((this.signalSide === 'left' && input.right) ||
          (this.signalSide === 'right' && input.left)) {
          this.state = 'LANE_KEEP';
          this.signalSide = null;
          this.signalOnAt = null;
          return;
        }
        if (now - this.signalOnAt >= C.SIGNAL_LEAD) {
          this.state = 'MOVING';
          this.movementStartAt = now;
          this.fromX = this.x;
          this.toX = laneCenterX(this.signalSide);
          this.progress = 0;
        }
      } else if (this.state === 'MOVING') {
        if (this.progress < C.COMMIT_PROGRESS &&
          ((this.signalSide === 'left' && input.right) ||
            (this.signalSide === 'right' && input.left))) {
          this.state = 'ABORTING';
          this.abortAt = now;
          this.abortFromX = this.x;
          this.abortFromVx = this.vx;
          this.abortElapsed = 0;
          this.abortSource = otherSide(this.signalSide);
          this.aborts += 1;
          return;
        }
        this.progress = clamp(this.progress + dt / C.LANE_CHANGE_TIME, 0, 1);
        const u = this.progress;
        this.x = lerp(this.fromX, this.toX, smooth5(u));
        this.vx = (this.toX - this.fromX) * smooth5Derivative(u) / C.LANE_CHANGE_TIME;
        if (u >= 1) {
          this.x = this.toX;
          this.vx = 0;
          this.laneSide = this.signalSide;
          this.state = 'SETTLING';
          this.settleStartAt = now;
          this.fullyInAt = now;
        }
      } else if (this.state === 'ABORTING') {
        this.abortElapsed = clamp(this.abortElapsed + dt, 0, C.ABORT_TIME);
        const u = this.abortElapsed / C.ABORT_TIME;
        this.x = this.abortFromX * (1 - 3 * u * u + 2 * u * u * u) +
          this.abortFromVx * C.ABORT_TIME * (u - 2 * u * u + u * u * u);
        this.vx = this.abortFromX * (-6 * u + 6 * u * u) / C.ABORT_TIME +
          this.abortFromVx * (1 - 4 * u + 3 * u * u);
        if (u >= 1) {
          this.state = 'LANE_KEEP';
          this.laneSide = this.abortSource;
          this.x = laneCenterX(this.laneSide);
          this.vx = 0;
          this.signalSide = null;
          this.progress = 0;
          this.lastAbortAt = now;
          this.completedAt = null;
          this.fullyInAt = null;
        }
      } else if (this.state === 'SETTLING') {
        if (now - this.settleStartAt >= C.STABLE_DWELL) {
          this.state = 'LANE_KEEP';
          this.completedAt = now;
          this.signalSide = null;
          this.progress = 1;
          this.x = this.toX;
          this.vx = 0;
        }
      }
    }
  }

  // --- Simulation ---------------------------------------------------------

  function createTruck(planEvent) {
    const spec = planEvent.truck;
    return {
      x: spec.x != null ? spec.x : spec.startX,
      s: spec.s,
      v: spec.speed || 0,
      vx: 0,
      yaw: 0,
      yawRate: 0,
      length: C.TRUCK_LENGTH,
      width: C.TRUCK_WIDTH,
      height: C.TRUCK_HEIGHT,
      signalVisible: false,
      signalSide: null,
      braking: false,
      reverseLights: false,
      lateralProgress: 0,
      phase: planEvent.template === 'rear-blind-reversing' ? 'warn' : 'cruise',
      reversed: 0,
      holdAt: null,
      turnAt: null,
      cleared: false,
      reverseCueAt: planEvent.template === 'rear-blind-reversing' ? 0 : null
    };
  }

  class Simulation {
    constructor(seed, options) {
      options = options || {};
      this.seed = seed == null ? 'large-vehicle-blind-zones' : seed;
      this.plan = options.plan || createPlan(this.seed);
      this.options = options;
      this.eventIndex = options.eventId != null ? options.eventId : 0;
      this.events = this.plan.events.map(function (planEvent) {
        return {
          id: planEvent.id,
          template: planEvent.template,
          side: planEvent.mergeSide || planEvent.passSide || 'right',
          plan: planEvent,
          active: false,
          resolved: false,
          completed: false,
          failed: false,
          failureReason: null,
          attempts: 0,
          elapsed: 0,
          completedAt: null,
          safe: false,
          observationScore: 0,
          minClearance: Infinity,
          minSideClearance: Infinity,
          minRearGap: Infinity,
          minFrontGap: Infinity,
          maxRequiredDecel: 0,
          mergeGapAtEntry: null,
          mergeBehind: false,
          cutInAndBrake: false,
          postHardBrake: false,
          acceleratedIntoLane: false,
          stopOutsideSweep: false,
          passLeftClearance: null,
          stoppedOutsideSweep: false,
          responseAt: null,
          signalSeen: false,
          speedAtSignal: null,
          signalAt: null,
          reverseCueAt: null,
          sawQueue: false,
          sawQueueAt: null,
          resumedAt: null,
          nearConflict: false,
          hardFollower: false,
          zone: 'clear',
          visibleFraction: 1,
          timeInBlind: 0,
          firstBlindAt: null,
          lastBlindAt: null,
          history: [],
          lastHistoryAt: -1
        };
      });
      this.status = 'ready';
      this.elapsed = 0;
      const first = this.plan.events[this.eventIndex] || this.plan.events[0];
      this.speed = first.player.initialSpeed * 3.6;
      this.player = {
        x: laneCenterX(first.playerLane),
        s: 0,
        v: first.player.initialSpeed,
        vx: 0,
        yaw: 0,
        length: C.PLAYER_LENGTH,
        width: C.PLAYER_WIDTH
      };
      this.prevV = this.player.v;
      this.lastDeceleration = 0;
      this.truck = null;
      this.queue = null;
      this.currentEvent = null;
      this.laneChange = new LaneChangeController(this);
      this.assessment = null;
      this.visibility = null;
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
      event.completed = false;
      event.failureReason = null;
      event.elapsed = 0;
      event.completedAt = null;
      event.safe = false;
      event.observationScore = 0;
      event.minClearance = Infinity;
      event.minSideClearance = Infinity;
      event.minRearGap = Infinity;
      event.minFrontGap = Infinity;
      event.maxRequiredDecel = 0;
      event.mergeGapAtEntry = null;
      event.mergeBehind = false;
      event.cutInAndBrake = false;
      event.postHardBrake = false;
      event.acceleratedIntoLane = false;
      event.stopOutsideSweep = false;
      event.passLeftClearance = null;
      event.stoppedOutsideSweep = false;
      event.responseAt = null;
      event.signalSeen = false;
      event.speedAtSignal = null;
      event.signalAt = plan.truck && plan.truck.signalAt != null ? plan.truck.signalAt : null;
      event.reverseCueAt = plan.template === 'rear-blind-reversing' ? 0 : null;
      event.sawQueue = false;
      event.sawQueueAt = null;
      event.resumedAt = null;
      event.nearConflict = false;
      event.hardFollower = false;
      event.zone = 'clear';
      event.visibleFraction = 1;
      event.timeInBlind = 0;
      event.firstBlindAt = null;
      event.lastBlindAt = null;
      event.history = [];
      event.lastHistoryAt = -1;
      this.currentEvent = event;
      this.truck = createTruck(plan);
      this.queue = plan.queue ? {
        x: plan.queue.x,
        s: plan.queue.s,
        v: plan.queue.speed,
        yaw: 0,
        length: 4.6,
        width: 1.9,
        braking: false
      } : null;
      this.player.x = laneCenterX(plan.playerLane);
      this.player.s = 0;
      this.player.v = plan.player.initialSpeed;
      this.player.vx = 0;
      this.player.yaw = 0;
      this.prevV = this.player.v;
      this.laneChange.reset(plan.playerLane);
      this.assessment = null;
      this.visibility = driverVisibility(this.truck, this.player);
      event.zone = this.visibility.zone;
      event.visibleFraction = this.visibility.visibleFraction;
      this.transition = 0;
      this.transitionTotal = 0;
      this.defensiveControl = null;
      this.justResolved = null;
      this.freezeInfo = null;
      this._risk = null;
      this.speed = this.player.v * 3.6;
    }

    updateTruck(dt) {
      const truck = this.truck;
      const event = this.currentEvent;
      if (!truck || !event) return;
      const plan = event.plan;
      const prevV = truck.v;
      if (plan.template === 'side-blind-merge') {
        const spec = plan.truck;
        truck.signalVisible = event.elapsed >= spec.signalAt &&
          event.elapsed < spec.lateralStart + spec.lateralDuration;
        truck.signalSide = plan.mergeSide;
        if (event.elapsed >= spec.brakeAt) {
          truck.v = moveToward(truck.v, spec.slowSpeed, 0.5 * dt);
        }
        if (event.elapsed >= spec.lateralStart) {
          const u = clamp((event.elapsed - spec.lateralStart) / spec.lateralDuration, 0, 1);
          truck.lateralProgress = u;
          truck.x = lerp(spec.startX, spec.targetX, smooth5(u));
          truck.vx = (spec.targetX - spec.startX) *
            smooth5Derivative(u) / spec.lateralDuration;
          truck.yaw = clamp(Math.atan2(truck.vx, Math.max(truck.v, 1)), -0.28, 0.28);
        } else {
          truck.x = spec.startX;
          truck.vx = 0;
          truck.yaw = 0;
          truck.lateralProgress = 0;
        }
        truck.s += truck.v * dt;
      } else if (plan.template === 'front-blind-cut-in') {
        const fullyIn = this.laneChange.fullyIn && this.laneChange.laneSide === plan.mergeSide;
        const playerAhead = this.player.s < truck.s;
        if (fullyIn && playerAhead) {
          const gap = (this.player.s - this.player.length / 2) -
            (truck.s + truck.length / 2);
          const closing = truck.v - this.player.v;
          let required = 0;
          if (gap > 0 && closing > 0) {
            required = closing * closing / (2 * Math.max(gap - C.GAP_BUFFER, 0.3));
          }
          event.maxRequiredDecel = Math.max(event.maxRequiredDecel, required);
          event.minFrontGap = Math.min(event.minFrontGap, gap);
          if (required > C.FOLLOW_HARD_DECEL) event.hardFollower = true;
          const decel = required > 0.1
            ? clamp(required + 0.35, 1.5, C.FOLLOW_HARD_DECEL)
            : 0.4;
          truck.v = moveToward(truck.v, this.player.v, decel * dt);
          if (gap < 0.6) event.nearConflict = true;
        } else {
          truck.v = moveToward(truck.v, C.B_TRUCK_SPEED, 0.4 * dt);
        }
        truck.s += truck.v * dt;
      } else {
        const spec = plan.truck;
        if (truck.phase === 'warn' && event.elapsed >= spec.reverseStartAt) {
          truck.phase = 'reversing';
        }
        if (truck.phase === 'reversing') {
          truck.v = -spec.reverseSpeed;
          truck.s += truck.v * dt;
          truck.reversed += spec.reverseSpeed * dt;
          truck.reverseLights = true;
          if (truck.reversed >= spec.reverseDistance) {
            truck.phase = 'hold';
            truck.holdAt = event.elapsed;
            truck.v = 0;
          }
        } else if (truck.phase === 'hold') {
          truck.v = 0;
          truck.reverseLights = true;
          if (event.elapsed - truck.holdAt >= 1.0) {
            truck.phase = 'turning';
            truck.turnAt = event.elapsed;
          }
        } else if (truck.phase === 'turning') {
          const u = clamp((event.elapsed - truck.turnAt) / spec.turnTime, 0, 1);
          truck.x = lerp(spec.x, spec.bayX, smooth5(u));
          truck.yaw = (PI / 2) * smooth5(u);
          truck.vx = (spec.bayX - spec.x) * smooth5Derivative(u) / spec.turnTime;
          truck.yawRate = (PI / 2) * smooth5Derivative(u) / spec.turnTime;
          truck.reverseLights = false;
          const rearX = truck.x - Math.sin(truck.yaw) * truck.length / 2;
          if (rearX > 4.5) truck.cleared = true;
          if (u >= 1) {
            truck.phase = 'done';
            truck.cleared = true;
            truck.vx = 0;
            truck.yawRate = 0;
          }
        } else if (truck.phase === 'warn') {
          truck.v = 0;
          truck.reverseLights = true;
        }
        if (truck.phase === 'done') {
          truck.v = 0;
          truck.vx = 0;
          truck.yawRate = 0;
          truck.reverseLights = false;
        }
      }
      truck.braking = truck.v < prevV - 1e-6;
      if (event.elapsed - event.lastHistoryAt >= 0.12) {
        event.history.push({ s: truck.s, x: truck.x, yaw: truck.yaw });
        event.lastHistoryAt = event.elapsed;
      }
    }

    updateQueue(dt) {
      if (!this.queue) return;
      const event = this.currentEvent;
      const prev = this.queue.v;
      if (event && event.plan.queue && event.elapsed >= event.plan.queue.brakeAt) {
        this.queue.v = moveToward(this.queue.v, 0, 1.3 * dt);
      }
      this.queue.s += this.queue.v * dt;
      this.queue.braking = this.queue.v < prev - 1e-6;
    }

    updatePlayerPose() {
      const pose = this.laneChange;
      this.player.x = pose.x;
      this.player.vx = pose.vx;
      this.player.yaw = pose.y || (pose.vx !== 0
        ? clamp(Math.atan2(pose.vx, Math.max(this.player.v, 1)), -0.38, 0.38)
        : 0);
    }

    updateExposure(dt) {
      const event = this.currentEvent;
      if (!event) return;
      const visibility = driverVisibility(this.truck, this.player);
      this.visibility = visibility;
      event.visibleFraction = visibility.visibleFraction;
      event.zone = visibility.zone;
      const inBlind = visibility.zone === 'front' || visibility.zone === 'rear' ||
        visibility.zone === 'left' || visibility.zone === 'right';
      if (inBlind) {
        event.timeInBlind += dt;
        if (event.firstBlindAt == null) event.firstBlindAt = event.elapsed;
        event.lastBlindAt = event.elapsed;
      }
    }

    assess() {
      const event = this.currentEvent;
      const player = this.player;
      const truck = this.truck;
      if (!event || !truck) {
        return { gapAhead: Infinity, gapBehind: Infinity, requiredDecel: 0, fullyIn: false };
      }
      const playerFront = player.s + player.length / 2;
      const playerRear = player.s - player.length / 2;
      const truckFront = truck.s + truck.length / 2;
      const truckRear = truck.s - truck.length / 2;
      const gapAhead = playerRear - truckFront;
      const gapBehind = truckRear - playerFront;
      const closing = truck.v - player.v;
      let requiredDecel = 0;
      if (gapAhead > 0 && closing > 0) {
        requiredDecel = closing * closing / (2 * Math.max(gapAhead - C.GAP_BUFFER, 0.3));
      }
      const fullyIn = this.laneChange.fullyIn &&
        this.laneChange.laneSide === (event.plan.mergeSide || event.plan.playerLane);
      const closureRemaining = event.plan.closure
        ? event.plan.closure.lineS - playerFront
        : Infinity;
      const stopS = event.plan.template === 'rear-blind-reversing'
        ? truck.s - truck.length / 2 - C.C_STOP_CLEARANCE
        : Infinity;
      const leftClearance = (truck.x - truck.width / 2) -
        (player.x + player.width / 2);
      return {
        playerFront: playerFront,
        playerRear: playerRear,
        truckFront: truckFront,
        truckRear: truckRear,
        gapAhead: gapAhead,
        gapBehind: gapBehind,
        requiredDecel: requiredDecel,
        fullyIn: fullyIn,
        closureRemaining: closureRemaining,
        stopS: stopS,
        leftClearance: leftClearance,
        sideClearance: obbClearance(player, truck)
      };
    }

    recordState(input) {
      const event = this.currentEvent;
      const a = this.assessment;
      if (!event || !a) return;
      if (event.template === 'side-blind-merge') {
        event.minSideClearance = Math.min(event.minSideClearance, a.sideClearance);
        if (event.signalAt != null && !event.signalSeen && event.elapsed >= event.signalAt) {
          event.signalSeen = true;
          event.speedAtSignal = this.player.v;
        }
        if (event.signalSeen && event.responseAt == null) {
          if ((input.brake || input.throttle) && Math.abs(this.player.v - event.speedAtSignal) > 0.6) {
            event.responseAt = event.elapsed;
          }
        }
        if (event.signalSeen && this.player.v - event.speedAtSignal > 0.7 &&
          this.truck.lateralProgress > 0.05) {
          event.acceleratedIntoLane = true;
        }
        if (this.truck.lateralProgress >= 0.15 && this.truck.lateralProgress <= 0.9) {
          if (a.playerFront < a.truckRear - 3 || a.playerFront > a.truckFront + 3) {
            event.safePosition = true;
          }
        }
        if (this.truck.lateralProgress > 0.1 && a.sideClearance < 0.55) {
          event.nearConflict = true;
        }
      } else if (event.template === 'front-blind-cut-in') {
        event.maxRequiredDecel = Math.max(event.maxRequiredDecel, a.requiredDecel);
        if (a.fullyIn && event.mergeGapAtEntry == null) {
          event.mergeGapAtEntry = a.gapAhead;
          event.mergeBehind = a.gapAhead <= 0 && a.gapBehind >= 4;
          event.mergedAt = event.elapsed;
        }
        if (a.fullyIn && event.mergeGapAtEntry != null) {
          event.minFrontGap = Math.min(event.minFrontGap, a.gapAhead);
        }
        if (this.queue) {
          const queueVisible = this.queue.s > this.player.s - 5 &&
            this.queue.s - this.player.s < 70;
          if (queueVisible && this.queue.braking) {
            event.sawQueue = true;
            if (event.sawQueueAt == null) event.sawQueueAt = event.elapsed;
          }
        }
        if (event.mergedAt != null && event.elapsed - event.mergedAt < 2.2) {
          if (event.mergeGapAtEntry < C.FRONT_VISIBLE_GAP &&
            this.lastDeceleration >= 2.0) {
            event.cutInAndBrake = true;
          }
        }
      } else {
        event.minRearGap = Math.min(event.minRearGap, Math.max(0, a.gapBehind));
        if (event.reverseCueAt == null) event.reverseCueAt = 0;
        if (event.responseAt == null && event.elapsed >= 0.2 && input.brake) {
          event.responseAt = event.elapsed;
        }
        if (a.playerFront <= a.stopS + 1.2 && this.player.v < 0.4) {
          event.stopOutsideSweep = true;
        }
        if (this.player.x < -0.9 && this.truck.phase !== 'done') {
          const clearance = a.leftClearance;
          event.passLeftClearance = event.passLeftClearance == null
            ? clearance
            : Math.min(event.passLeftClearance, clearance);
        }
        if (event.passLeftClearance != null &&
          event.passLeftClearance < C.C_PASS_CLEARANCE) {
          event.nearConflict = true;
        }
        if (a.sideClearance < 0.6 && this.truck.phase !== 'done') {
          event.nearConflict = true;
        }
      }
      event.minClearance = Math.min(event.minClearance, a.sideClearance);
    }

    predictiveCollision(input) {
      const truck = this.truck;
      const event = this.currentEvent;
      if (!truck || !event) return { collide: false, clearance: Infinity };
      let accel = -C.NATURAL_DECELERATION;
      if (input.brake) accel = -C.BRAKE_DECELERATION;
      else if (input.throttle) accel = C.ACCELERATION;
      const dt = C.PREDICTION_STEP;
      let minClearance = Infinity;
      let minGap = Infinity;
      let px = this.player.x;
      let ps = this.player.s;
      let v = this.player.v;
      let tx = truck.x;
      let ts = truck.s;
      let tyaw = truck.yaw;
      let tv = truck.v;
      let tvx = truck.vx;
      let tyawRate = truck.yawRate;
      for (let time = 0; time <= C.IMMEDIATE_HORIZON; time += dt) {
        const playerBox = {
          x: px,
          s: ps,
          yaw: this.player.yaw,
          length: this.player.length,
          width: this.player.width
        };
        const truckBox = {
          x: tx,
          s: ts,
          yaw: tyaw,
          length: truck.length,
          width: truck.width
        };
        const clearance = obbClearance(playerBox, truckBox);
        minClearance = Math.min(minClearance, clearance);
        const gap = Math.abs(ps - ts) - (this.player.length + truck.length) / 2;
        minGap = Math.min(minGap, gap);
        if (minClearance <= 0) break;
        px += this.player.vx * dt;
        ps += v * dt;
        v = clamp(v + accel * dt, 0, C.MAX_SPEED / 3.6);
        tx += tvx * dt;
        ts += tv * dt;
        tyaw += tyawRate * dt;
      }
      return { collide: minClearance <= 0.02, clearance: minClearance, gap: minGap };
    }

    playerSpeedStep(input, dt, risk) {
      let accel = -C.NATURAL_DECELERATION;
      if (input.brake) {
        accel = -(risk && risk.collide ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);
      } else if (input.throttle) {
        accel = C.ACCELERATION;
      }
      this.player.v = clamp(this.player.v + accel * dt, 0, C.MAX_SPEED / 3.6);
      this.player.s += this.player.v * dt;
      this.player.vx = this.laneChange.vx;
      this.player.yaw = this.player.vx !== 0
        ? clamp(Math.atan2(this.player.vx, Math.max(this.player.v, 1)), -0.38, 0.38)
        : 0;
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
          if (this.currentEvent) this.currentEvent.postHardBrake = true;
        }
      } else if (decel < 1.0) {
        state.hardBrakeLatch = false;
      }
      this.lastDeceleration = Math.max(0, decel);
      this.prevV = this.player.v;

      const event = this.currentEvent;
      if (!event || event.resolved) return;
      const a = this.assessment;
      let exempt = false;
      if (event.template === 'side-blind-merge') {
        exempt = this.truck.lateralProgress > 0 && this.truck.lateralProgress < 1 &&
          this.player.v < this.truck.v - 0.5;
      } else if (event.template === 'front-blind-cut-in') {
        exempt = !this.laneChange.fullyIn && a && a.gapAhead < C.FRONT_VISIBLE_GAP;
      } else {
        exempt = !this.truck.cleared && this.player.v < 6;
      }
      if (!exempt) {
        state.efficiencyTime += dt;
        const kmh = this.player.v * 3.6;
        if (kmh >= C.CRUISE_MIN_KMH && kmh <= C.CRUISE_MAX_KMH) {
          state.efficiencyIntegral += dt;
        }
      }
    }

    finishEventScoring(event) {
      let score = 0;
      if (event.template === 'side-blind-merge') {
        if (event.responseAt != null && event.responseAt - event.plan.truck.signalAt <= 1.0) score += 3;
        if (event.safePosition) score += 3;
        if (event.completed && !event.acceleratedIntoLane && !event.postHardBrake && !event.failed) score += 4;
      } else if (event.template === 'front-blind-cut-in') {
        const safeGap = event.mergeGapAtEntry != null &&
          (event.mergeGapAtEntry >= C.FRONT_VISIBLE_GAP || event.mergeBehind);
        if (safeGap) score += 3;
        if (event.sawQueue && !event.cutInAndBrake) score += 3;
        if (event.completed && event.maxRequiredDecel <= C.FOLLOW_COMFORT_DECEL + 0.15 &&
          !event.postHardBrake && !event.failed) score += 4;
      } else {
        if (event.responseAt != null && event.responseAt <= 1.5) score += 3;
        if (event.stopOutsideSweep || (event.passLeftClearance != null &&
          event.passLeftClearance >= C.C_PASS_CLEARANCE)) score += 3;
        if (event.completed && !event.postHardBrake && !event.nearConflict && !event.failed) score += 4;
      }
      event.observationScore = clamp(Math.round(score), 0, 10);
      if (event.template === 'side-blind-merge') {
        event.safe = Boolean(event.resolved && !event.failed && !event.nearConflict);
      } else if (event.template === 'front-blind-cut-in') {
        event.safe = Boolean(event.resolved && !event.failed && !event.hardFollower &&
          event.maxRequiredDecel <= C.FOLLOW_HARD_DECEL &&
          (event.mergeGapAtEntry == null || event.mergeGapAtEntry >= 4 || event.mergeBehind));
      } else {
        event.safe = Boolean(event.resolved && !event.failed && !event.nearConflict &&
          (event.stopOutsideSweep || (event.passLeftClearance != null &&
            event.passLeftClearance >= C.C_PASS_CLEARANCE)));
      }
    }

    resolveEvent() {
      const event = this.currentEvent;
      event.resolved = true;
      event.completed = true;
      event.completedAt = event.elapsed;
      this.finishEventScoring(event);
      this.justResolved = event;
      this.transition = C.SEGMENT_TRANSITION;
      this.transitionTotal = C.SEGMENT_TRANSITION;
      this.scoring.dithering += Math.max(0, this.laneChange.requests - 2);
      this.scoring.lateAborts += this.laneChange.aborts;
    }

    freeze(reason, detail) {
      const event = this.currentEvent;
      if (!event) return;
      event.failed = true;
      event.failureReason = reason;
      this.status = 'frozen';
      this.justResolved = null;
      this.scoring.firstFailure = true;
      const a = this.assessment;
      this.freezeInfo = {
        eventId: event.id,
        reason: reason,
        side: event.side,
        speed: this.player.v * 3.6,
        gap: detail && detail.gap != null ? detail.gap : (a ? a.gapAhead : 0),
        clearance: detail && detail.clearance != null ? detail.clearance : (a ? a.sideClearance : 0),
        decel: detail && detail.decel != null ? detail.decel : (a ? a.requiredDecel : 0),
        closure: a ? a.closureRemaining : 0,
        zone: this.visibility ? this.visibility.zone : 'clear'
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

      this.laneChange.update(dt, input, this.elapsed);
      this.player.x = this.laneChange.x;
      this.player.vx = this.laneChange.vx;
      this.player.yaw = this.player.vx !== 0
        ? clamp(Math.atan2(this.player.vx, Math.max(this.player.v, 1)), -0.38, 0.38)
        : 0;
      this.updateTruck(dt);
      this.updateQueue(dt);
      this.assessment = this.assess();
      this.recordState(input);
      this.updateExposure(dt);

      if (event.hardFollower) {
        this.freeze('frontRearEnd', { gap: this.assessment.gapAhead, decel: event.maxRequiredDecel });
        return;
      }
      const risk = this.predictiveCollision(input);
      this._risk = risk;
      if (risk.collide && this.assessment.sideClearance > 0.02) {
        const reason = event.template === 'side-blind-merge' ? 'sideSqueeze'
          : (event.template === 'front-blind-cut-in' ? 'frontRearEnd' : 'rearBackover');
        this.freeze(reason, { gap: risk.gap, clearance: risk.clearance });
        return;
      }
      if (this.assessment.sideClearance <= 0.02) {
        const reason = event.template === 'side-blind-merge' ? 'sideSqueeze'
          : (event.template === 'front-blind-cut-in' ? 'frontRearEnd' : 'rearBackover');
        this.freeze(reason, { gap: 0, clearance: 0 });
        return;
      }
      if (event.plan.closure &&
        this.assessment.playerFront >= event.plan.closure.lineS &&
        !this.laneChange.fullyIn) {
        this.freeze('frontClosure', { gap: event.plan.closure.lineS - this.assessment.playerFront });
        return;
      }

      this.playerSpeedStep(input, dt, risk);
      this.updateScoring(dt);

      if (!event.resolved) {
        if (event.template === 'side-blind-merge') {
          const spec = event.plan.truck;
          if (this.truck.lateralProgress >= 1 &&
            event.elapsed >= spec.lateralStart + spec.lateralDuration + 0.6) {
            this.resolveEvent();
            return;
          }
        } else if (event.template === 'front-blind-cut-in') {
          if (this.laneChange.fullyInAt != null &&
            this.elapsed - this.laneChange.fullyInAt >= 2.5) {
            this.resolveEvent();
            return;
          }
        } else {
          const passed = this.player.s > this.truck.s + 8;
          if (passed && (this.truck.cleared || this.laneChange.laneSide === event.plan.passSide)) {
            this.resolveEvent();
            return;
          }
        }
      }

      if (this.elapsed >= C.MAX_TIME) {
        this.status = 'timeout';
        this.currentEvent = null;
      }
    }

    stepDemo(dt) {
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
      this.demo.demoView = 'my';
      this.demoMode = 'driver';
      this.status = 'demonstrating';
    }

    finishReplay() {
      this.demo = null;
      this.demoMode = null;
      this.retryEvent();
    }

    retryEvent() {
      this.demo = null;
      this.demoMode = null;
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
  }

  // --- Defensive policy ---------------------------------------------------

  function defensiveInput(sim) {
    const input = { left: false, right: false, throttle: false, brake: false };
    if (!sim || sim.status !== 'driving') return input;
    const event = sim.currentEvent;
    if (!event || event.resolved || sim.transition > 0) return input;

    if (event.template === 'side-blind-merge') {
      if (!event.signalSeen || event.elapsed < event.plan.truck.signalAt) {
        input.throttle = sim.player.v < event.plan.player.initialSpeed + 0.1;
        return input;
      }
      if (event.elapsed < event.plan.truck.signalAt + 1.2) {
        input.brake = true;
        return input;
      }
      const a = sim.assessment;
      if (!a) return input;
      if (a.playerFront > a.truckRear - 3.2) {
        input.brake = sim.player.v > 0.6;
      } else {
        const gap = a.truckRear - a.playerFront;
        if (gap > 9 && sim.player.v < sim.truck.v + 0.4) input.throttle = true;
        if (gap < 6) input.brake = true;
      }
      return input;
    }

    if (event.template === 'front-blind-cut-in') {
      const a = sim.assessment;
      if (!a) return input;
      if (!sim.laneChange.fullyIn) {
        if (a.gapAhead >= 13) {
          input.right = true;
          input.throttle = true;
        } else {
          input.throttle = sim.player.v < 15.0;
        }
        return input;
      }
      if (sim.player.v > 9.6) input.brake = true;
      else if (sim.player.v < 8.0) input.throttle = true;
      return input;
    }

    const a = sim.assessment;
    if (!a) return input;
    if (sim.truck.phase === 'done' || sim.truck.cleared) {
      input.throttle = sim.player.v < 12.0;
      return input;
    }
    const remaining = a.stopS - a.playerFront;
    if (remaining <= 1.5) {
      input.brake = sim.player.v > 0.2;
      return input;
    }
    const desired = Math.min(12.0, Math.sqrt(2 * 1.2 * remaining));
    if (sim.player.v > desired + 0.4) input.brake = true;
    else if (sim.player.v < desired - 0.4) input.throttle = true;
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
      let summaryKey = 'scene.largeVehicle.result.summary.c';
      if (total >= 85 && !timedOut) {
        grade = 'A';
        titleKey = 'result.title.a';
        summaryKey = 'scene.largeVehicle.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'scene.largeVehicle.result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'scene.largeVehicle.result.summary.timeout';
      }

      let adviceKey = 'scene.largeVehicle.result.advice.default';
      if (failed) adviceKey = 'scene.largeVehicle.result.advice.failed';
      else if (observation < 28) adviceKey = 'scene.largeVehicle.result.advice.observation';
      else if (state.hardBrakes > 0) adviceKey = 'scene.largeVehicle.result.advice.smooth';
      else if (timedOut || efficiency < 12) adviceKey = 'scene.largeVehicle.result.advice.efficiency';

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

  function screenX(simulation, worldX) {
    return C.ROAD_CENTER + (worldX || 0) * C.X_PIXELS_PER_METER;
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
    if (!event || !event.plan.closure) return;
    const plan = event.plan.closure;
    const closureY = worldY(simulation, plan.lineS);
    const endY = worldY(simulation, plan.lineS + 60);
    if (endY < C.HEIGHT + 20 && closureY > -40) {
      const top = Math.max(-40, closureY);
      const bottom = Math.min(C.HEIGHT + 40, endY);
      if (bottom > top) {
        ctx.save();
        Draw.rect(ctx, '#2d2f2c', 80, top, 98, bottom - top);
        ctx.globalAlpha = 0.35;
        for (let stripe = top - 80; stripe < bottom + 80; stripe += 20) {
          ctx.fillStyle = '#e0b34f';
          ctx.beginPath();
          ctx.moveTo(80, stripe);
          ctx.lineTo(92, stripe);
          ctx.lineTo(178, stripe + 58);
          ctx.lineTo(178, stripe + 70);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        Draw.rect(ctx, '#4a3a22', 80, top, 98, 4);
        for (let i = -2; i <= 2; i += 1) {
          const coneY = worldY(simulation, plan.lineS + 1.2 + i * 1.6);
          if (coneY > 90 && coneY < C.HEIGHT) {
            Draw.rect(ctx, '#d76b35', 125 + i * 20 - 5, coneY - 4, 10, 10);
            Draw.rect(ctx, '#f7e6c4', 125 + i * 20 - 5, coneY, 10, 3);
          }
        }
      }
    }

    const warnY = worldY(simulation, plan.warningS);
    if (warnY > -30 && warnY < C.HEIGHT + 30) {
      Draw.rect(ctx, '#263c3d', 300, warnY, 4, 24);
      Draw.rect(ctx, '#d9cf9b', 286, warnY - 16, 32, 18);
      Draw.rect(ctx, '#4a6862', 289, warnY - 13, 26, 12);
      Draw.fillFittedText(ctx, t('scene.largeVehicle.canvas.closedAhead'), 291, warnY - 4, 22, 7, 'monospace');
    }

    const arrowY = worldY(simulation, plan.arrowS);
    if (arrowY > -30 && arrowY < C.HEIGHT + 30) {
      Draw.rect(ctx, '#263c3d', 128, arrowY, 4, 26);
      Draw.rect(ctx, '#22343a', 110, arrowY - 16, 40, 18);
      Draw.rect(ctx, '#ffd166', 113, arrowY - 13, 34, 12);
      Draw.fillFittedText(ctx, '▶▶', 116, arrowY - 4, 28, 9, 'monospace');
    }
  }

  function drawBay(ctx, simulation) {
    const event = simulation.currentEvent ||
      simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    if (!event || !event.plan.bay) return;
    const bayS = event.plan.bay.s;
    const y = worldY(simulation, bayS);
    if (y < -80 || y > C.HEIGHT + 80) return;
    Draw.rect(ctx, '#5f6a60', 280, y - 34, 70, 72);
    Draw.rect(ctx, '#46524c', 280, y - 28, 66, 60);
    Draw.rect(ctx, '#6f7a6c', 282, y - 26, 8, 56);
    Draw.rect(ctx, '#d9cf9b', 300, y - 12, 34, 18);
    Draw.fillFittedText(ctx, t('scene.largeVehicle.canvas.loadingBay'), 302, y, 30, 7, 'monospace');
  }

  function drawVehicle(ctx, simulation, vehicle, color, options) {
    options = options || {};
    if (!vehicle) return;
    const x = screenX(simulation, vehicle.x || 0);
    const y = worldY(simulation, vehicle.s);
    if (y < -80 || y > C.HEIGHT + 80) return;
    const width = options.player ? 30 : 32;
    const length = options.player ? 46 : 48;
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
    if (vehicle.reverseLights) {
      const blink = Math.floor((simulation.elapsed || 0) * 4) % 2 === 0;
      Draw.rect(ctx, blink ? '#f7f5df' : '#a9b7a8', -width / 2 + 3, length / 2 - 3, 6, 3);
      Draw.rect(ctx, blink ? '#f7f5df' : '#a9b7a8', width / 2 - 9, length / 2 - 3, 6, 3);
    }
    ctx.restore();
  }

  function drawTruck(ctx, simulation, truck, demo) {
    if (!truck) return;
    const x = screenX(simulation, truck.x);
    const y = worldY(simulation, truck.s);
    if (y < -110 || y > C.HEIGHT + 110) return;
    const width = 42;
    const length = 76;
    const cab = length * (C.TRUCK_CAB_LENGTH / C.TRUCK_LENGTH);
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(truck.yaw || 0);
    Draw.rect(ctx, '#10212a77', -width / 2 + 4, -length / 2 + 6, width, length);
    for (let i = 0; i < 3; i += 1) {
      Draw.rect(ctx, '#14232b', -width / 2 - 3, -length / 2 + 10 + i * 20, 4, 12);
      Draw.rect(ctx, '#14232b', width / 2 - 1, -length / 2 + 10 + i * 20, 4, 12);
    }
    Draw.rect(ctx, demo ? '#d9e4c1' : '#d8d3b8', -width / 2, -length / 2, width, length);
    Draw.rect(ctx, '#b9b79f', -width / 2 + 2, -length / 2 + 2, width - 4, length * 0.62);
    for (let rib = 0; rib < 4; rib += 1) {
      Draw.rect(ctx, '#8f9482', -width / 2 + 2, -length / 2 + 6 + rib * 12, width - 4, 2);
    }
    Draw.rect(ctx, '#e7dfc0', -width / 2 + 2, -length / 2 + cab + 4, width - 4, 5);
    Draw.rect(ctx, demo ? '#7fa6b2' : '#c7a85b', -width / 2, length / 2 - cab, width, cab);
    Draw.rect(ctx, '#294651', -width / 2 + 4, length / 2 - cab + 3, width - 8, cab * 0.55);
    Draw.rect(ctx, '#80b9c1', -width / 2 + 6, length / 2 - cab + 4, width - 12, 3);
    Draw.rect(ctx, '#fff2bd', -width / 2 + 3, -length / 2, 6, 4);
    Draw.rect(ctx, '#fff2bd', width / 2 - 9, -length / 2, 6, 4);
    Draw.rect(ctx, '#a83b3f', -width / 2 + 3, length / 2 - 4, 7, 4);
    Draw.rect(ctx, '#a83b3f', width / 2 - 10, length / 2 - 4, 7, 4);
    if (truck.signalVisible) {
      const left = truck.signalSide === 'left';
      const blink = Math.floor((simulation.elapsed || 0) * 3) % 2 === 0;
      if (blink) {
        const sx = left ? -width / 2 + 2 : width / 2 - 8;
        Draw.rect(ctx, '#ffd166', sx, -length / 2 + 5, 6, 6);
        Draw.rect(ctx, '#ffd166', sx, length / 2 - 11, 6, 6);
      }
    }
    if (truck.reverseLights) {
      const blink = Math.floor((simulation.elapsed || 0) * 4) % 2 === 0;
      Draw.rect(ctx, blink ? '#f7f5df' : '#a9b7a8', -width / 2 + 4, length / 2 - 3, 8, 4);
      Draw.rect(ctx, blink ? '#f7f5df' : '#a9b7a8', width / 2 - 12, length / 2 - 3, 8, 4);
      if (blink) {
        ctx.globalAlpha = 0.35;
        Draw.rect(ctx, '#f7f5df', -width / 2 - 5, length / 2 - 8, width + 10, 14);
      }
    }
    ctx.restore();
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
      signalVisible: Boolean(event) &&
        (laneChange.state === 'SIGNALING' || laneChange.state === 'MOVING'),
      signalSide: laneChange.signalSide,
      braking: false
    };
    drawVehicle(ctx, simulation, vehicle, demo ? '#65d6a1' : '#e7685b', { player: true });
  }

  function drawQueue(ctx, simulation) {
    const queue = simulation.queue;
    if (!queue) return;
    drawVehicle(ctx, simulation, queue, '#8fc7c2', {});
  }

  function drawFreeze(ctx, simulation) {
    const info = simulation.freezeInfo;
    if (!info) return;
    ctx.save();
    ctx.fillStyle = 'rgba(8, 18, 25, 0.45)';
    ctx.fillRect(0, 0, C.WIDTH, C.HEIGHT);
    if (simulation.truck) {
      const p = { x: screenX(simulation, simulation.player.x), y: worldY(simulation, simulation.player.s) };
      const tr = { x: screenX(simulation, simulation.truck.x), y: worldY(simulation, simulation.truck.s) };
      ctx.strokeStyle = '#ff7a66';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff665c';
      ctx.beginPath();
      ctx.arc((p.x + tr.x) / 2, (p.y + tr.y) / 2, 5, 0, PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#0d2029dd';
    ctx.fillRect(70, 250, 220, 76);
    ctx.fillStyle = '#ffd166';
    ctx.font = '900 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(t('scene.largeVehicle.failure.overlay'), C.WIDTH / 2, 276);
    ctx.fillStyle = '#e9f1e8';
    ctx.font = '700 10px ui-monospace, monospace';
    ctx.fillText(t('scene.largeVehicle.failure.overlaySub'), C.WIDTH / 2, 298);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  function truckLocalPolygon(truck, points) {
    return points.map(function (point) {
      return truckWorld(truck, point);
    });
  }

  function fillWorldPolygon(ctx, simulation, points, fill, stroke) {
    ctx.beginPath();
    points.forEach(function (point, index) {
      const x = screenX(simulation, point.x);
      const y = worldY(simulation, point.s);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  function drawTruckView(ctx, simulation, truck) {
    const L = truck.length;
    const W = truck.width;
    const geo = truckGeometry(truck);
    ctx.save();
    ctx.fillStyle = 'rgba(8, 18, 25, 0.35)';
    ctx.fillRect(0, 0, C.WIDTH, C.HEIGHT);
    ctx.lineWidth = 1;

    // Front, rear and side blind zones in the truck's own frame.
    fillWorldPolygon(ctx, simulation, truckLocalPolygon(truck, [
      { x: -1.6, s: L / 2 }, { x: 1.6, s: L / 2 },
      { x: 1.6, s: L / 2 + C.FRONT_BLIND_DISTANCE }, { x: -1.6, s: L / 2 + C.FRONT_BLIND_DISTANCE }
    ]), 'rgba(255, 102, 92, 0.20)', 'rgba(255, 102, 92, 0.62)');
    fillWorldPolygon(ctx, simulation, truckLocalPolygon(truck, [
      { x: -1.6, s: -L / 2 - C.REAR_BLIND_DISTANCE }, { x: 1.6, s: -L / 2 - C.REAR_BLIND_DISTANCE },
      { x: 1.6, s: -L / 2 }, { x: -1.6, s: -L / 2 }
    ]), 'rgba(255, 102, 92, 0.20)', 'rgba(255, 102, 92, 0.62)');
    fillWorldPolygon(ctx, simulation, truckLocalPolygon(truck, [
      { x: -C.SIDE_BLIND_MAX, s: -L / 2 }, { x: -W / 2, s: -L / 2 },
      { x: -W / 2, s: L / 2 }, { x: -C.SIDE_BLIND_MAX, s: L / 2 }
    ]), 'rgba(255, 209, 102, 0.17)', 'rgba(255, 209, 102, 0.55)');
    fillWorldPolygon(ctx, simulation, truckLocalPolygon(truck, [
      { x: W / 2, s: -L / 2 }, { x: C.SIDE_BLIND_MAX, s: -L / 2 },
      { x: C.SIDE_BLIND_MAX, s: L / 2 }, { x: W / 2, s: L / 2 }
    ]), 'rgba(255, 209, 102, 0.17)', 'rgba(255, 209, 102, 0.55)');

    // Direct view fan.
    const direct = [];
    direct.push({ x: geo.eye.x, s: geo.eye.s });
    for (let a = -C.DIRECT_HALF_ANGLE; a <= C.DIRECT_HALF_ANGLE + 0.001; a += C.DIRECT_HALF_ANGLE / 5) {
      direct.push({
        x: geo.eye.x + Math.sin(a) * 34,
        s: geo.eye.s + Math.cos(a) * 34
      });
    }
    fillWorldPolygon(ctx, simulation, truckLocalPolygon(truck, direct),
      'rgba(128, 224, 177, 0.10)', 'rgba(128, 224, 177, 0.35)');

    // Mirror sectors use the same angular limits as the visibility model.
    geo.mirrors.forEach(function (mirror) {
      const length = Math.sqrt(mirror.dirX * mirror.dirX + mirror.dirS * mirror.dirS);
      const dirX = mirror.dirX / length;
      const dirS = mirror.dirS / length;
      [C.MIRROR_MAIN_HALF_ANGLE, C.MIRROR_WIDE_HALF_ANGLE].forEach(function (half, index) {
        const points = [{
          x: mirror.x,
          s: mirror.s
        }];
        for (let a = -half; a <= half + 0.001; a += half / 3) {
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          points.push({
            x: mirror.x + (dirX * cos - dirS * sin) * 32,
            s: mirror.s + (dirX * sin + dirS * cos) * 32
          });
        }
        fillWorldPolygon(ctx, simulation, truckLocalPolygon(truck, points),
          index === 0 ? 'rgba(127, 209, 237, 0.13)' : 'rgba(127, 209, 237, 0.07)',
          'rgba(127, 209, 237, 0.34)');
      });
    });

    // The eye and the player's visibility state.
    const eye = truckWorld(truck, geo.eye);
    ctx.fillStyle = '#f7f5df';
    ctx.beginPath();
    ctx.arc(screenX(simulation, eye.x), worldY(simulation, eye.s), 4, 0, PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#14232b';
    ctx.stroke();

    if (!simulation.visibility || !simulation.visibility.visible) {
      const corners = boxCorners(simulation.player);
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      corners.forEach(function (corner, index) {
        const x = screenX(simulation, corner.x);
        const y = worldY(simulation, corner.s);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = '#f7f5df';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (simulation.visibility) {
      ctx.fillStyle = '#0d2029dd';
      ctx.fillRect(58, 58, 244, 32);
      ctx.fillStyle = '#e9f1e8';
      ctx.font = '800 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(t('scene.largeVehicle.view.caption', {
        zone: t(zoneKey(simulation.visibility.zone))
      }), 180, 78);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  function drawCanvasHud(ctx, simulation, demo) {
    const event = simulation.currentEvent;
    const resolved = simulation.events.filter(function (e) { return e.resolved; }).length;
    ctx.save();
    ctx.fillStyle = 'rgba(13, 32, 41, 0.82)';
    ctx.fillRect(10, 10, 112, 24);
    ctx.fillStyle = '#b8cec4';
    ctx.font = '800 9px ui-monospace, monospace';
    ctx.fillText(t('scene.largeVehicle.hud.progress', { resolved: resolved }), 18, 26);
    for (let i = 0; i < simulation.events.length; i += 1) {
      ctx.fillStyle = simulation.events[i].resolved ? '#80e0b1' : '#3f625a';
      ctx.fillRect(296 + i * 16, 18, 10, 8);
    }
    if (demo) {
      ctx.fillStyle = 'rgba(13, 32, 41, 0.82)';
      ctx.fillRect(252, 10, 96, 24);
      ctx.fillStyle = '#ffd166';
      ctx.font = '800 8px ui-monospace, monospace';
      ctx.fillText(t('scene.largeVehicle.demo.badge'), 260, 26);
    }
    ctx.restore();
  }

  function renderScene(ctx, simulation, demo) {
    drawRoad(ctx, simulation);
    drawClosure(ctx, simulation);
    drawBay(ctx, simulation);
    drawQueue(ctx, simulation);
    drawTruck(ctx, simulation, simulation.truck, demo);
    drawPlayer(ctx, simulation, demo);
    if (demo && simulation.demoView === 'truck' && simulation.truck) {
      drawTruckView(ctx, simulation, simulation.truck);
    }
    drawCanvasHud(ctx, simulation, demo);
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        renderScene(ctx, simulation.demo, true);
      } else {
        renderScene(ctx, simulation, false);
        if (simulation.status === 'frozen' && simulation.freezeInfo) {
          drawFreeze(ctx, simulation);
        }
      }
    },
    screenX: screenX,
    worldY: worldY
  };

  // --- Scene pack ---------------------------------------------------------

  const Scene = {
    id: 'large-vehicle-blind-zones',
    Constants: C,
    Plan: { createPlan: createPlan },
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    LaneChangeController: LaneChangeController,
    Geometry: {
      boxCorners: boxCorners,
      obbIntersects: obbIntersects,
      obbClearance: obbClearance,
      truckLocal: truckLocal,
      truckWorld: truckWorld
    },
    Visibility: {
      driverVisibility: driverVisibility,
      directVisible: directVisible,
      mirrorVisible: mirrorVisible,
      truckGeometry: truckGeometry,
      zoneKey: zoneKey
    },
    createPlan: createPlan,
    validatePlan: function (plan) {
      const failures = [];
      plan.events.forEach(function (event) {
        const simulation = new Simulation(plan.seed, { plan: plan, eventId: event.id });
        simulation.start();
        let steps = 0;
        while (simulation.status === 'driving' &&
          !simulation.events[event.id].resolved && steps < 7000) {
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
            observation: record.observationScore,
            reason: simulation.freezeInfo && simulation.freezeInfo.reason
          });
        }
      });
      return { ok: failures.length === 0, failures: failures };
    },
    defensiveInput: defensiveInput,
    ui: {
      progress: function (simulation) {
        return t('scene.largeVehicle.hud.progress', {
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
        const current = simulation.status === 'demonstrating' && simulation.demo
          ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (!event || event.resolved) {
          return {
            text: t('scene.largeVehicle.hud.cruise'),
            status: t('hud.cruiseGood'),
            coachTone: '',
            tone: ''
          };
        }
        if (event.template === 'side-blind-merge') {
          if (current.truck.lateralProgress > 0 && current.truck.lateralProgress < 1) {
            return {
              text: t('scene.largeVehicle.hud.sideMerge'),
              status: t('scene.largeVehicle.hud.sideMergeStatus'),
              coachTone: 'warn',
              tone: 'warn'
            };
          }
          if (current.truck.signalVisible) {
            return {
              text: t('scene.largeVehicle.hud.sideSignal'),
              status: t('scene.largeVehicle.hud.sideSignalStatus'),
              coachTone: '',
              tone: ''
            };
          }
          return {
            text: t('scene.largeVehicle.hud.sideWatch'),
            status: t('hud.cruiseGood'),
            coachTone: '',
            tone: ''
          };
        }
        if (event.template === 'front-blind-cut-in') {
          if (!current.laneChange.fullyIn) {
            if (current.assessment && current.assessment.closureRemaining < 60) {
              return {
                text: t('scene.largeVehicle.hud.frontClose'),
                status: t('scene.largeVehicle.hud.frontCloseStatus'),
                coachTone: 'warn',
                tone: 'warn'
              };
            }
            return {
              text: t('scene.largeVehicle.hud.frontWait'),
              status: t('scene.largeVehicle.hud.frontWaitStatus'),
              coachTone: '',
              tone: ''
            };
          }
          return {
            text: t('scene.largeVehicle.hud.frontMerged'),
            status: t('scene.largeVehicle.hud.frontMergedStatus'),
            coachTone: 'good',
            tone: ''
          };
        }
        if (current.truck.phase === 'warn') {
          return {
            text: t('scene.largeVehicle.hud.rearCue'),
            status: t('scene.largeVehicle.hud.rearCueStatus'),
            coachTone: 'warn',
            tone: 'warn'
          };
        }
        if (current.truck.phase === 'reversing' || current.truck.phase === 'hold') {
          return {
            text: t('scene.largeVehicle.hud.rearReverse'),
            status: t('scene.largeVehicle.hud.rearReverseStatus'),
            coachTone: 'warn',
            tone: 'warn'
          };
        }
        if (current.truck.cleared) {
          return {
            text: t('scene.largeVehicle.hud.rearClear'),
            status: t('scene.largeVehicle.hud.rearClearStatus'),
            coachTone: 'good',
            tone: ''
          };
        }
        const speedStatus = displaySpeed >= C.CRUISE_MIN_KMH && displaySpeed <= C.CRUISE_MAX_KMH
          ? 'hud.cruiseGood'
          : (displaySpeed < C.CRUISE_MIN_KMH ? 'hud.speedUp' : 'hud.nearLimit');
        return {
          text: t('scene.largeVehicle.hud.rearApproach'),
          status: t(speedStatus),
          coachTone: '',
          tone: ''
        };
      },
      retryToast: function () {
        return { key: 'scene.largeVehicle.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return {
          key: score === 10 ? 'scene.largeVehicle.toast.safe' : 'scene.largeVehicle.toast.improve',
          params: { score: score },
          neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        const key = 'scene.largeVehicle.failure.' +
          (REASONS.indexOf(info.reason) >= 0 ? info.reason : 'generic');
        return t(key, {
          side: t(info.side === 'left' ? 'scene.largeVehicle.zone.left' : 'scene.largeVehicle.zone.right'),
          speed: Math.round(info.speed),
          gap: Math.max(0, info.gap).toFixed(1),
          clearance: Math.max(0, info.clearance).toFixed(1),
          decel: info.decel ? info.decel.toFixed(1) : '0.0',
          closure: Math.max(0, info.closure).toFixed(0),
          zone: t(zoneKey(info.zone))
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        if (!demo) return { step: '', substep: '' };
        const event = demo.currentEvent;
        if (!event) {
          return {
            step: t('scene.largeVehicle.demo.done'),
            substep: t('scene.largeVehicle.demo.doneSub')
          };
        }
        if (demo.demoView === 'truck') {
          if (demo.visibility && !demo.visibility.visible) {
            return {
              step: t('scene.largeVehicle.demo.truckBlind'),
              substep: t('scene.largeVehicle.demo.truckBlindSub')
            };
          }
          return {
            step: t('scene.largeVehicle.demo.truckView'),
            substep: t('scene.largeVehicle.demo.truckViewSub')
          };
        }
        if (event.template === 'side-blind-merge') {
          if (demo.player.v < demo.truck.v - 1.5) {
            return {
              step: t('scene.largeVehicle.demo.sideDrop'),
              substep: t('scene.largeVehicle.demo.sideDropSub')
            };
          }
          return {
            step: t('scene.largeVehicle.demo.side'),
            substep: t('scene.largeVehicle.demo.sideSub')
          };
        }
        if (event.template === 'front-blind-cut-in') {
          if (demo.laneChange.state === 'MOVING') {
            return {
              step: t('scene.largeVehicle.demo.frontMerge'),
              substep: t('scene.largeVehicle.demo.frontMergeSub')
            };
          }
          return {
            step: t('scene.largeVehicle.demo.frontWait'),
            substep: t('scene.largeVehicle.demo.frontWaitSub')
          };
        }
        if (demo.laneChange.fullyIn || demo.player.v < 2) {
          return {
            step: t('scene.largeVehicle.demo.rearStop'),
            substep: t('scene.largeVehicle.demo.rearStopSub')
          };
        }
        return {
          step: t('scene.largeVehicle.demo.rear'),
          substep: t('scene.largeVehicle.demo.rearSub')
        };
      },
      updateControls: function (doc, simulation) {
        const demo = simulation.demo;
        const badge = doc.querySelector('#demo-screen .demo-badge');
        const skip = doc.getElementById('skip-demo-button');
        const toggle = doc.getElementById('view-toggle-button');
        if (badge) badge.textContent = t('scene.largeVehicle.demo.badge');
        if (skip) skip.textContent = t('game.skipDemo');
        if (toggle) {
          const truckView = demo && demo.demoView === 'truck';
          toggle.textContent = t(truckView
            ? 'scene.largeVehicle.view.myView'
            : 'scene.largeVehicle.view.truckView');
          toggle.setAttribute('aria-pressed', truckView ? 'true' : 'false');
          toggle.hidden = !demo;
        }
      },
      bindControls: function (doc, getSimulation) {
        const toggle = doc.getElementById('view-toggle-button');
        if (toggle) {
          toggle.addEventListener('click', function () {
            const simulation = getSimulation();
            if (simulation && simulation.demo) {
              simulation.demo.demoView = simulation.demo.demoView === 'truck' ? 'my' : 'truck';
            }
          });
        }
        if (doc.__largeVehicleKeyBound) return;
        doc.__largeVehicleKeyBound = true;
        doc.addEventListener('keydown', function (event) {
          if (event.code !== 'KeyV' || event.repeat) return;
          const simulation = getSimulation();
          if (simulation && simulation.status === 'demonstrating' && simulation.demo) {
            simulation.demo.demoView = simulation.demo.demoView === 'truck' ? 'my' : 'truck';
            event.preventDefault();
          }
        });
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
            label: t('scene.largeVehicle.controls.changeLeft'),
            icon: '◀',
            aria: t('scene.largeVehicle.controls.changeLeftAria')
          },
          right: {
            label: t('scene.largeVehicle.controls.changeRight'),
            icon: '▶',
            aria: t('scene.largeVehicle.controls.changeRightAria')
          }
        };
      }
    }
  };

  Scene.trajectoryAt = function (simulation) {
    return {
      x: simulation.laneChange.x,
      vx: simulation.laneChange.vx,
      yaw: simulation.player.yaw
    };
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
