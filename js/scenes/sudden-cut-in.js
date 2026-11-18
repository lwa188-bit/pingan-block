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
    CAR_X: 225,
    CAR_Y: 482,
    PIXELS_PER_METER: 7.2,
    LANE_PIXELS: 90,
    START_SPEED: 46,
    MAX_SPEED: 60,
    MAX_TIME: 96,
    ACCELERATION: 1.45,
    BRAKE_DECELERATION: 3.15,
    EMERGENCY_BRAKE_DECELERATION: 6.4,
    NATURAL_DECELERATION: 0.48,
    NPC_ACCELERATION: 1.1,
    NPC_COMFORT_BRAKE: 2.65,
    RESPONSE_TIME: 0.55,
    SPACE_BUFFER: 3.2,
    STABLE_DWELL: 1.0,
    PREDICTION_STEP: 0.025,
    PREDICTION_HORIZON: 1.8,
    AVOIDANCE_HORIZON: 3.4,
    EVENT_POSITIONS: [0, 225, 465],
    PLAYER_LENGTH: 4.35,
    PLAYER_WIDTH: 1.8,
    HISTORY_STEP: 0.1
  });
  const TEMPLATES = ['normal-merge', 'close-merge', 'merge-and-brake'];
  const PLAN_CACHE = Object.create(null);
  const PLAN_CACHE_KEYS = [];

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
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

  function smooth5(value) {
    const u = clamp(value, 0, 1);
    return u * u * u * (10 + u * (-15 + 6 * u));
  }

  function smooth5Derivative(value, duration) {
    const u = clamp(value, 0, 1);
    return 30 * u * u * (1 - 2 * u + u * u) / duration;
  }

  function deepFreezeEvent(event) {
    Object.freeze(event.originalLead.brakePlan);
    Object.freeze(event.originalLead);
    Object.freeze(event.merger.longitudinalPlan);
    Object.freeze(event.merger);
    Object.freeze(event.decoration);
    return Object.freeze(event);
  }

  function generatePlan(seed, attempt) {
    const random = M.mulberry32(M.hashSeed('sudden-cut-in:' + seed + ':' + attempt));
    const templates = shuffle(TEMPLATES, random);
    const colors = ['#d7b957', '#7fa6b2', '#c5c9b8', '#d98468', '#9b8fc2'];
    const events = templates.map(function (template, id) {
      const side = random() < 0.5 ? 'left' : 'right';
      const direction = side === 'left' ? 1 : -1;
      const laneWidth = 3.45 + random() * 0.25;
      const playerSpeed = 12.1 + random() * 1.5;
      const normal = template === 'normal-merge';
      const braking = template === 'merge-and-brake';
      const mergeStartTime = normal ? 4.4 + random() * 0.35 : 4.8 + random() * 0.45;
      const mergeDuration = 1.35 + random() * 0.4;
      const driftDuration = normal ? 0.9 + random() * 0.2 : 1.25 + random() * 0.35;
      const hasSignal = normal || random() < 0.58;
      const signalLeadTime = hasSignal ? (normal ? 1.65 + random() * 0.35 : 0.85 + random() * 0.45) : null;
      const mergerOffset = normal ? 31 + random() * 5 : 18.5 + random() * 3.5;
      const mergerSpeed = normal ? playerSpeed + 0.15 + random() * 0.5 : playerSpeed - 0.55 - random() * 0.45;
      const leadSpeed = playerSpeed + (random() - 0.5) * 0.35;
      const brakeTime = braking ? 7.65 + random() * 0.55 : null;
      const brakeTarget = braking ? 8.8 + random() * 0.8 : null;
      const brakeDeceleration = braking ? 2.15 + random() * 0.4 : null;
      const approachStartS = C.EVENT_POSITIONS[id];
      const length = 4.05 + random() * 0.5;
      const leadLength = 4.1 + random() * 0.45;
      const minimumDuration = normal ? 13.5 : (braking ? 22.5 : 16.5);
      return deepFreezeEvent({
        id: id,
        template: template,
        side: side,
        direction: direction,
        laneWidth: laneWidth,
        approachStartS: approachStartS,
        playerInitialSpeed: playerSpeed,
        minimumDuration: minimumDuration,
        originalLead: {
          initialS: approachStartS + 55 + random() * 5,
          initialSpeed: leadSpeed,
          length: leadLength,
          width: 1.78 + random() * 0.1,
          color: colors[Math.floor(random() * colors.length)],
          brakePlan: {
            startTime: brakeTime,
            targetSpeed: brakeTarget,
            deceleration: brakeDeceleration,
            holdTime: braking ? 5.2 + random() * 0.8 : null,
            resumeAcceleration: braking ? 0.85 : null
          }
        },
        merger: {
          initialS: approachStartS + mergerOffset,
          initialX: -direction * laneWidth,
          initialSpeed: mergerSpeed,
          targetSpeed: mergerSpeed,
          length: length,
          width: 1.75 + random() * 0.12,
          color: colors[Math.floor(random() * colors.length)],
          signalLeadTime: signalLeadTime,
          mergeStartS: approachStartS + mergerOffset + mergerSpeed * mergeStartTime,
          mergeStartTime: mergeStartTime,
          mergeDuration: mergeDuration,
          driftDuration: driftDuration,
          targetX: 0,
          longitudinalPlan: {
            responseDelay: braking ? 0.55 + random() * 0.2 : null,
            followBuffer: 5.5,
            followTime: 0.9,
            maxBrake: braking ? 2.75 : 2.3
          }
        },
        decoration: {
          colorIndex: Math.floor(random() * 4),
          treeOffset: Math.floor(random() * 18),
          signS: approachStartS + 34 + random() * 24
        }
      });
    });
    return Object.freeze({
      seed: seed,
      rulePack: 'cut-in-v1',
      events: Object.freeze(events)
    });
  }

  function createPlan(seed) {
    const key = String(seed);
    if (PLAN_CACHE[key]) return PLAN_CACHE[key];
    // 轨迹由确定性参数约束生成；完整自动驾驶校验只在测试中进行，避免开始按钮前
    // 同步运行数万次预测步。演示仍创建独立 Simulation，不使用预录输入。
    const plan = generatePlan(seed, 0);
    PLAN_CACHE[key] = plan;
    PLAN_CACHE_KEYS.push(key);
    if (PLAN_CACHE_KEYS.length > 80) delete PLAN_CACHE[PLAN_CACHE_KEYS.shift()];
    return plan;
  }

  function evaluateTrajectory(plan, time, longitudinalSpeed) {
    const merger = plan.merger || plan;
    const sourceX = merger.initialX;
    const targetX = merger.targetX;
    const driftStart = merger.mergeStartTime - merger.driftDuration;
    const driftX = sourceX + (targetX - sourceX) * 0.2;
    let x = sourceX;
    let vx = 0;
    let state = 'LANE_KEEP';
    let progress = 0;
    if (time >= driftStart && time < merger.mergeStartTime) {
      const u = (time - driftStart) / merger.driftDuration;
      x = sourceX + (driftX - sourceX) * smooth5(u);
      vx = (driftX - sourceX) * smooth5Derivative(u, merger.driftDuration);
      state = 'DRIFTING';
    } else if (time >= merger.mergeStartTime && time < merger.mergeStartTime + merger.mergeDuration) {
      const u = (time - merger.mergeStartTime) / merger.mergeDuration;
      x = driftX + (targetX - driftX) * smooth5(u);
      vx = (targetX - driftX) * smooth5Derivative(u, merger.mergeDuration);
      progress = u;
      state = u >= 0.82 ? 'LANE_SETTLING' : 'MERGING';
    } else if (time >= merger.mergeStartTime + merger.mergeDuration) {
      x = targetX;
      state = time < merger.mergeStartTime + merger.mergeDuration + 0.4 ? 'LANE_SETTLING' : 'SETTLED';
      progress = 1;
    } else if (merger.signalLeadTime != null && time >= driftStart - merger.signalLeadTime) {
      state = 'SIGNALING';
    }
    const fullyIn = Math.abs(x - targetX) <= (plan.laneWidth || 3.5) * 0.09 &&
      time >= merger.mergeStartTime + merger.mergeDuration * 0.78;
    const signalStart = merger.signalLeadTime == null ? Infinity : driftStart - merger.signalLeadTime;
    const signalVisible = time >= signalStart && time < merger.mergeStartTime + merger.mergeDuration + 0.25;
    return {
      x: x,
      vx: vx,
      yaw: Math.atan2(vx, Math.max(4, longitudinalSpeed == null ? merger.initialSpeed : longitudinalSpeed)),
      state: state,
      progress: progress,
      fullyIn: fullyIn,
      signalVisible: signalVisible && Math.floor((time - signalStart) / 0.42) % 2 === 0,
      signalRequested: signalVisible,
      driftStart: driftStart,
      cueVisible: time >= Math.min(driftStart, signalStart)
    };
  }

  class MergerTrajectory {
    constructor(plan) {
      this.plan = plan;
    }

    evaluate(time, speed) {
      return evaluateTrajectory(this.plan, time, speed);
    }

    static evaluate(plan, time, speed) {
      return evaluateTrajectory(plan, time, speed);
    }
  }

  function createRuntimeEvent(plan) {
    const event = Object.assign({}, plan);
    event.originalLead = Object.assign({}, plan.originalLead, {
      s: plan.originalLead.initialS,
      v: plan.originalLead.initialSpeed,
      x: 0,
      yaw: 0,
      acceleration: 0,
      braking: false,
      state: 'CRUISE'
    });
    event.merger = Object.assign({}, plan.merger, {
      s: plan.merger.initialS,
      v: plan.merger.initialSpeed,
      x: plan.merger.initialX,
      vx: 0,
      yaw: 0,
      acceleration: 0,
      braking: false,
      lateralState: 'LANE_KEEP',
      longitudinalState: 'CRUISE',
      signalVisible: false
    });
    event.active = false;
    event.localTime = 0;
    event.resolved = false;
    event.failed = false;
    event.attempts = 0;
    resetEventRecord(event);
    return event;
  }

  function resetEventRecord(event) {
    event.firstCueVisibleAt = null;
    event.mergeStartAt = null;
    event.fullyInLaneAt = null;
    event.firstResponseAt = null;
    event.responseType = 'none';
    event.responseDwell = 0;
    event.latestComfortResponseAt = event.merger.mergeStartTime + 0.4;
    event.secondaryCueAt = null;
    event.secondaryResponseAt = null;
    event.secondaryResponseDwell = 0;
    event.originalBrakeAt = null;
    event.mergerBrakeAt = null;
    event.blockingAcceleration = false;
    event.blockingTime = 0;
    event.blockingGapStart = null;
    event.earlyThrottleAfterMerge = false;
    event.earlyThrottleTime = 0;
    event.minLateralClearance = Infinity;
    event.minFrontGap = Infinity;
    event.minPredictedGap = Infinity;
    event.nearConflict = false;
    event.gapState = 'unstable';
    event.gapRecoveredAt = null;
    event.stableDwell = 0;
    event.stableFollowTime = 0;
    event.resumedTraffic = false;
    event.hardBrakeRecorded = false;
    event.unnecessaryBrakeRecorded = false;
    event.unnecessaryBrakeCooldown = 0;
    event.approachPrepared = false;
    event.approachTime = 0;
    event.approachSpeedSum = 0;
    event.approachMaxSpeed = 0;
    event.observation = 0;
    event.cueVisible = false;
    event.spaceCompressed = false;
    event.controlledYielding = false;
    event.space = null;
    event.history = [];
    event.historyClock = 0;
    event.scoreSnapshot = null;
    event.startElapsed = 0;
  }

  function cloneScoring(state) {
    const copy = {};
    Object.keys(state || {}).forEach(function (key) { copy[key] = state[key]; });
    return copy;
  }

  function createScoring() {
    const state = Game.Scoring.createState();
    state.rushPenalties = 0;
    state.earlyThrottlePenalties = 0;
    state.unnecessaryBrakes = 0;
    state.pedalOscillations = 0;
    state.yieldExemptTime = 0;
    state.pedalWindow = 0;
    state.pedalChanges = 0;
    state.lastPedal = 'none';
    return state;
  }

  function createOBB(vehicle) {
    const yaw = vehicle.yaw || 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const halfW = (vehicle.width || C.PLAYER_WIDTH) / 2;
    const halfL = (vehicle.length || C.PLAYER_LENGTH) / 2;
    const x = vehicle.x || 0;
    const s = vehicle.s == null ? (vehicle.distance || 0) : vehicle.s;
    const vertices = [
      [-halfW, -halfL], [halfW, -halfL], [halfW, halfL], [-halfW, halfL]
    ].map(function (point) {
      return {
        x: x + point[0] * cos + point[1] * sin,
        s: s - point[0] * sin + point[1] * cos
      };
    });
    return {
      x: x,
      s: s,
      yaw: yaw,
      halfW: halfW,
      halfL: halfL,
      vertices: vertices,
      axes: [{ x: cos, s: -sin }, { x: sin, s: cos }]
    };
  }

  function projection(box, axis) {
    let min = Infinity;
    let max = -Infinity;
    box.vertices.forEach(function (vertex) {
      const value = vertex.x * axis.x + vertex.s * axis.s;
      min = Math.min(min, value);
      max = Math.max(max, value);
    });
    return { min: min, max: max };
  }

  function obbIntersects(a, b) {
    const first = a.vertices ? a : createOBB(a);
    const second = b.vertices ? b : createOBB(b);
    const axes = first.axes.concat(second.axes);
    for (let index = 0; index < axes.length; index += 1) {
      const pa = projection(first, axes[index]);
      const pb = projection(second, axes[index]);
      if (pa.max <= pb.min + 0.000001 || pb.max <= pa.min + 0.000001) return false;
    }
    return true;
  }

  function pointSegmentDistance(point, a, b) {
    const dx = b.x - a.x;
    const ds = b.s - a.s;
    const length2 = dx * dx + ds * ds;
    const u = length2 > 0 ? clamp(((point.x - a.x) * dx + (point.s - a.s) * ds) / length2, 0, 1) : 0;
    return Math.hypot(point.x - (a.x + dx * u), point.s - (a.s + ds * u));
  }

  function obbClearance(a, b) {
    const first = a.vertices ? a : createOBB(a);
    const second = b.vertices ? b : createOBB(b);
    if (obbIntersects(first, second)) return 0;
    let distance = Infinity;
    [first, second].forEach(function (box, boxIndex) {
      const other = boxIndex === 0 ? second : first;
      box.vertices.forEach(function (vertex) {
        for (let index = 0; index < 4; index += 1) {
          distance = Math.min(distance, pointSegmentDistance(vertex, other.vertices[index], other.vertices[(index + 1) % 4]));
        }
      });
    });
    return distance;
  }

  function frontGap(player, lead) {
    if (!lead) return Infinity;
    const yaw = lead.yaw || 0;
    const projectedHalfLength = Math.abs(Math.cos(yaw)) * lead.length / 2 + Math.abs(Math.sin(yaw)) * lead.width / 2;
    return lead.s - projectedHalfLength - (player.s + player.length / 2);
  }

  function lateralClearance(player, merger) {
    const longitudinalLimit = (player.length + merger.length) / 2 + 1.5;
    if (Math.abs(player.s - merger.s) > longitudinalLimit) return Infinity;
    const yaw = merger.yaw || 0;
    const projectedWidth = Math.abs(Math.cos(yaw)) * merger.width / 2 + Math.abs(Math.sin(yaw)) * merger.length / 2;
    return Math.abs(merger.x - player.x) - player.width / 2 - projectedWidth;
  }

  function advanceOriginalLead(event, dt) {
    const lead = event.originalLead;
    const plan = event.originalLead.brakePlan;
    const oldSpeed = lead.v;
    let target = event.originalLead.initialSpeed;
    let maxChange = C.NPC_ACCELERATION * dt;
    lead.braking = false;
    if (plan.startTime != null && event.localTime >= plan.startTime) {
      const since = event.localTime - plan.startTime;
      if (lead.v > plan.targetSpeed + 0.02) {
        target = plan.targetSpeed;
        maxChange = plan.deceleration * dt;
        lead.state = 'COMFORT_BRAKING';
        lead.braking = true;
      } else if (since <= plan.holdTime) {
        target = plan.targetSpeed;
        lead.state = 'LOW_SPEED_FOLLOW';
        maxChange = plan.deceleration * dt;
      } else {
        target = event.originalLead.initialSpeed;
        lead.state = 'RESUMING';
        maxChange = plan.resumeAcceleration * dt;
      }
    } else {
      lead.state = 'CRUISE';
    }
    lead.v = M.moveToward(lead.v, target, maxChange);
    lead.acceleration = dt > 0 ? (lead.v - oldSpeed) / dt : 0;
    lead.braking = lead.braking || lead.acceleration < -0.12;
    lead.s += (oldSpeed + lead.v) * 0.5 * dt;
  }

  function advanceMerger(event, dt) {
    const merger = event.merger;
    const lead = event.originalLead;
    const plan = merger.longitudinalPlan;
    const oldSpeed = merger.v;
    let target = merger.targetSpeed;
    let accelerationLimit = C.NPC_ACCELERATION;
    let following = false;
    if (event.originalLead.brakePlan.startTime != null && event.originalBrakeAt != null &&
      event.localTime >= event.originalBrakeAt + plan.responseDelay) {
      following = true;
      const gap = lead.s - lead.length / 2 - (merger.s + merger.length / 2);
      const desired = plan.followBuffer + merger.v * plan.followTime;
      target = Math.min(merger.targetSpeed, lead.v + clamp((gap - desired) * 0.12, -2.4, 0.6));
      if (merger.v > target + 0.08 || lead.braking) {
        merger.longitudinalState = 'COMFORT_BRAKING';
        accelerationLimit = plan.maxBrake;
      } else {
        merger.longitudinalState = 'FOLLOWING';
      }
    }
    if (!following && merger.v < merger.targetSpeed - 0.05) merger.longitudinalState = 'RESUMING';
    else if (!following) merger.longitudinalState = 'CRUISE';
    const next = M.moveToward(merger.v, Math.max(0, target), accelerationLimit * dt);
    merger.v = next;
    merger.acceleration = dt > 0 ? (next - oldSpeed) / dt : 0;
    merger.braking = merger.acceleration < -0.12;
    merger.s += (oldSpeed + next) * 0.5 * dt;
    const trajectory = evaluateTrajectory(event, event.localTime, merger.v);
    merger.x = trajectory.x;
    merger.vx = trajectory.vx;
    merger.yaw = trajectory.yaw;
    merger.lateralState = trajectory.state;
    merger.signalVisible = trajectory.signalVisible;
    merger.signalRequested = trajectory.signalRequested;
  }

  function advanceTraffic(event, dt) {
    advanceOriginalLead(event, dt);
    advanceMerger(event, dt);
  }

  const LongitudinalController = {
    advanceOriginalLead: advanceOriginalLead,
    advanceMerger: advanceMerger,
    advance: advanceTraffic
  };

  function currentLead(simulation, event) {
    if (!event) return null;
    const merger = event.merger;
    const lead = event.originalLead;
    const mergerRelevant = merger.s > simulation.player.s - 0.5 && Math.abs(merger.x) < event.laneWidth * 0.55;
    if (!mergerRelevant) return lead;
    return frontGap(simulation.player, merger) <= frontGap(simulation.player, lead) ? merger : lead;
  }

  function controlledPrediction(player, lead) {
    if (!lead) return { minGap: Infinity, requiredGap: 0 };
    let pv = player.v;
    let lv = Math.max(0, lead.v);
    let gap = Math.max(-2, frontGap(player, lead));
    let minGap = gap;
    const step = 0.05;
    for (let time = 0; time < 5; time += step) {
      const playerAcceleration = time < C.RESPONSE_TIME ? -C.NATURAL_DECELERATION : -C.BRAKE_DECELERATION;
      const leadAcceleration = time < C.RESPONSE_TIME ? clamp(lead.acceleration || 0, -C.NPC_COMFORT_BRAKE, 0) :
        (lv > 0.05 ? -C.NPC_COMFORT_BRAKE : 0);
      const nextPv = Math.max(0, pv + playerAcceleration * step);
      const nextLv = Math.max(0, lv + leadAcceleration * step);
      gap += ((nextLv + lv) - (nextPv + pv)) * 0.5 * step;
      minGap = Math.min(minGap, gap);
      pv = nextPv;
      lv = nextLv;
      if (pv <= 0 && lv <= 0) break;
    }
    const required = C.SPACE_BUFFER + Math.max(0,
      player.v * C.RESPONSE_TIME + player.v * player.v / (2 * C.BRAKE_DECELERATION) -
      lead.v * lead.v / (2 * C.NPC_COMFORT_BRAKE));
    return { minGap: minGap, requiredGap: required };
  }

  function assessSpace(simulation, event) {
    event = event || simulation.currentEvent;
    if (!event) return {
      state: 'stable', compressed: false, stable: false, recovering: false, overYield: false,
      gap: Infinity, relativeSpeed: 0, requiredGap: 0, predictedMinGap: Infinity, lead: null
    };
    const player = simulation.player;
    const lead = currentLead(simulation, event);
    const gap = frontGap(player, lead);
    const relativeSpeed = player.v - (lead ? lead.v : 0);
    const prediction = controlledPrediction(player, lead);
    const compressed = gap < prediction.requiredGap || prediction.minGap < 1.8 ||
      (relativeSpeed > 1.7 && gap < prediction.requiredGap * 1.55);
    const noClosingThrottle = !simulation.lastInput.throttle || relativeSpeed < -0.3 ||
      (relativeSpeed < 0.45 && gap > prediction.requiredGap + 4);
    const stableNow = gap > prediction.requiredGap + 0.8 && prediction.minGap > 2.3 &&
      relativeSpeed < 1.15 && relativeSpeed > -5.5 && noClosingThrottle && gap > 0;
    const recovering = !stableNow && !simulation.lastInput.throttle &&
      (simulation.acceleration < 0.05 || relativeSpeed < 0.5) && prediction.minGap > 0.4;
    const overYield = event.gapRecoveredAt != null && !compressed &&
      ((player.v < 7.5 && lead && lead.v > 10) || gap > prediction.requiredGap * 2.5 + 12);
    let state = 'unstable';
    if (overYield) state = 'over-yield';
    else if (event.stableDwell >= C.STABLE_DWELL && stableNow) state = 'stable';
    else if (recovering) state = 'recovering';
    return {
      state: state,
      compressed: compressed,
      stable: stableNow,
      recovering: recovering,
      overYield: overYield,
      gap: gap,
      relativeSpeed: relativeSpeed,
      requiredGap: prediction.requiredGap,
      predictedMinGap: prediction.minGap,
      lead: lead
    };
  }

  function clonePredictionEvent(event) {
    return Object.assign({}, event, {
      originalLead: Object.assign({}, event.originalLead),
      merger: Object.assign({}, event.merger)
    });
  }

  function playerAcceleration(simulation, input, fullBrake) {
    if (input.brake) {
      if (fullBrake) return -C.EMERGENCY_BRAKE_DECELERATION;
      const lead = currentLead(simulation, simulation.currentEvent);
      const gap = lead ? frontGap(simulation.player, lead) : Infinity;
      return -(gap < 8.5 && simulation.player.v > 5 ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);
    }
    return input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION;
  }

  function travelWithin(speed, acceleration, horizon) {
    if (acceleration >= 0) return speed * horizon + 0.5 * acceleration * horizon * horizon;
    const movingTime = Math.min(horizon, speed / -acceleration);
    return Math.max(0, speed * movingTime + 0.5 * acceleration * movingTime * movingTime);
  }

  function canApproachWithin(player, vehicle, horizon, input, options) {
    const longitudinal = vehicle.s - player.s;
    const contactMargin = player.length / 2 + (vehicle.length + vehicle.width) / 2 + 0.15;
    const playerAcceleration = input.brake ? -(options.fullBrake || options.emergency ?
      C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION) :
      (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
    const playerTravel = travelWithin(player.v, playerAcceleration, horizon);
    if (longitudinal >= 0) {
      const brakingPlan = vehicle.brakePlan || {};
      const longitudinalPlan = vehicle.longitudinalPlan || {};
      const maxBrake = brakingPlan.deceleration || longitudinalPlan.maxBrake || C.NPC_COMFORT_BRAKE;
      const vehicleMinimumTravel = travelWithin(vehicle.v, -maxBrake, horizon);
      return longitudinal + vehicleMinimumTravel - playerTravel <= contactMargin;
    }
    const vehicleTravel = travelWithin(vehicle.v, C.NPC_ACCELERATION, horizon);
    return -longitudinal + playerTravel - vehicleTravel <= contactMargin;
  }

  function predictOutcome(simulation, input, options) {
    options = options || {};
    const sourceEvent = options.event || simulation.currentEvent;
    const player = Object.assign({}, simulation.player);
    const event = sourceEvent ? clonePredictionEvent(sourceEvent) : null;
    const horizon = options.horizon || C.PREDICTION_HORIZON;
    const contactCandidates = event ? [canApproachWithin(player, event.merger, horizon, input, options),
      canApproachWithin(player, event.originalLead, horizon, input, options)] : [false, false];
    // 即使一方立即停车、另一方按最大加速度前进也不可能在预测窗内接近，
    // 就不必执行数十次子步和 OBB 投影。
    if (event && !contactCandidates[0] && !contactCandidates[1]) {
      return { collision: null, minGap: Infinity, minLateral: Infinity };
    }
    let minGap = Infinity;
    let minLateral = Infinity;
    const step = C.PREDICTION_STEP;
    for (let time = 0; time < horizon - 0.000001; time += step) {
      const slice = Math.min(step, horizon - time);
      const acceleration = input.brake ? -(options.fullBrake ? C.EMERGENCY_BRAKE_DECELERATION :
        (options.emergency ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION)) :
        (input.throttle ? C.ACCELERATION : -C.NATURAL_DECELERATION);
      const oldSpeed = player.v;
      player.v = clamp(player.v + acceleration * slice, 0, C.MAX_SPEED / 3.6);
      player.s += (oldSpeed + player.v) * 0.5 * slice;
      if (event) {
        event.localTime += slice;
        advanceTraffic(event, slice);
        [event.merger, event.originalLead].forEach(function (vehicle, index) {
          if (!contactCandidates[index]) return;
          if (index === 1 && Math.abs(vehicle.x - player.x) > event.laneWidth * 0.5) return;
          if (obbIntersects(player, vehicle)) {
            throw { prediction: {
              time: time + slice,
              kind: index === 0 && Math.abs(vehicle.x) > 0.55 ? 'side' : 'rear',
              vehicle: index === 0 ? 'merger' : 'originalLead',
              minGap: minGap,
              minLateral: minLateral
            } };
          }
          const gap = frontGap(player, vehicle);
          if (vehicle.s >= player.s && Math.abs(vehicle.x) < event.laneWidth * 0.55) minGap = Math.min(minGap, gap);
        });
        minLateral = Math.min(minLateral, lateralClearance(player, event.merger));
      }
      if (player.v <= 0 && !event) break;
    }
    return { collision: null, minGap: minGap, minLateral: minLateral };
  }

  // 不用异常驱动正常逻辑；该包装只转换上面的快速退出哨兵。
  function safePredictOutcome(simulation, input, options) {
    try {
      return predictOutcome(simulation, input, options);
    } catch (signal) {
      if (signal && signal.prediction) return { collision: signal.prediction, minGap: signal.prediction.minGap,
        minLateral: signal.prediction.minLateral };
      throw signal;
    }
  }

  function predictMergeConflict(simulation, input, options) {
    return safePredictOutcome(simulation, input || {}, options).collision;
  }

  function predictRearConflict(simulation, input, options) {
    const prediction = predictMergeConflict(simulation, input, options);
    return prediction && prediction.kind === 'rear' ? prediction : null;
  }

  function computeDefensiveInput(simulation) {
    const event = simulation.currentEvent;
    if (!event || !event.active) {
      return { throttle: simulation.speed < 46.5, brake: simulation.speed > 49 };
    }
    const player = simulation.player;
    const merger = event.merger;
    const lead = currentLead(simulation, event);
    const trajectory = evaluateTrajectory(event, event.localTime, merger.v);
    const cue = trajectory.cueVisible;
    const mergerGap = frontGap(player, merger);
    const useMerger = cue && merger.s > player.s && mergerGap < 38 && !event.resolved;
    const observedLead = useMerger ? merger : lead;
    const gap = observedLead ? frontGap(player, observedLead) : Infinity;
    const leadKmh = observedLead ? observedLead.v * 3.6 : 46;
    const desired = 4.5 + player.v * 0.9;
    let target = 46.5;
    if (observedLead) {
      target = Math.min(target, leadKmh + clamp((gap - desired) * 0.55, -7, 3));
      if (useMerger && Math.abs(merger.x) > 0.2 && mergerGap < 27) target = Math.min(target, leadKmh - 1.8);
      if (gap < desired * 0.7) target = Math.min(target, leadKmh - 4);
      if (observedLead.braking && gap < desired * 1.4) target = Math.min(target, leadKmh - 2);
    }
    target = clamp(target, 0, 47);
    const speed = player.v * 3.6;
    const closing = observedLead && player.v > observedLead.v + 0.45;
    let throttle = speed < target - 0.45;
    if (event.fullyInLaneAt != null && event.gapRecoveredAt == null && closing && gap < 34) throttle = false;
    if (event.template !== 'normal-merge' && event.fullyInLaneAt != null && event.gapRecoveredAt == null) throttle = false;
    if (cue && mergerGap < 34 && event.gapRecoveredAt == null) throttle = false;
    const brake = speed > target + 1.0 && observedLead &&
      (event.template !== 'normal-merge' || event.spaceCompressed || observedLead.braking) &&
      (gap < desired * 1.1 || observedLead.braking || (cue && mergerGap < 24));
    return { throttle: throttle && !brake, brake: Boolean(brake) };
  }

  function defensiveInput(simulation) {
    const control = simulation.defensiveControl || { nextUpdateAt: -Infinity, input: {} };
    if (simulation.elapsed >= control.nextUpdateAt) {
      control.input = computeDefensiveInput(simulation);
      control.nextUpdateAt = simulation.elapsed + 0.24;
    }
    simulation.defensiveControl = control;
    return control.input;
  }

  function validatePlan(plan) {
    if (typeof Simulation !== 'function') return true;
    for (let id = 0; id < plan.events.length; id += 1) {
      const simulation = new Simulation(plan.seed, { plan: plan, eventId: id, validating: true });
      simulation.start();
      let guard = 0;
      while (simulation.status === 'driving' && !simulation.events[id].resolved && guard < 2400) {
        simulation.step(defensiveInput(simulation), C.FIXED_STEP);
        guard += 1;
      }
      const event = simulation.events[id];
      if (!event.resolved || event.failed || event.nearConflict || event.blockingAcceleration ||
        Scoring.eventObservation(event) < 10 || simulation.scoring.hardBrakes > 0) return false;
    }
    return true;
  }

  class Simulation {
    constructor(seed, options) {
      options = options || {};
      this.seed = seed;
      this.plan = options.plan || createPlan(seed);
      this.events = this.plan.events.map(createRuntimeEvent);
      this.eventIndex = options.eventId == null ? 0 : options.eventId;
      for (let index = 0; index < this.eventIndex; index += 1) {
        this.events[index].resolved = true;
        this.events[index].observation = 10;
        this.events[index].approachPrepared = true;
        this.events[index].responseType = 'steady';
        this.events[index].gapRecoveredAt = 0;
        this.events[index].stableFollowTime = 2;
        this.events[index].resumedTraffic = true;
      }
      const plan = this.events[this.eventIndex];
      this.player = {
        x: 0,
        s: plan.approachStartS,
        v: options.eventId == null && this.eventIndex === 0 ? plan.playerInitialSpeed : plan.playerInitialSpeed,
        yaw: 0,
        length: C.PLAYER_LENGTH,
        width: C.PLAYER_WIDTH
      };
      this.distance = this.player.s;
      this.speed = this.player.v * 3.6;
      this.previousSpeed = this.speed;
      this.acceleration = 0;
      this.lastDeceleration = 0;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = createScoring();
      this.lastInput = {};
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoMode = 'driver';
      this.replayReturnStatus = null;
      this.retryCount = 0;
      this.validating = Boolean(options.validating);
      this.activateEvent(this.currentEvent);
    }

    get currentEvent() {
      const event = this.events[this.eventIndex];
      return event && !event.resolved ? event : null;
    }

    start() {
      this.status = 'driving';
      if (this.currentEvent && !this.currentEvent.active) this.activateEvent(this.currentEvent);
    }

    activateEvent(event) {
      if (!event || event.active) return;
      event.active = true;
      event.localTime = 0;
      const playerOffset = this.player.s - event.approachStartS;
      event.originalLead.s = event.originalLead.initialS + playerOffset;
      event.originalLead.v = event.originalLead.initialSpeed;
      event.merger.s = event.merger.initialS + playerOffset;
      event.merger.v = event.merger.initialSpeed;
      event.startElapsed = this.elapsed;
      event.scoreSnapshot = cloneScoring(this.scoring);
      this.recordHistory(event, 0, true);
    }

    assessSpace(event) {
      return assessSpace(this, event || this.currentEvent);
    }

    updateResponse(event, input, dt) {
      const trajectory = evaluateTrajectory(event, event.localTime, event.merger.v);
      event.cueVisible = trajectory.cueVisible;
      if (event.cueVisible && event.firstCueVisibleAt == null) event.firstCueVisibleAt = event.localTime;
      if (event.mergeStartAt == null && event.localTime >= event.merger.mergeStartTime) event.mergeStartAt = event.localTime;
      if (event.fullyInLaneAt == null && trajectory.fullyIn) event.fullyInLaneAt = event.localTime;
      if (event.originalBrakeAt == null && event.originalLead.braking) event.originalBrakeAt = event.localTime;
      if (event.mergerBrakeAt == null && event.merger.braking) event.mergerBrakeAt = event.localTime;
      if (event.originalBrakeAt != null && event.secondaryCueAt == null) event.secondaryCueAt = event.originalBrakeAt;

      if (event.cueVisible && event.firstResponseAt == null && event.template === 'normal-merge' &&
        event.localTime >= event.firstCueVisibleAt + 0.45 && !event.blockingAcceleration &&
        !event.unnecessaryBrakeRecorded && this.speed >= 38 && this.speed <= 56) {
        event.firstResponseAt = event.firstCueVisibleAt;
        event.responseType = 'steady';
      }
      if (event.cueVisible && event.firstResponseAt == null && event.template !== 'normal-merge') {
        const appropriate = !input.throttle;
        event.responseDwell = appropriate ? event.responseDwell + dt : 0;
        if (event.responseDwell >= 0.12) {
          event.firstResponseAt = event.localTime - 0.12;
          if (event.template === 'normal-merge' && !input.brake) event.responseType = 'steady';
          else if (input.brake) event.responseType = 'brake';
          else event.responseType = 'lift';
          if (event.firstResponseAt > event.latestComfortResponseAt) event.responseType = 'late';
        }
      }
      if (event.secondaryCueAt != null && event.secondaryResponseAt == null) {
        const responding = !input.throttle;
        event.secondaryResponseDwell = responding ? event.secondaryResponseDwell + dt : 0;
        if (event.secondaryResponseDwell >= 0.2) event.secondaryResponseAt = event.localTime - 0.2;
      }
    }

    updateBlocking(event, input, dt, space) {
      const mergerGap = frontGap(this.player, event.merger);
      const riskyPhase = event.cueVisible && (event.fullyInLaneAt == null || event.gapRecoveredAt == null);
      const closing = mergerGap >= -1 && this.player.v > event.merger.v - 0.1;
      if (riskyPhase && input.throttle && closing && mergerGap < 32) {
        if (event.blockingGapStart == null) event.blockingGapStart = mergerGap;
        event.blockingTime += dt;
        if (event.blockingTime >= 0.3 &&
          (event.blockingGapStart - mergerGap > 0.12 || this.player.v > event.playerInitialSpeed + 0.12)) {
          event.blockingAcceleration = true;
        }
      } else {
        event.blockingTime = Math.max(0, event.blockingTime - dt * 2);
        if (event.blockingTime <= 0) event.blockingGapStart = null;
      }
      if (event.template !== 'normal-merge' && event.fullyInLaneAt != null &&
        event.gapRecoveredAt == null && input.throttle) {
        event.earlyThrottleTime += dt;
        if (event.earlyThrottleTime >= 0.25) event.earlyThrottleAfterMerge = true;
      } else {
        event.earlyThrottleTime = 0;
      }
    }

    updateSpace(event, input, dt) {
      const space = assessSpace(this, event);
      event.space = space;
      event.spaceCompressed = space.compressed;
      event.controlledYielding = !input.throttle;
      // 入线前的充分间距只属于原车流；新前车入线后必须重新持续确认，
      // 否则会在 fullyInLaneAt 同帧恢复，漏掉“立刻加速贴回”的真实风险窗口。
      event.stableDwell = event.fullyInLaneAt != null && space.stable ? event.stableDwell + dt : 0;
      if (event.stableDwell >= C.STABLE_DWELL && event.gapRecoveredAt == null && event.fullyInLaneAt != null) {
        event.gapRecoveredAt = event.localTime;
      }
      event.gapState = assessSpace(this, event).state;
      if (event.gapRecoveredAt != null && !space.compressed && space.relativeSpeed < 1.5 &&
        !event.earlyThrottleAfterMerge) event.stableFollowTime += dt;
      const lead = currentLead(this, event);
      // 恢复通行只要求车速重新接近车流；合理并线后间距自然拉大也应结算，
      // 不能把较大的安全间距误判为必须继续追赶的状态。
      if (event.gapRecoveredAt != null && lead && this.player.v >= Math.min(11.2, lead.v - 0.4) &&
        this.player.v >= lead.v - 1.2) event.resumedTraffic = true;

      const gap = frontGap(this.player, event.merger);
      if (event.merger.s >= this.player.s - 1 && Math.abs(event.merger.x) < event.laneWidth * 0.6) {
        event.minFrontGap = Math.min(event.minFrontGap, gap);
      }
      const lateral = lateralClearance(this.player, event.merger);
      event.minLateralClearance = Math.min(event.minLateralClearance, lateral);
      const clearance = obbClearance(this.player, event.merger);
      if ((clearance < 0.32 && Math.abs(event.merger.x) < event.laneWidth * 0.6) ||
        (event.fullyInLaneAt != null && gap >= 0 && gap < 1.25)) event.nearConflict = true;
    }

    recordHistory(event, dt, force) {
      event.historyClock += dt || 0;
      if (!force && event.historyClock < C.HISTORY_STEP) return;
      event.historyClock %= C.HISTORY_STEP;
      const lead = currentLead(this, event);
      event.history.push({
        time: event.localTime,
        playerS: this.player.s,
        playerV: this.player.v,
        mergerS: event.merger.s,
        mergerX: event.merger.x,
        mergerYaw: event.merger.yaw,
        gap: frontGap(this.player, lead),
        relativeSpeed: lead ? this.player.v - lead.v : 0,
        throttle: Boolean(this.lastInput.throttle),
        brake: Boolean(this.lastInput.brake)
      });
      if (event.history.length > 320) event.history.shift();
    }

    updateApproach(event, dt) {
      if (event.firstCueVisibleAt != null) return;
      event.approachTime += dt;
      event.approachSpeedSum += this.speed * dt;
      event.approachMaxSpeed = Math.max(event.approachMaxSpeed, this.speed);
      const average = event.approachTime > 0 ? event.approachSpeedSum / event.approachTime : this.speed;
      // 前一段刚完成二次减速时，允许从恢复中的车速平顺加速；首段仍按合理巡航评价。
      const minimumApproachSpeed = event.id > 0 ? 30 : 40;
      event.approachPrepared = event.approachTime >= 1 && average >= minimumApproachSpeed && average <= 55 && event.approachMaxSpeed <= 58;
    }

    freeze(event, reason, prediction) {
      if (this.status !== 'driving') return;
      event.failed = true;
      event.attempts += 1;
      this.retryCount += 1;
      let teachingReason = reason;
      if (event.blockingAcceleration) teachingReason = 'blocking';
      else if (event.earlyThrottleAfterMerge) teachingReason = 'earlyThrottle';
      else if (event.secondaryCueAt != null && event.secondaryResponseAt == null) teachingReason = 'secondBrake';
      else if (event.responseType === 'none' || event.responseType === 'late') teachingReason = 'late';
      this.freezeInfo = {
        eventId: event.id,
        reason: teachingReason,
        contactReason: reason,
        side: event.side,
        speed: this.speed,
        gap: frontGap(this.player, currentLead(this, event)),
        minFrontGap: event.minFrontGap,
        minLateralClearance: event.minLateralClearance,
        firstCueVisibleAt: event.firstCueVisibleAt,
        firstResponseAt: event.firstResponseAt,
        originalBrakeAt: event.originalBrakeAt,
        mergerBrakeAt: event.mergerBrakeAt,
        prediction: prediction || null,
        history: event.history.slice()
      };
      this.status = 'frozen';
    }

    resolveEvent(event) {
      const firstTimely = event.firstResponseAt != null && event.firstResponseAt <= event.latestComfortResponseAt;
      const secondTimely = event.secondaryCueAt == null ||
        (event.secondaryResponseAt != null && event.secondaryResponseAt <= event.secondaryCueAt + 1.8);
      let responseScore = firstTimely ? 3 : 0;
      if (event.template === 'merge-and-brake') responseScore = (firstTimely ? 2 : 0) + (secondTimely ? 1 : 0);
      if (event.template === 'normal-merge' && (event.unnecessaryBrakeRecorded || event.blockingAcceleration)) responseScore = 0;
      const recovery = event.template === 'normal-merge' ? !event.nearConflict && !event.unnecessaryBrakeRecorded :
        event.gapRecoveredAt != null;
      event.observation = (event.approachPrepared ? 2 : 0) + responseScore +
        (recovery && !event.blockingAcceleration && !event.earlyThrottleAfterMerge ? 3 : 0) +
        (event.stableFollowTime >= 0.9 && event.resumedTraffic && !event.earlyThrottleAfterMerge && secondTimely ? 2 : 0);
      event.resolved = true;
      this.justResolved = event;
      if (this.eventIndex === this.events.length - 1) {
        this.status = 'complete';
        this.player.v = 0;
        this.speed = 0;
      } else {
        this.eventIndex += 1;
      }
    }

    eventCanResolve(event) {
      if (event.localTime < event.minimumDuration || event.fullyInLaneAt == null || event.gapRecoveredAt == null ||
        event.stableFollowTime < 0.9 || !event.resumedTraffic) return false;
      if (event.template === 'merge-and-brake' && event.secondaryResponseAt == null) return false;
      return true;
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      if (dt <= 0) return;
      input = input || {};
      if (input.brake) input = { throttle: false, brake: true };
      this.lastInput = input;
      this.justHardBrake = false;
      this.justResolved = null;
      let event = this.currentEvent;
      if (!event) return;
      if (!event.active && this.distance >= event.approachStartS) this.activateEvent(event);
      if (!event.active) {
        this.advancePlayer(input, dt);
        this.elapsed += dt;
        Scoring.recordStep(this.scoring, this, dt);
        if (this.elapsed >= C.MAX_TIME) this.timeout();
        return;
      }

      const outcome = safePredictOutcome(this, input);
      if (isFinite(outcome.minGap)) event.minPredictedGap = Math.min(event.minPredictedGap, outcome.minGap);
      if (outcome.collision) {
        const avoidance = safePredictOutcome(this, { brake: true }, { fullBrake: true, horizon: C.AVOIDANCE_HORIZON });
        if (avoidance.collision) {
          this.freeze(event, outcome.collision.kind, outcome.collision);
          return;
        }
      }

      const oldPlayer = Object.assign({}, this.player);
      const oldLead = Object.assign({}, event.originalLead);
      const oldMerger = Object.assign({}, event.merger);
      const oldLocalTime = event.localTime;
      this.previousSpeed = this.speed;
      this.elapsed += dt;
      event.localTime += dt;
      this.advancePlayer(input, dt, event);
      advanceTraffic(event, dt);

      if (obbIntersects(this.player, event.merger) || obbIntersects(this.player, event.originalLead)) {
        this.player = oldPlayer;
        event.originalLead = oldLead;
        event.merger = oldMerger;
        event.localTime = oldLocalTime;
        this.distance = this.player.s;
        this.speed = this.player.v * 3.6;
        this.freeze(event, obbIntersects(this.player, oldMerger) ? 'side' : 'rear', { time: 0 });
        return;
      }

      this.updateResponse(event, input, dt);
      this.updateApproach(event, dt);
      this.updateSpace(event, input, dt);
      this.updateBlocking(event, input, dt, event.space);
      this.recordHistory(event, dt, false);
      Scoring.recordStep(this.scoring, this, dt);
      if (this.eventCanResolve(event)) this.resolveEvent(event);
      if (this.elapsed >= C.MAX_TIME && this.status === 'driving') this.timeout();
    }

    advancePlayer(input, dt, event) {
      const acceleration = playerAcceleration(this, input, false);
      this.acceleration = acceleration;
      const oldSpeed = this.player.v;
      this.player.v = clamp(oldSpeed + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      if (!input.throttle && !input.brake && this.player.v < 0.03) this.player.v = 0;
      this.player.s += (oldSpeed + this.player.v) * 0.5 * dt;
      this.distance = this.player.s;
      this.speed = this.player.v * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeed - this.player.v) / dt);
    }

    timeout() {
      this.player.v = 0;
      this.speed = 0;
      this.status = 'timeout';
    }

    retryEvent() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.demoEventId != null ? this.demoEventId : this.eventIndex);
      this.eventIndex = clamp(eventId, 0, this.events.length - 1);
      const old = this.events[this.eventIndex];
      const preserved = {
        failed: old.failed,
        attempts: old.attempts,
        resolved: false,
        scoreSnapshot: old.scoreSnapshot,
        startElapsed: old.startElapsed
      };
      const fresh = createRuntimeEvent(this.plan.events[this.eventIndex]);
      Object.keys(old).forEach(function (key) { delete old[key]; });
      Object.assign(old, fresh, preserved);
      this.events[this.eventIndex] = old;
      this.player = {
        x: 0, s: old.approachStartS, v: old.playerInitialSpeed, yaw: 0,
        length: C.PLAYER_LENGTH, width: C.PLAYER_WIDTH
      };
      this.distance = this.player.s;
      this.speed = this.player.v * 3.6;
      this.previousSpeed = this.speed;
      this.acceleration = 0;
      this.lastDeceleration = 0;
      this.elapsed = old.startElapsed || 0;
      if (old.scoreSnapshot) this.scoring = cloneScoring(old.scoreSnapshot);
      this.lastInput = {};
      this.defensiveControl = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.demoMode = 'driver';
      this.replayReturnStatus = null;
      this.justResolved = null;
      this.justHardBrake = false;
      this.activateEvent(old);
      this.status = 'driving';
    }

    makeDemo(eventId) {
      const demo = new Simulation(this.seed, { plan: this.plan, eventId: eventId, validating: true });
      demo.status = 'driving';
      return demo;
    }

    startDemo() {
      const eventId = this.freezeInfo ? this.freezeInfo.eventId :
        (this.currentEvent ? this.currentEvent.id : clamp(this.eventIndex, 0, this.events.length - 1));
      if (eventId == null) return;
      this.demoEventId = eventId;
      this.demo = this.makeDemo(this.demoEventId);
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
      this.demoTime = 0;
      this.demoMode = 'space';
      this.justResolved = null;
      this.status = 'demonstrating';
    }

    startSpaceReplay() {
      this.startPedestrianReplay();
    }

    finishReplay() {
      if (this.demoMode !== 'space') return;
      this.demo = null;
      this.demoTime = 0;
      this.demoMode = 'driver';
      this.status = this.replayReturnStatus || (this.freezeInfo ? 'frozen' : 'complete');
      this.replayReturnStatus = null;
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      const event = this.demo.events[this.demoEventId];
      this.demo.step(defensiveInput(this.demo), dt);
      const done = event.resolved || this.demo.status === 'frozen' || this.demo.status === 'timeout' || this.demoTime >= 36;
      if (!done) return;
      if (this.demoMode === 'space') this.finishReplay();
      else this.retryEvent();
    }
  }

  const Scoring = {
    eventObservation: function (event) {
      return event.observation || 0;
    },

    eventSafe: function (event) {
      return event.resolved && !event.failed && !event.blockingAcceleration && !event.nearConflict &&
        event.minFrontGap > 0.5 && event.minLateralClearance > 0.05;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || !event.active || event.unnecessaryBrakeRecorded) return false;
      const necessaryFlow = event.originalLead.braking || event.merger.braking;
      if (event.template !== 'normal-merge' && event.cueVisible && event.gapRecoveredAt == null) {
        return !simulation.lastInput.throttle || event.spaceCompressed || simulation.speed < 12;
      }
      if (necessaryFlow && event.gapRecoveredAt == null) return !simulation.lastInput.throttle || simulation.speed < 12;
      if (event.cueVisible && event.spaceCompressed && !simulation.lastInput.throttle) return true;
      return false;
    },

    recordStep: function (state, simulation, dt) {
      const event = simulation.currentEvent;
      if (!Scoring.isYieldExempt(simulation)) {
        let quality = Game.Scoring.speedQuality(simulation.speed, false);
        if (event && event.gapRecoveredAt != null) {
          const lead = currentLead(simulation, event);
          if (lead && simulation.player.v < lead.v - 2.5) quality = Math.min(quality, 0.35);
        }
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      } else {
        state.yieldExemptTime += dt;
      }

      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      if (event) event.unnecessaryBrakeCooldown = Math.max(0, event.unnecessaryBrakeCooldown - dt);
      const harsh = simulation.lastDeceleration > C.HARD_BRAKE && simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED;
      const preventable = event && (event.template === 'normal-merge' || !event.spaceCompressed ||
        event.responseType === 'late' || event.responseType === 'none' || event.earlyThrottleAfterMerge ||
        event.blockingAcceleration);
      if (harsh && preventable && state.hardBrakeCooldown <= 0) {
        state.hardBrakeDuration += dt;
        if (state.hardBrakeDuration >= 0.15) {
          state.hardBrakes += 1;
          state.hardBrakeDuration = 0;
          state.hardBrakeCooldown = 1.2;
          simulation.justHardBrake = true;
          if (event) event.hardBrakeRecorded = true;
        }
      } else if (!harsh) {
        state.hardBrakeDuration = 0;
      }

      if (event && event.template === 'normal-merge' && simulation.lastDeceleration > 1.7 &&
        !event.spaceCompressed && event.cueVisible && event.unnecessaryBrakeCooldown <= 0) {
        event.unnecessaryBrakeRecorded = true;
        event.unnecessaryBrakeCooldown = 1.4;
        state.unnecessaryBrakes += 1;
        simulation.justHardBrake = true;
      }
      if (event && event.blockingAcceleration && !event.blockingScored) {
        event.blockingScored = true;
        state.rushPenalties += 1;
      }
      if (event && event.earlyThrottleAfterMerge && !event.earlyThrottleScored) {
        event.earlyThrottleScored = true;
        state.earlyThrottlePenalties += 1;
      }

      const pedal = simulation.lastInput.brake ? 'brake' : (simulation.lastInput.throttle ? 'throttle' : 'coast');
      if (pedal !== 'coast' && state.lastPedal !== 'coast' && pedal !== state.lastPedal) state.pedalChanges += 1;
      if (pedal !== 'coast') state.lastPedal = pedal;
      state.pedalWindow += dt;
      if (state.pedalWindow >= 3) {
        if (state.pedalChanges >= 11 && simulation.speed > 15) state.pedalOscillations += 1;
        state.pedalWindow = 0;
        state.pedalChanges = 0;
      }
    },

    smoothScore: function (state) {
      return Math.max(0, 10 - state.hardBrakes * 2 - state.rushPenalties * 2 -
        state.earlyThrottlePenalties * 2 - state.unnecessaryBrakes * 2 - state.pedalOscillations);
    },

    summarize: function (simulation, timedOut) {
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(Scoring.eventSafe);
      const observation = resolved.reduce(function (sum, event) { return sum + Scoring.eventObservation(event); }, 0);
      const safety = Math.round(clean.length * 40 / 3);
      const state = simulation.scoring;
      const efficiency = state.efficiencyTime > 0 ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
      const smooth = Scoring.smoothScore(state);
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
        summaryKey = 'scene.cutIn.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }
      let adviceKey = 'scene.cutIn.result.advice.default';
      if (failed) adviceKey = 'scene.cutIn.result.advice.failed';
      else if (simulation.events.some(function (event) { return event.blockingAcceleration; })) adviceKey = 'scene.cutIn.result.advice.block';
      else if (simulation.events.some(function (event) { return event.earlyThrottleAfterMerge; })) adviceKey = 'scene.cutIn.result.advice.earlyThrottle';
      else if (observation < 28) adviceKey = 'scene.cutIn.result.advice.observation';
      else if (state.unnecessaryBrakes || state.hardBrakes) adviceKey = 'scene.cutIn.result.advice.smooth';
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
        earlySlowCount: simulation.events.filter(function (event) { return event.gapRecoveredAt != null; }).length,
        recoveredCount: simulation.events.filter(function (event) { return event.gapRecoveredAt != null; }).length,
        passedCount: clean.length,
        timedOut: Boolean(timedOut),
        failed: failed,
        yieldExemptTime: state.yieldExemptTime,
        adviceKey: adviceKey
      };
    }
  };

  function playerScreenX(simulation) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    return event && event.side === 'right' ? 135 : 225;
  }

  function screenX(simulation, worldX) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    const scale = C.LANE_PIXELS / (event ? event.laneWidth : 3.55);
    return playerScreenX(simulation) + worldX * scale;
  }

  function worldY(simulation, position) {
    return Draw.worldY(C, simulation, position);
  }

  function drawVehicle(ctx, simulation, vehicle, color, options) {
    options = options || {};
    const x = screenX(simulation, vehicle.x || 0);
    const y = worldY(simulation, vehicle.s);
    if (y < -60 || y > C.HEIGHT + 60) return;
    const width = Math.round(vehicle.width * 14);
    const length = Math.round(vehicle.length * C.PIXELS_PER_METER);
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(vehicle.yaw || 0);
    Draw.rect(ctx, '#10212a66', -width / 2 + 3, -length / 2 + 4, width, length);
    Draw.rect(ctx, '#14232b', -width / 2 - 2, -length / 2 + 5, 3, 8);
    Draw.rect(ctx, '#14232b', width / 2 - 1, -length / 2 + 5, 3, 8);
    Draw.rect(ctx, '#14232b', -width / 2 - 2, length / 2 - 12, 3, 8);
    Draw.rect(ctx, '#14232b', width / 2 - 1, length / 2 - 12, 3, 8);
    Draw.rect(ctx, color, -width / 2, -length / 2, width, length);
    Draw.rect(ctx, '#294651', -width / 2 + 3, -length / 2 + 8, width - 6, 8);
    Draw.rect(ctx, '#80b9c1', -width / 2 + 5, -length / 2 + 9, width - 10, 3);
    Draw.rect(ctx, '#1c343e', -width / 2 + 3, length / 2 - 14, width - 6, 8);
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
      const side = vehicle.vx >= 0 ? 1 : -1;
      Draw.rect(ctx, '#ffd166', side * (width / 2 - 3) - 2, -length / 2 + 3, 5, 5);
      Draw.rect(ctx, '#ffd166', side * (width / 2 - 3) - 2, length / 2 - 8, 5, 5);
    }
    ctx.restore();
  }

  function drawRoadDetails(ctx, simulation) {
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    if (!event) return;
    const y = worldY(simulation, event.decoration.signS);
    if (y > -30 && y < C.HEIGHT + 30) {
      const x = event.side === 'left' ? 316 : 28;
      Draw.rect(ctx, '#263c3d', x - 2, y, 4, 22);
      Draw.rect(ctx, '#d9cf9b', x - 16, y - 15, 32, 17);
      Draw.rect(ctx, '#4a6862', x - 13, y - 12, 26, 11);
      Draw.fillFittedText(ctx, '50', x - 10, y - 4, 20, 8, 'monospace');
    }
  }

  function drawHistory(ctx, simulation, event) {
    if (!event || event.history.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#80e0b188';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    event.history.forEach(function (sample, index) {
      const x = screenX(simulation, sample.mergerX);
      const y = worldY(simulation, sample.mergerS);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawSpaceHud(ctx, simulation) {
    const event = simulation.currentEvent;
    if (!event) return;
    const state = event.gapState || 'unstable';
    const labelKey = 'scene.cutIn.canvas.' + (state === 'over-yield' ? 'overYield' : (state === 'unstable' ? 'compressed' : state));
    Draw.rect(ctx, '#132633dd', 82, 599, 196, 26);
    const pattern = state === 'stable' ? '━━' : (state === 'recovering' ? '┄┄' : (state === 'over-yield' ? '┈┈' : '╱╱'));
    Draw.fillFittedText(ctx, pattern + ' ' + t(labelKey), 91, 616, 178, 9, 'sans-serif');
    if (event.cueVisible && event.fullyInLaneAt == null) {
      const left = event.side === 'left';
      Draw.rect(ctx, '#132633dd', left ? 10 : 278, 96, 72, 22);
      Draw.fillFittedText(ctx, (left ? '◀ ' : '▶ ') + t('scene.cutIn.canvas.' + event.side),
        left ? 17 : 285, 111, 58, 9, 'sans-serif');
    }
  }

  function drawFreeze(ctx, simulation) {
    const event = simulation.events[simulation.freezeInfo.eventId];
    Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
    const x = playerScreenX(simulation);
    Draw.rect(ctx, '#fff0b0', x + 22, C.CAR_Y - 32, 22, 24);
    Draw.rect(ctx, '#3b2a0e', x + 31, C.CAR_Y - 28, 4, 10);
    Draw.rect(ctx, '#3b2a0e', x + 31, C.CAR_Y - 15, 4, 4);
    ctx.save();
    ctx.strokeStyle = '#fff0a8';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(screenX(simulation, event.merger.x), worldY(simulation, event.merger.s));
    ctx.lineTo(x, C.CAR_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawWorld(ctx, simulation, demo) {
    Draw.drawEnvironment(ctx, simulation, C, 180);
    drawRoadDetails(ctx, simulation);
    const event = simulation.currentEvent || simulation.events[Math.min(simulation.eventIndex, simulation.events.length - 1)];
    if (!event) return;
    if (demo) drawHistory(ctx, simulation, event);
    drawVehicle(ctx, simulation, event.originalLead, event.originalLead.color, {});
    drawVehicle(ctx, simulation, event.merger, demo ? '#65d6a1' : event.merger.color, {});
    const player = Object.assign({}, simulation.player, { x: 0 });
    drawVehicle(ctx, simulation, player, demo ? '#65d6a1' : '#e7685b', { player: true });
    drawSpaceHud(ctx, simulation);
    if (demo) {
      Draw.rect(ctx, '#0e202ddd', 15, 548, 330, 37);
      Draw.fillFittedText(ctx, t(simulation.demoMode === 'space' ? 'scene.cutIn.replay.principles' : 'scene.cutIn.demo.principles'),
        24, 571, 312, 10, 'sans-serif');
    }
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        simulation.demo.demoMode = simulation.demoMode;
        drawWorld(ctx, simulation.demo, true);
      } else {
        drawWorld(ctx, simulation, false);
        if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
      }
    }
  };

  const Scene = {
    id: 'sudden-cut-in',
    Constants: C,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    MergerTrajectory: MergerTrajectory,
    LongitudinalController: LongitudinalController,
    Geometry: {
      createOBB: createOBB,
      obbIntersects: obbIntersects,
      obbClearance: obbClearance,
      frontGap: frontGap,
      lateralClearance: lateralClearance
    },
    createPlan: createPlan,
    validatePlan: validatePlan,
    trajectoryAt: evaluateTrajectory,
    currentLead: currentLead,
    assessSpace: assessSpace,
    predictMergeConflict: predictMergeConflict,
    predictRearConflict: predictRearConflict,
    defensiveInput: defensiveInput,
    ui: {
      progress: function (simulation) {
        return t('scene.cutIn.hud.progress', {
          resolved: simulation.events.filter(function (event) { return event.resolved; }).length
        });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.gapRecoveredAt != null; }).length,
          simulation.scoring.hardBrakes + simulation.scoring.unnecessaryBrakes,
          simulation.events.filter(Scoring.eventSafe).length
        ];
      },
      smoothScore: function (simulation) {
        return Scoring.smoothScore(simulation.scoring);
      },
      coach: function (simulation, displaySpeed) {
        const current = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
        const event = current.currentEvent;
        if (!event || !event.active) {
          return { text: t('scene.cutIn.hud.cruise'), status: t('hud.cruiseGood'), coachTone: '', tone: '' };
        }
        if (event.originalLead.braking || event.merger.braking) {
          return { text: t('scene.cutIn.hud.leadBrake'), status: t('scene.cutIn.status.recovering'), coachTone: 'risk', tone: 'warn' };
        }
        if (event.gapState === 'over-yield') {
          return { text: t('scene.cutIn.hud.overYield'), status: t('hud.tooSlow'), coachTone: 'risk', tone: 'warn' };
        }
        if (event.gapRecoveredAt != null && event.gapState === 'stable') {
          return { text: t('scene.cutIn.hud.stable'), status: t('scene.cutIn.status.stable'), coachTone: 'good', tone: '' };
        }
        if (event.spaceCompressed) {
          return { text: t('scene.cutIn.hud.compressed'), status: t('scene.cutIn.status.compressed'), coachTone: 'risk', tone: 'warn' };
        }
        if (event.cueVisible) {
          return {
            text: t(event.side === 'left' ? 'scene.cutIn.hud.cueLeft' : 'scene.cutIn.hud.cueRight'),
            status: t('scene.cutIn.status.recovering'),
            coachTone: 'risk', tone: ''
          };
        }
        return {
          text: t('scene.cutIn.hud.cruise'),
          status: t(displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : (displaySpeed < 40 ? 'hud.speedUp' : 'hud.nearLimit')),
          coachTone: '', tone: displaySpeed > 55 ? 'warn' : ''
        };
      },
      retryToast: function () {
        return { key: 'scene.cutIn.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const score = Scoring.eventObservation(event);
        return {
          key: score === 10 ? 'scene.cutIn.toast.safe' : 'scene.cutIn.toast.improve',
          params: { score: score },
          neutral: score !== 10
        };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.cutIn.failure.' + (info.reason === 'blocking' ? 'block' : info.reason), {
          side: t('scene.cutIn.canvas.' + info.side),
          speed: Math.round(info.speed),
          gap: Math.max(0, info.gap).toFixed(1),
          minGap: isFinite(info.minFrontGap) ? Math.max(0, info.minFrontGap).toFixed(1) : '--',
          cue: info.firstCueVisibleAt == null ? '--' : info.firstCueVisibleAt.toFixed(1),
          response: info.firstResponseAt == null ? '--' : info.firstResponseAt.toFixed(1)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo && demo.events[simulation.demoEventId];
        if (!event) return { step: '', substep: '' };
        if (simulation.demoMode === 'space') {
          return { step: t('scene.cutIn.replay.title'), substep: t('scene.cutIn.replay.subtitle') };
        }
        if (event.originalLead.braking || event.merger.braking) {
          return { step: t('scene.cutIn.demo.secondYield'), substep: t('scene.cutIn.demo.secondYieldSub') };
        }
        if (event.gapRecoveredAt != null) {
          return { step: t('scene.cutIn.demo.resume'), substep: t('scene.cutIn.demo.resumeSub') };
        }
        if (event.cueVisible) {
          return { step: t('scene.cutIn.demo.yield'), substep: t('scene.cutIn.demo.yieldSub') };
        }
        return { step: t('scene.cutIn.demo.observe'), substep: t('scene.cutIn.demo.observeSub') };
      },
      updateControls: function (doc, simulation) {
        const replay = simulation.status === 'demonstrating' && simulation.demoMode === 'space';
        const badge = doc.querySelector('#demo-screen .demo-badge');
        const skip = doc.getElementById('skip-demo-button');
        if (badge) badge.textContent = t(replay ? 'scene.cutIn.replay.badge' : 'game.demoBadge');
        if (skip) skip.textContent = t(replay ? 'scene.cutIn.replay.skip' : 'game.skipDemo');
        const proceed = doc.getElementById('demo-proceed-button');
        if (proceed) proceed.hidden = true;
      }
    }
  };

  Scenes[Scene.id] = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
