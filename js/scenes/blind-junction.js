(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const M = Game.Model;
  const Draw = Game.Draw;

  function t(key, params) {
    return Game.I18N.t(key, params);
  }

  // 纵向以米计，横向以 Canvas 像素计；LOS 计算时统一换算为像素。
  const C = Object.assign({}, Game.C, {
    EVENT_POSITIONS: [130, 330, 530],
    SIDE_ROAD_HALF_WIDTH_M: 4.4,
    ACTOR_START_OFFSET: 40,
    ACTOR_CLEAR_LEFT_X: 108,
    ACTOR_CLEAR_RIGHT_X: 312,
    ACTOR_TIME_LEAD: 0.35,
    DECISION_BUFFER: 17,
    LATE_BUFFER: 6,
    RISK_BUFFER: 12,
    APPROACH_BUFFER: 26,
    RISK_END: 6,
    FINISH_BUFFER: 24,
    LATERAL_SHIFT_PIXELS: 6,
    LATERAL_HOLD_TIME: 0.6,
    SAFETY_BUFFER_M: 3,
    MIN_SAFE_SPEED: 6,
    MAX_TEACH_SPEED: 26,
    YIELD_ZONE_NEAR: 0.5,
    YIELD_ZONE_FAR: 18
  });

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

  // Slab/Liang-Barsky，与车缝关使用相同的几何判定规则。
  function segmentIntersectsAABB(start, end, rect, epsilon) {
    const eps = epsilon == null ? 0.000001 : epsilon;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let near = 0;
    let far = 1;
    const axes = [
      { origin: start.x, delta: dx, min: rect.left, max: rect.right },
      { origin: start.y, delta: dy, min: rect.bottom, max: rect.top }
    ];
    for (let index = 0; index < axes.length; index += 1) {
      const axis = axes[index];
      if (Math.abs(axis.delta) <= eps) {
        if (axis.origin < axis.min - eps || axis.origin > axis.max + eps) return false;
        continue;
      }
      let a = (axis.min - axis.origin) / axis.delta;
      let b = (axis.max - axis.origin) / axis.delta;
      if (a > b) { const swap = a; a = b; b = swap; }
      near = Math.max(near, a);
      far = Math.min(far, b);
      if (near > far + eps) return false;
    }
    return far >= -eps && near <= 1 + eps;
  }

  function pointVisible(event, eyeX, eyeDistance, targetX, targetPosition) {
    const scale = C.PIXELS_PER_METER;
    const eye = { x: eyeX, y: (eyeDistance + 0.8) * scale };
    const target = { x: targetX, y: targetPosition * scale };
    for (let index = 0; index < event.occluders.length; index += 1) {
      const source = event.occluders[index];
      const rect = {
        left: source.left,
        right: source.right,
        bottom: source.bottom * scale,
        top: source.top * scale
      };
      if (segmentIntersectsAABB(eye, target, rect, 0.000001)) {
        return { visible: false, occluderId: source.id };
      }
    }
    return { visible: true, occluderId: null };
  }

  function visibilityFor(simulation, event) {
    const actor = event.actor;
    if (!event.occupied || !actor || !actor.active || actor.cleared) {
      return { visible: false, occluderId: null };
    }
    return pointVisible(event, simulation.x, simulation.distance, actor.x, actor.y);
  }

  // 从当前接近位置向路口扫描，返回潜在出口首次可见时车头到冲突区的距离。
  function firstVisibleDistanceFor(event, x, distance) {
    const remaining = event.position - (distance + C.CAR_LENGTH_M / 2);
    if (remaining <= 0) return 0;
    if (pointVisible(event, x, distance, event.startX, event.position).visible) return remaining;
    for (let travelled = 0.5; travelled < remaining; travelled += 0.5) {
      if (pointVisible(event, x, distance + travelled, event.startX, event.position).visible) {
        return Math.max(0, remaining - travelled);
      }
    }
    return 0;
  }

  function safeSpeedFor(event, x) {
    // 只取决于出口几何和车道位置，不读取无人、行人或电动车的事件类型。
    const revealDistance = firstVisibleDistanceFor(event, x, event.position - 90);
    const available = Math.max(0.5, revealDistance - C.SAFETY_BUFFER_M);
    const brake = C.COMFORTABLE_BRAKE;
    const reaction = C.REACTION_TIME;
    const speedMps = -brake * reaction + Math.sqrt(
      brake * reaction * brake * reaction + 2 * brake * available
    );
    return M.clamp(speedMps * 3.6, C.MIN_SAFE_SPEED, C.MAX_TEACH_SPEED);
  }

  function createPlan(seed) {
    const layoutRandom = M.mulberry32(M.hashSeed('junction-layout:' + seed));
    const paintRandom = M.mulberry32(M.hashSeed('junction-paint:' + seed));
    const directions = shuffle([-1, 1, layoutRandom() < 0.5 ? -1 : 1], layoutRandom);
    const kinds = shuffle(['empty', 'pedestrian', 'ebike'], layoutRandom);
    const coats = ['#f4d35e', '#ee6c72', '#7fd1ed'];

    const events = C.EVENT_POSITIONS.map(function (basePosition, id) {
      const position = basePosition + (layoutRandom() - 0.5) * 10;
      const direction = directions[id];
      const kind = kinds[id];
      const template = Math.floor(layoutRandom() * 3);
      const startX = C.CAR_X - direction * C.ACTOR_START_OFFSET;
      const bottom = position - (14 + layoutRandom() * 5);
      const top = position - (3.2 + layoutRandom() * 1.4);
      let left;
      let right;
      if (direction < 0) {
        left = template === 2 ? 242 : (template === 1 ? 238 : 242);
        right = template === 0 ? 356 : (template === 1 ? 340 : 286);
      } else {
        left = template === 0 ? 4 : (template === 1 ? 20 : 74);
        right = template === 2 ? 174 : (template === 1 ? 178 : 174);
      }
      const occluder = Object.freeze({
        id: id + '-corner',
        type: template === 0 ? 'wall' : (template === 1 ? 'hedge' : 'truck'),
        left: left,
        right: right,
        bottom: bottom,
        top: top,
        color: ['#d7a84b', '#648db5', '#a7a9a2'][Math.floor(paintRandom() * 3)]
      });
      const maxSpeed = kind === 'pedestrian'
        ? 1.4 + layoutRandom() * 0.8
        : 4 + layoutRandom() * 3;
      const event = {
        id: id,
        position: position,
        direction: direction,
        exitSide: direction > 0 ? 'left' : 'right',
        kind: kind,
        occupied: kind !== 'empty',
        startX: startX,
        clearX: direction > 0 ? C.ACTOR_CLEAR_RIGHT_X : C.ACTOR_CLEAR_LEFT_X,
        maxSpeed: maxSpeed,
        initialSpeed: kind === 'ebike' ? 2.2 + layoutRandom() * 0.6 : maxSpeed,
        acceleration: kind === 'ebike' ? 0.9 + layoutRandom() * 0.5 : 0,
        coatColor: coats[Math.floor(paintRandom() * coats.length)],
        skinColor: paintRandom() > 0.5 ? '#efb489' : '#c88760',
        bikeColor: ['#e7b84d', '#65b8c7', '#d87363'][Math.floor(paintRandom() * 3)],
        occluders: Object.freeze([occluder])
      };
      event.nominalRevealDistance = firstVisibleDistanceFor(event, C.CAR_X, position - 90);
      event.slowCheck = M.clamp(event.nominalRevealDistance + C.DECISION_BUFFER, 24, 36);
      event.lateCheck = Math.max(9, Math.min(event.slowCheck - 8, event.nominalRevealDistance + C.LATE_BUFFER));
      event.riskStart = event.slowCheck + C.RISK_BUFFER;
      event.approachStart = event.riskStart + C.APPROACH_BUFFER;
      event.nominalSafeSpeed = safeSpeedFor(event, C.CAR_X);
      return Object.freeze(event);
    });

    return Object.freeze({ events: Object.freeze(events) });
  }

  function createRuntimeEvent(plan) {
    const event = Object.assign({}, plan);
    event.resolved = false;
    event.attempts = 0;
    event.failed = false;
    resetEventRuntime(event);
    return event;
  }

  function resetEventRuntime(event) {
    event.recordedDecision = false;
    event.recordedLate = false;
    event.speedAtDecision = null;
    event.speedAtLate = null;
    event.referenceSafeSpeed = null;
    event.maxSpeedAfterDecision = 0;
    event.minSpeedInRisk = Infinity;
    event.maxLateralShift = 0;
    event.lateralTime = 0;
    event.earlySlow = false;
    event.lateSlow = false;
    event.earlyLateral = false;
    event.firstVisibleDistance = null;
    event.firstVisibleSpeed = null;
    event.firstVisibleActorSpeed = null;
    event.actor = {
      state: event.occupied ? 'waiting' : 'empty',
      active: false,
      x: event.startX,
      y: event.position,
      speed: event.initialSpeed,
      visible: false,
      cleared: false,
      occluderId: null
    };
  }

  function actorTravelTime(actor, targetX, event) {
    const distanceM = Math.abs(targetX - actor.x) / C.PIXELS_PER_METER;
    if (distanceM <= 0.0001) return 0;
    const velocity = actor.speed;
    if (event.acceleration <= 0 || velocity >= event.maxSpeed) return distanceM / event.maxSpeed;
    const accelerationTime = (event.maxSpeed - velocity) / event.acceleration;
    const accelerationDistance = velocity * accelerationTime +
      0.5 * event.acceleration * accelerationTime * accelerationTime;
    if (distanceM <= accelerationDistance) {
      return (-velocity + Math.sqrt(velocity * velocity + 2 * event.acceleration * distanceM)) /
        event.acceleration;
    }
    return accelerationTime + (distanceM - accelerationDistance) / event.maxSpeed;
  }

  function actorBlocking(simulation, event) {
    if (!event || !event.occupied || !event.actor.active || event.actor.cleared) return false;
    const actor = event.actor;
    // 对象完全驶过本车走廊后不再要求等待，也不继续提供效率豁免。
    return event.direction < 0 ? actor.x > simulation.x - 20 : actor.x < simulation.x + 20;
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    let target = 47;
    let left = false;
    let right = false;
    if (event) {
      const remaining = event.position - simulation.distance;
      if (remaining <= event.approachStart && simulation.distance <= event.position + C.RISK_END) {
        target = Scoring.targetSpeed(simulation, event);
        left = event.direction < 0;
        right = event.direction > 0;
      }
      const bumperRemaining = event.position - (simulation.distance + C.CAR_LENGTH_M / 2);
      if (event.actor.visible && actorBlocking(simulation, event) &&
        bumperRemaining < C.YIELD_ZONE_FAR && bumperRemaining > -1) {
        target = 0;
      }
    }
    return {
      throttle: simulation.speed < target - 0.35,
      brake: simulation.speed > target + 0.35,
      left: left,
      right: right
    };
  }

  class Simulation {
    constructor(seed) {
      this.seed = seed;
      this.plan = createPlan(seed);
      this.events = this.plan.events.map(createRuntimeEvent);
      this.distance = 0;
      this.speed = C.START_SPEED;
      this.previousSpeed = this.speed;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.x = C.CAR_X;
      this.elapsed = 0;
      this.status = 'ready';
      this.scoring = Game.Scoring.createState();
      this.justHardBrake = false;
      this.justResolved = null;
      this.freezeInfo = null;
      this.demo = null;
      this.demoTime = 0;
      this.demoEventId = null;
      this.retryCount = 0;
      this.necessaryBraking = false;
    }

    start() {
      this.status = 'driving';
    }

    get currentEvent() {
      return this.events.find(function (event) { return !event.resolved; }) || null;
    }

    get finishDistance() {
      return this.events[this.events.length - 1].position + C.FINISH_BUFFER;
    }

    getRiskEvent() {
      return Scoring.getRiskEvent(this);
    }

    updateVisibility(event) {
      if (!event.occupied || !event.actor.active || event.actor.cleared) return;
      const visibility = visibilityFor(this, event);
      const actor = event.actor;
      actor.visible = visibility.visible;
      actor.occluderId = visibility.occluderId;
      if (visibility.visible && event.firstVisibleDistance == null) {
        event.firstVisibleDistance = Math.max(0, event.position - (this.distance + C.CAR_LENGTH_M / 2));
        event.firstVisibleSpeed = this.speed;
        event.firstVisibleActorSpeed = actor.speed;
      }
    }

    step(input, dt) {
      if (this.status !== 'driving') return;
      dt = Math.min(dt, 0.05);
      if (dt <= 0) return;
      input = input || {};
      this.justHardBrake = false;
      this.justResolved = null;
      this.previousSpeed = this.speed;

      const approachingEvent = this.currentEvent;
      const remaining = approachingEvent ? approachingEvent.position - this.distance : Infinity;
      const activeActor = approachingEvent && approachingEvent.occupied && approachingEvent.actor.active;
      const emergencyBrake = activeActor && this.speed > C.HARD_BRAKE_MIN_SPEED &&
        remaining < 16 && remaining > -2;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = -(emergencyBrake ? C.EMERGENCY_BRAKE_DECELERATION : C.BRAKE_DECELERATION);
      this.acceleration = acceleration;

      const oldSpeedMps = this.speed / 3.6;
      let nextSpeedMps = M.clamp(oldSpeedMps + acceleration * dt, 0, C.MAX_SPEED / 3.6);
      if (!input.throttle && !input.brake && this.speed < 1) nextSpeedMps = 0;
      this.speed = nextSpeedMps * 3.6;
      this.lastDeceleration = Math.max(0, (oldSpeedMps - nextSpeedMps) / dt);
      this.distance += (oldSpeedMps + nextSpeedMps) * 0.5 * dt;
      this.elapsed += dt;

      if (this.speed > 0.5) {
        const steering = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        this.x = M.clamp(this.x + steering * C.STEER_SPEED * dt, C.CAR_MIN_X, C.CAR_MAX_X);
      }

      const event = this.currentEvent;
      this.necessaryBraking = Boolean(event && input.brake && event.recordedDecision &&
        event.referenceSafeSpeed != null && this.previousSpeed <= event.referenceSafeSpeed + 2 &&
        event.actor.visible && actorBlocking(this, event) && remaining < C.YIELD_ZONE_FAR);
      if (event) {
        this.updateEvent(event, dt);
        Scoring.recordStep(this.scoring, this, dt);
        if (event.occupied && !event.resolved && this.predictConflict(event, input)) {
          this.freeze(event);
          return;
        }
        if (!event.resolved && this.distance > event.position + C.RISK_END) {
          this.resolveEvent(event);
        }
      } else {
        this.necessaryBraking = false;
        Scoring.recordStep(this.scoring, this, dt);
      }

      if (this.distance >= this.finishDistance) {
        this.distance = this.finishDistance;
        this.speed = 0;
        this.status = 'complete';
      } else if (this.elapsed >= C.MAX_TIME) {
        this.speed = 0;
        this.status = 'timeout';
      }
    }

    updateEvent(event, dt) {
      const distanceToEvent = event.position - this.distance;
      if (distanceToEvent <= event.riskStart && this.distance <= event.position + C.RISK_END) {
        event.minSpeedInRisk = Math.min(event.minSpeedInRisk, this.speed);
        if (event.recordedDecision && distanceToEvent > 0) {
          event.maxSpeedAfterDecision = Math.max(event.maxSpeedAfterDecision, this.speed);
        }
        const preferredOffset = (this.x - C.CAR_X) * event.direction;
        event.maxLateralShift = Math.max(event.maxLateralShift, preferredOffset);
        if (distanceToEvent > event.lateCheck && preferredOffset >= C.LATERAL_SHIFT_PIXELS) {
          event.lateralTime += dt;
          if (event.lateralTime >= C.LATERAL_HOLD_TIME) event.earlyLateral = true;
        }
      }
      if (!event.recordedDecision && distanceToEvent <= event.slowCheck) {
        event.recordedDecision = true;
        event.speedAtDecision = this.speed;
        event.referenceSafeSpeed = safeSpeedFor(event, this.x);
        event.maxSpeedAfterDecision = Math.max(event.maxSpeedAfterDecision, this.speed);
      }
      if (!event.recordedLate && distanceToEvent <= event.lateCheck) {
        event.recordedLate = true;
        event.speedAtLate = this.speed;
      }

      if (!event.occupied || event.resolved) return;
      const actor = event.actor;
      if (actor.state === 'waiting') {
        const frontRemaining = event.position - (this.distance + C.CAR_LENGTH_M / 2);
        const playerSpeed = this.speed / 3.6;
        if (frontRemaining >= -0.5 && playerSpeed > 0.5) {
          const playerEta = Math.max(0, frontRemaining) / playerSpeed;
          const actorEta = actorTravelTime(actor, this.x, event);
          if (playerEta <= actorEta + C.ACTOR_TIME_LEAD) {
            actor.state = 'crossing';
            actor.active = true;
          }
        }
      }
      if (actor.active && !actor.cleared) {
        actor.speed = Math.min(event.maxSpeed, actor.speed + event.acceleration * dt);
        actor.x += event.direction * actor.speed * C.PIXELS_PER_METER * dt;
        const cleared = event.direction > 0 ? actor.x >= event.clearX : actor.x <= event.clearX;
        if (cleared) {
          actor.state = 'cleared';
          actor.cleared = true;
          actor.active = false;
          actor.visible = false;
          actor.occluderId = null;
        }
      }
      this.updateVisibility(event);
    }

    // 外推本帧真实输入与对象加速度，在实际接触前定格；充分制动能停住时不误罚。
    predictConflict(event, input) {
      const actor = event.actor;
      if (!event.occupied || !actor.active || actor.cleared || this.speed < 0.5) return false;
      const speedMps = this.speed / 3.6;
      const horizon = Math.max(0.8, Math.min(2.2, speedMps * 0.18));
      const substep = 0.025;
      const halfWidth = 14;
      const actorHalfWidth = event.kind === 'ebike' ? 7 : 3;
      const halfLength = C.CAR_LENGTH_M / 2;
      let distance = this.distance;
      let velocity = speedMps;
      let actorX = actor.x;
      let actorSpeed = actor.speed;
      let acceleration = -C.NATURAL_DECELERATION;
      if (input.throttle) acceleration = C.ACCELERATION;
      if (input.brake) acceleration = this.acceleration;

      for (let time = 0; time < horizon - 0.000001; time += substep) {
        const slice = Math.min(substep, horizon - time);
        const nextVelocity = M.clamp(velocity + acceleration * slice, 0, C.MAX_SPEED / 3.6);
        const nextDistance = distance + (velocity + nextVelocity) * 0.5 * slice;
        actorSpeed = Math.min(event.maxSpeed, actorSpeed + event.acceleration * slice);
        const nextActorX = actorX + event.direction * actorSpeed * C.PIXELS_PER_METER * slice;
        const carLeft = this.x - halfWidth;
        const carRight = this.x + halfWidth;
        const actorLeft = Math.min(actorX, nextActorX) - actorHalfWidth;
        const actorRight = Math.max(actorX, nextActorX) + actorHalfWidth;
        const horizontal = actorRight > carLeft && actorLeft < carRight;
        const front = nextDistance + halfLength + 0.25;
        const rear = distance - halfLength - 0.25;
        const vertical = event.position < front && event.position > rear;
        if (horizontal && vertical) return true;
        distance = nextDistance;
        velocity = nextVelocity;
        actorX = nextActorX;
        if (velocity <= 0) break;
      }
      return false;
    }

    freeze(event) {
      event.failed = true;
      event.attempts += 1;
      this.retryCount += 1;
      this.status = 'frozen';
      const visibility = visibilityFor(this, event);
      this.freezeInfo = {
        eventId: event.id,
        kind: event.kind,
        speed: this.speed,
        remaining: Math.max(0, event.position - (this.distance + C.CAR_LENGTH_M / 2)),
        stoppingDistance: M.stoppingDistance(this.speed),
        firstVisibleDistance: event.firstVisibleDistance,
        firstVisibleSpeed: event.firstVisibleSpeed,
        occluderId: visibility.occluderId
      };
    }

    resolveEvent(event) {
      event.resolved = true;
      event.earlySlow = event.speedAtDecision != null && event.referenceSafeSpeed != null &&
        event.speedAtDecision <= event.referenceSafeSpeed + 2 &&
        event.maxSpeedAfterDecision <= event.referenceSafeSpeed + 6;
      event.lateSlow = !event.earlySlow && event.speedAtLate != null &&
        event.referenceSafeSpeed != null && event.speedAtLate <= event.referenceSafeSpeed + 6;
      this.justResolved = event;
    }

    retryEvent() {
      const event = this.events[this.freezeInfo ? this.freezeInfo.eventId : (this.demoEventId || 0)];
      if (!event) return;
      this.distance = Math.max(0, event.position - event.approachStart);
      this.speed = 30;
      this.previousSpeed = 30;
      this.lastDeceleration = 0;
      this.acceleration = 0;
      this.x = C.CAR_X;
      this.necessaryBraking = false;
      resetEventRuntime(event);
      this.freezeInfo = null;
      this.demo = null;
      this.demoEventId = null;
      this.demoTime = 0;
      this.justResolved = null;
      this.status = 'driving';
    }

    startDemo() {
      if (!this.freezeInfo) return;
      const eventId = this.freezeInfo.eventId;
      const demo = new Simulation(this.seed);
      for (let index = 0; index < eventId; index += 1) {
        demo.events[index].resolved = true;
        demo.events[index].earlySlow = true;
        demo.events[index].earlyLateral = true;
      }
      const event = demo.events[eventId];
      demo.distance = Math.max(0, event.position - event.approachStart);
      demo.speed = 45;
      demo.previousSpeed = 45;
      demo.status = 'driving';
      this.demo = demo;
      this.demoEventId = eventId;
      this.demoTime = 0;
      this.status = 'demonstrating';
    }

    stepDemo(dt) {
      if (this.status !== 'demonstrating' || !this.demo) return;
      this.demoTime += dt;
      const demo = this.demo;
      const event = demo.events[this.demoEventId];
      demo.step(defensiveInput(demo), dt);
      if (demo.status === 'frozen' || demo.status === 'timeout' ||
        (event.resolved && demo.distance > event.position + 8) || this.demoTime >= 30) {
        this.retryEvent();
      }
    }
  }

  const Scoring = {
    getRiskEvent: function (simulation) {
      return simulation.events.find(function (event) {
        return !event.resolved && simulation.distance >= event.position - event.riskStart &&
          simulation.distance <= event.position + C.RISK_END;
      }) || null;
    },

    targetSpeed: function (simulation, event) {
      if (event.referenceSafeSpeed != null) return event.referenceSafeSpeed;
      return safeSpeedFor(event, simulation.x);
    },

    riskSpeedQuality: function (speed, target) {
      const fullLow = Math.max(7, target * 0.72);
      const fullHigh = target + 2;
      if (speed < 4 || speed > target + 12) return 0;
      if (speed < fullLow) return (speed - 4) / Math.max(1, fullLow - 4);
      if (speed <= fullHigh) return 1;
      return (target + 12 - speed) / 10;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || simulation.speed >= 1.2 || !actorBlocking(simulation, event)) return false;
      const remaining = event.position - (simulation.distance + C.CAR_LENGTH_M / 2);
      return remaining >= C.YIELD_ZONE_NEAR && remaining <= C.YIELD_ZONE_FAR;
    },

    recordStep: function (state, simulation, dt) {
      const event = Scoring.getRiskEvent(simulation);
      const exempt = Scoring.isYieldExempt(simulation);
      if (!exempt) {
        const quality = event
          ? Scoring.riskSpeedQuality(simulation.speed, Scoring.targetSpeed(simulation, event))
          : Game.Scoring.speedQuality(simulation.speed, false);
        state.efficiencyIntegral += quality * dt;
        state.efficiencyTime += dt;
      }
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      const harsh = simulation.lastDeceleration > C.HARD_BRAKE &&
        simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED && !simulation.necessaryBraking;
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

    eventObservation: function (event) {
      const speedScore = event.earlySlow ? 8 : (event.lateSlow ? 4 : 0);
      return speedScore + (event.earlyLateral ? 2 : 0);
    },

    summarize: function (simulation, timedOut) {
      const state = simulation.scoring;
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(function (event) { return !event.failed; });
      const observation = simulation.events.reduce(function (sum, event) {
        return sum + (event.resolved ? Scoring.eventObservation(event) : 0);
      }, 0);
      const safety = Math.round(clean.length * (40 / 3));
      const efficiency = state.efficiencyTime > 0
        ? 20 * state.efficiencyIntegral / state.efficiencyTime : 0;
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
        summaryKey = 'scene.blindJunction.result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B';
        titleKey = 'result.title.b';
        summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout';
        summaryKey = 'result.summary.timeout';
      }

      const earlySlowCount = simulation.events.filter(function (event) { return event.earlySlow; }).length;
      let adviceKey = 'scene.blindJunction.result.advice.default';
      if (failed) adviceKey = 'scene.blindJunction.result.advice.failed';
      else if (earlySlowCount < 3) adviceKey = 'scene.blindJunction.result.advice.early';
      else if (state.hardBrakes > 0) adviceKey = 'result.advice.braking';
      else if (timedOut || efficiency < 12) adviceKey = 'scene.blindJunction.result.advice.efficiency';
      else if (observation < 28) adviceKey = 'scene.blindJunction.result.advice.observation';

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
        earlySlowCount: earlySlowCount,
        passedCount: clean.length,
        timedOut: Boolean(timedOut),
        failed: failed,
        adviceKey: adviceKey
      };
    }
  };

  function worldY(simulation, worldPosition) {
    return Draw.worldY(C, simulation, worldPosition);
  }

  function drawJunction(ctx, simulation, event) {
    const y = worldY(simulation, event.position);
    const halfHeight = C.SIDE_ROAD_HALF_WIDTH_M * C.PIXELS_PER_METER;
    if (y + halfHeight < -20 || y - halfHeight > C.HEIGHT + 20) return;
    Draw.rect(ctx, '#a6a895', 0, y - halfHeight - 6, C.WIDTH, 6);
    Draw.rect(ctx, '#a6a895', 0, y + halfHeight, C.WIDTH, 6);
    Draw.rect(ctx, '#3b484b', 0, y - halfHeight, C.WIDTH, halfHeight * 2);
    Draw.rect(ctx, '#334145', 0, y - halfHeight, C.WIDTH, 2);
    Draw.rect(ctx, '#334145', 0, y + halfHeight - 2, C.WIDTH, 2);
    for (let x = 8; x < C.WIDTH; x += 30) {
      if (x > 158 && x < 188) continue;
      Draw.rect(ctx, '#526064', x, y - 1, 15, 2);
    }

    const top = worldY(simulation, event.position + C.RISK_END);
    const bottom = worldY(simulation, event.position - event.riskStart);
    ctx.save();
    ctx.globalAlpha = 0.1;
    Draw.rect(ctx, '#f4c75b', 178, Math.max(0, top), 62,
      Math.min(C.HEIGHT, bottom) - Math.max(0, top));
    ctx.restore();

    const markerY = worldY(simulation, event.position - event.slowCheck);
    if (markerY > 105 && markerY < C.HEIGHT - 20) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ffe292';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(178, markerY);
      ctx.lineTo(240, markerY);
      ctx.stroke();
      ctx.restore();
      Draw.rect(ctx, '#142630dd', 174, markerY - 14, 70, 12);
      ctx.fillStyle = '#ffe6a4';
      Draw.fillFittedText(ctx, t('scene.blindJunction.canvas.slowMarker'), 178, markerY - 5, 62, 8, 'sans-serif');
    }

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#ffd778';
    ctx.lineWidth = 2;
    ctx.strokeRect(180, y - 12, 58, 24);
    ctx.restore();
  }

  function drawOccluder(ctx, simulation, rect) {
    const top = worldY(simulation, rect.top);
    const bottom = worldY(simulation, rect.bottom);
    const height = bottom - top;
    if (bottom < -20 || top > C.HEIGHT + 20) return;
    if (rect.type === 'hedge') {
      Draw.rect(ctx, '#1d3c34', rect.left - 2, top + 3, rect.right - rect.left + 4, height);
      Draw.rect(ctx, '#39704a', rect.left, top, rect.right - rect.left, height - 3);
      for (let y = top + 5; y < bottom - 5; y += 12) {
        for (let x = rect.left + 5; x < rect.right - 4; x += 14) {
          Draw.rect(ctx, ((x + y) % 3) ? '#4d8756' : '#65955f', x, y, 6, 5);
        }
      }
    } else if (rect.type === 'truck') {
      const center = (rect.left + rect.right) / 2;
      Draw.rect(ctx, '#10232b55', rect.left + 4, top + 4, rect.right - rect.left, height);
      Draw.rect(ctx, '#d8d5bd', rect.left, top + 12, rect.right - rect.left, height - 12);
      Draw.rect(ctx, rect.color, rect.left, top, rect.right - rect.left, 18);
      Draw.rect(ctx, '#294651', rect.left + 5, top + 4, rect.right - rect.left - 10, 7);
      Draw.rect(ctx, '#8d9686', rect.left + 4, top + 25, rect.right - rect.left - 8, 3);
      Draw.rect(ctx, '#8d9686', rect.left + 4, bottom - 12, rect.right - rect.left - 8, 3);
      Draw.rect(ctx, '#14232b', rect.left - 3, top + 14, 3, 12);
      Draw.rect(ctx, '#14232b', rect.right, top + 14, 3, 12);
      Draw.rect(ctx, '#14232b', rect.left - 3, bottom - 18, 3, 12);
      Draw.rect(ctx, '#14232b', rect.right, bottom - 18, 3, 12);
      Draw.rect(ctx, '#c7c4ad', center - 1, top + 30, 2, Math.max(0, height - 46));
    } else {
      Draw.rect(ctx, '#303e44', rect.left - 3, top + 4, rect.right - rect.left + 6, height);
      Draw.rect(ctx, '#68736f', rect.left, top, rect.right - rect.left, height - 3);
      for (let y = top + 8; y < bottom - 4; y += 12) {
        Draw.rect(ctx, '#515f5d', rect.left, y, rect.right - rect.left, 2);
        for (let x = rect.left + ((Math.round(y) % 24) ? 8 : 20); x < rect.right; x += 28) {
          Draw.rect(ctx, '#515f5d', x, y - 7, 2, 7);
        }
      }
      Draw.rect(ctx, '#899087', rect.left, top, rect.right - rect.left, 4);
    }
  }

  function drawEbike(ctx, x, y, event, hidden, demo) {
    ctx.save();
    if (hidden) ctx.globalAlpha = 0.42;
    Draw.rect(ctx, '#10232b55', x - 10, y + 4, 23, 5);
    Draw.rect(ctx, '#14232b', x - 11, y - 4, 4, 9);
    Draw.rect(ctx, '#14232b', x + 8, y - 4, 4, 9);
    Draw.rect(ctx, demo ? '#65d6a1' : event.bikeColor, x - 7, y - 2, 15, 4);
    Draw.rect(ctx, '#d7d9c8', x + 4, y - 5, 2, 6);
    Draw.rect(ctx, demo ? '#80e0b1' : event.coatColor, x - 3, y - 7, 7, 7);
    Draw.rect(ctx, event.skinColor, x - 2, y - 11, 5, 4);
    Draw.rect(ctx, '#f0cf55', x - 3, y - 13, 7, 3);
    ctx.restore();
  }

  function drawActor(ctx, simulation, event, demo, xray) {
    if (!event.occupied) return;
    const actor = event.actor;
    if (!actor.active || actor.cleared) return;
    const visibility = xray ? { visible: actor.visible } : visibilityFor(simulation, event);
    if (!visibility.visible && !xray) return;
    const y = worldY(simulation, actor.y);
    if (y < -25 || y > C.HEIGHT + 25) return;
    const hidden = xray && !visibility.visible;
    if (event.kind === 'ebike') drawEbike(ctx, actor.x, y, event, hidden, demo);
    else Draw.drawPedestrian(ctx, C, actor.x, y, event, hidden, demo);
  }

  function drawDemoGuide(ctx, simulation) {
    const event = simulation.currentEvent;
    if (!event) return;
    const remaining = event.position - simulation.distance;
    if (remaining > event.approachStart || remaining < -C.RISK_END) return;
    const targetY = worldY(simulation, event.position);
    ctx.save();
    ctx.strokeStyle = '#a6f0c8';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(simulation.x, C.CAR_Y - 5);
    ctx.lineTo(event.startX, targetY);
    ctx.stroke();
    ctx.restore();
    const target = Scoring.targetSpeed(simulation, event);
    Draw.rect(ctx, '#0e202ddd', 194, 548, 150, 51);
    ctx.fillStyle = '#a6f0c8';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(Math.round(simulation.speed) + ' km/h', 202, 571);
    ctx.fillStyle = '#d4e3db';
    Draw.fillFittedText(ctx, t('scene.blindJunction.canvas.speedEnvelope', { speed: Math.round(target) }),
      202, 589, 134, 9, 'sans-serif');
  }

  function drawWorld(ctx, simulation, demo) {
    Draw.drawEnvironment(ctx, simulation, C, 172);
    simulation.events.forEach(function (event) { drawJunction(ctx, simulation, event); });
    simulation.events.forEach(function (event) { drawActor(ctx, simulation, event, demo, false); });
    simulation.events.forEach(function (event) {
      event.occluders.forEach(function (rect) { drawOccluder(ctx, simulation, rect); });
    });
    Draw.drawCar(ctx, simulation.x, C.CAR_Y, demo ? '#65d6a1' : '#e7685b', demo);
    if (demo) drawDemoGuide(ctx, simulation);
  }

  function drawFreeze(ctx, simulation) {
    const event = simulation.events[simulation.freezeInfo.eventId];
    drawActor(ctx, simulation, event, false, true);
    const actor = event.actor;
    if (actor.active && !actor.cleared) {
      const actorY = worldY(simulation, actor.y);
      ctx.save();
      ctx.strokeStyle = '#fff0a8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(simulation.x, C.CAR_Y - 5);
      ctx.lineTo(actor.x, actorY);
      ctx.stroke();
      ctx.restore();
    }
    Draw.rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
    const x = simulation.x + 21;
    const y = C.CAR_Y - 30;
    Draw.rect(ctx, '#fff0b0', x, y, 22, 24);
    Draw.rect(ctx, '#3b2a0e', x + 9, y + 4, 4, 10);
    Draw.rect(ctx, '#3b2a0e', x + 9, y + 17, 4, 4);
  }

  const Renderer = {
    render: function (ctx, simulation) {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      if (simulation.status === 'demonstrating' && simulation.demo) {
        drawWorld(ctx, simulation.demo, true);
        return;
      }
      drawWorld(ctx, simulation, false);
      if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
    }
  };

  Scenes['blind-junction'] = {
    id: 'blind-junction',
    Constants: C,
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    Geometry: {
      segmentIntersectsAABB: segmentIntersectsAABB,
      segmentAABB: segmentIntersectsAABB,
      pointVisible: pointVisible,
      visibilityFor: visibilityFor,
      firstVisibleDistanceFor: firstVisibleDistanceFor,
      safeSpeedFor: safeSpeedFor,
      actorTravelTime: actorTravelTime
    },
    createPlan: createPlan,
    defensiveInput: defensiveInput,
    actorBlocking: actorBlocking,
    ui: {
      progress: function (simulation) {
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.blindJunction.hud.progress', { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && !event.failed; }).length
        ];
      },
      coach: function (simulation, displaySpeed) {
        const event = simulation.getRiskEvent();
        const upcoming = simulation.currentEvent;
        const approachDistance = upcoming ? upcoming.position - simulation.distance : Infinity;
        const actor = upcoming && upcoming.occupied ? upcoming.actor : null;
        const visibleActor = actor && actor.active && actor.visible && !actor.cleared;
        let coach = 'scene.blindJunction.hud.cruise';
        let status = displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : 'hud.speedUp';
        let tone = '';
        let coachTone = '';
        let statusParams = {};

        if (displaySpeed < 25 && !event) {
          status = 'hud.tooSlow';
          tone = 'warn';
        } else if (displaySpeed > 55 && !event) {
          status = 'hud.nearLimit';
          tone = 'danger';
        }

        if (event) {
          const target = Scoring.targetSpeed(simulation, event);
          coachTone = 'risk';
          if (visibleActor) {
            coach = event.kind === 'ebike'
              ? 'scene.blindJunction.hud.ebike' : 'scene.blindJunction.hud.pedestrian';
            status = displaySpeed < 1.2 ? 'hud.yielding' : 'hud.prepareStop';
            tone = displaySpeed < 1.2 ? '' : 'warn';
          } else if (displaySpeed > target + 6) {
            coach = 'scene.blindJunction.hud.tooFast';
            status = 'scene.blindJunction.hud.slowingTo';
            statusParams = { speed: Math.round(target) };
            tone = 'danger';
          } else if (displaySpeed > target + 2) {
            coach = 'scene.blindJunction.hud.risk';
            status = 'scene.blindJunction.hud.slowingTo';
            statusParams = { speed: Math.round(target) };
            tone = 'warn';
          } else {
            coach = 'scene.blindJunction.hud.controlled';
            status = displaySpeed < 6 && !actorBlocking(simulation, event)
              ? 'hud.tooSlowRisk' : 'scene.blindJunction.hud.defensiveAt';
            statusParams = { speed: Math.round(target) };
            tone = displaySpeed < 6 ? 'warn' : '';
            coachTone = displaySpeed < 6 ? 'risk' : 'good';
          }
        } else if (upcoming && approachDistance <= upcoming.approachStart && approachDistance > upcoming.riskStart) {
          coach = 'scene.blindJunction.hud.approach';
          status = 'hud.prepareSlow';
          coachTone = 'risk';
        } else {
          const previous = simulation.events.filter(function (item) {
            return item.resolved && simulation.distance >= item.position + C.RISK_END &&
              simulation.distance < item.position + 24;
          })[0];
          if (previous) coach = 'scene.blindJunction.hud.resume';
        }

        return {
          text: t(coach),
          coachTone: coachTone,
          status: t(simulation.status === 'ready' ? 'hud.ready' : status, statusParams),
          tone: tone
        };
      },
      retryToast: function () {
        return { key: 'scene.blindJunction.toast.retry', params: {}, neutral: true };
      },
      eventToast: function (event) {
        const observation = Scoring.eventObservation(event);
        if (event.earlySlow) {
          return {
            key: event.occupied
              ? 'scene.blindJunction.toast.safeOccupied' : 'scene.blindJunction.toast.safeEmpty',
            params: { score: observation },
            neutral: false
          };
        }
        if (event.lateSlow) return { key: 'scene.blindJunction.toast.late', params: {}, neutral: true };
        return { key: 'scene.blindJunction.toast.fast', params: {}, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('scene.blindJunction.failure.reason', {
          roadUser: t('scene.blindJunction.roadUser.' + info.kind),
          speed: Math.round(info.speed),
          remaining: Math.max(0, info.firstVisibleDistance == null ? info.remaining : info.firstVisibleDistance).toFixed(1),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        const event = demo.events[simulation.demoEventId];
        const actor = event.actor;
        let key = 'scene.blindJunction.demo.slow';
        if (event.resolved || actor.cleared) key = 'scene.blindJunction.demo.pass';
        else if (Scoring.isYieldExempt(demo) || (demo.speed < 1.2 && actorBlocking(demo, event))) {
          key = event.kind === 'ebike'
            ? 'scene.blindJunction.demo.waitEbike' : 'scene.blindJunction.demo.wait';
        } else if (!event.occupied && demo.getRiskEvent()) {
          key = 'scene.blindJunction.demo.empty';
        } else if (event.position - demo.distance <= event.slowCheck + 5) {
          key = 'scene.blindJunction.demo.space';
        }
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
