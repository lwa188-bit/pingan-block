(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Model = Game.Model;
  const Draw = Game.Draw;
  const Scenes = Game.Scenes = Game.Scenes || {};
  const t = function (key, params) {
    return Game.I18N ? Game.I18N.t(key, params) : key;
  };

  const CONDITIONS = Object.freeze({
    urban: Object.freeze({
      id: 'urban', road: 'urban', weather: 'dry', headway: 3,
      maxSpeed: 65, normalDecel: 3.8, emergencyDecel: 6.8,
      naturalDecel: 0.35, recovery: 2.0, approach: 130, cue: 85,
      cruiseMin: 45, cruiseMax: 60
    }),
    highway: Object.freeze({
      id: 'highway', road: 'highway', weather: 'dry', headway: 3,
      maxSpeed: 125, normalDecel: 3.8, emergencyDecel: 6.8,
      naturalDecel: 0.35, recovery: 1.8, approach: 220, cue: 165,
      cruiseMin: 85, cruiseMax: 120
    }),
    rain: Object.freeze({
      id: 'rain', road: 'highway', weather: 'rain', headway: 4,
      maxSpeed: 95, normalDecel: 2.65, emergencyDecel: 4.6,
      naturalDecel: 0.28, recovery: 1.35, approach: 240, cue: 190,
      cruiseMin: 60, cruiseMax: 90
    })
  });

  const C = Object.assign({}, Game.C, {
    EVENT_POSITIONS: [140, 560, 960],
    FINISH_DISTANCE: 1250,
    MAX_SPEED: 125,
    MAX_TIME: 105,
    START_SPEED: 54,
    PREDICT_STEP: 0.04,
    PREDICT_HORIZON: 4.5,
    COLLISION_GAP: 0.8,
    CN_RULES: Object.freeze({
      id: 'CN',
      highway: Object.freeze({ threshold: 100, above: 100, below: 50 })
    }),
    GENERIC_RULES: Object.freeze({ id: 'GENERIC', highway: null })
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function createEvents(seed) {
    const random = Model.mulberry32(Model.hashSeed(seed));
    return [
      {
        id: 0, conditionId: 'urban', trigger: C.EVENT_POSITIONS[0],
        cruiseSpeed: 55 + random() * 3, minSpeed: 24 + random() * 4,
        brakeDecel: 4.35 + random() * 0.45, holdTime: 1.35 + random() * 0.45
      },
      {
        id: 1, conditionId: 'highway', trigger: C.EVENT_POSITIONS[1],
        cruiseSpeed: 100 + random() * 12, minSpeed: 38 + random() * 6,
        brakeDecel: 4.0 + random() * 0.5, holdTime: 1.3 + random() * 0.5
      },
      {
        id: 2, conditionId: 'rain', trigger: C.EVENT_POSITIONS[2],
        cruiseSpeed: 76 + random() * 8, minSpeed: 0,
        brakeDecel: 2.1 + random() * 0.25, holdTime: 2.2 + random() * 0.6
      }
    ].map(function (event) {
      event.active = false;
      event.resolved = false;
      event.failed = false;
      event.attempts = 0;
      resetEventRuntime(event);
      return event;
    });
  }

  function resetEventRuntime(event) {
    event.active = false;
    event.resolved = false;
    event.cueVisible = false;
    event.approachTime = 0;
    event.stableTime = 0;
    event.anticipationTime = 0;
    event.minGapRatioBefore = Infinity;
    event.gapAtTrigger = 0;
    event.gapRatioAtTrigger = 0;
    event.priorHeadwayOK = false;
    event.earlyResponse = false;
    event.responseDelay = null;
    event.responseClock = 0;
    event.approachHarsh = false;
    event.gapScore = 0;
    event.responseScore = 0;
    event.followScore = 0;
    event.earlySlow = false;
    event.lateSlow = false;
    event.goodGap = false;
  }

  function conditionFor(simulation) {
    const event = simulation.currentEvent || simulation.events[simulation.events.length - 1];
    return CONDITIONS[event ? event.conditionId : 'urban'];
  }

  function bumperGapMeters(simulation) {
    return (simulation.lead.distance - C.CAR_LENGTH_M / 2) -
      (simulation.distance + C.CAR_LENGTH_M / 2);
  }

  function timeGapSeconds(simulation) {
    return Math.max(0, bumperGapMeters(simulation)) /
      Math.max(simulation.speed / 3.6, 0.1);
  }

  function closingSpeed(simulation) {
    return simulation.speed - simulation.lead.speed;
  }

  function legalMinimumDistance(simulation) {
    if (conditionFor(simulation).road !== 'highway') return 0;
    const rule = simulation.rulePack && simulation.rulePack.highway;
    if (!rule) return 0;
    return simulation.speed > rule.threshold ? rule.above : rule.below;
  }

  function recommendedHeadway(simulation) {
    const speed = Math.max(simulation.speed / 3.6, 0.1);
    return Math.max(conditionFor(simulation).headway,
      legalMinimumDistance(simulation) / speed);
  }

  function recommendedDistance(simulation) {
    return Math.max(simulation.speed / 3.6 * conditionFor(simulation).headway,
      legalMinimumDistance(simulation));
  }

  function stoppingDistanceFor(simulation) {
    const speed = simulation.speed / 3.6;
    return speed * C.REACTION_TIME + speed * speed / (2 * conditionFor(simulation).normalDecel);
  }

  function accelerationFor(speed, input, condition, leadSpeed, gap) {
    let acceleration = -condition.naturalDecel;
    if (input.throttle) acceleration = C.ACCELERATION;
    if (input.brake) {
      const v = speed / 3.6;
      const leadV = leadSpeed / 3.6;
      const emergencyThreshold = Math.max(10,
        v * 0.55 + Math.max(0, v * v - leadV * leadV) / (2 * condition.normalDecel) * 0.32);
      acceleration = -(gap < emergencyThreshold ? condition.emergencyDecel : condition.normalDecel);
    }
    return acceleration;
  }

  function integrateVehicle(vehicle, acceleration, dt, maxSpeed) {
    const previous = vehicle.speed;
    vehicle.speed = clamp(previous + acceleration * dt * 3.6, 0, maxSpeed);
    vehicle.distance += (previous + vehicle.speed) / 7.2 * dt;
  }

  function advanceLead(lead, event, condition, dt) {
    const previous = lead.speed;
    let recovered = false;
    if (lead.state === 'braking') {
      lead.speed = Model.moveToward(lead.speed, event.minSpeed, event.brakeDecel * dt * 3.6);
      if (Math.abs(lead.speed - event.minSpeed) < 0.001) {
        lead.speed = event.minSpeed;
        lead.state = 'holding';
        lead.stateTime = 0;
      }
    } else if (lead.state === 'holding') {
      lead.stateTime += dt;
      if (lead.stateTime >= event.holdTime) {
        lead.state = 'recovering';
        lead.stateTime = 0;
      }
    } else if (lead.state === 'recovering') {
      lead.speed = Model.moveToward(lead.speed, event.cruiseSpeed, condition.recovery * dt * 3.6);
      if (Math.abs(lead.speed - event.cruiseSpeed) < 0.001) {
        lead.speed = event.cruiseSpeed;
        lead.state = 'cruise';
        recovered = true;
      }
    } else {
      lead.speed = Model.moveToward(lead.speed, event.cruiseSpeed, condition.recovery * dt * 3.6);
    }
    lead.distance += (previous + lead.speed) / 7.2 * dt;
    return recovered;
  }

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    if (!event) {
      return { throttle: simulation.speed < 78, brake: simulation.speed > 84 };
    }
    const condition = CONDITIONS[event.conditionId];
    const gap = Math.max(0, bumperGapMeters(simulation));
    const reference = Math.max(12, recommendedDistance(simulation) * 1.35);
    const leadSpeed = simulation.lead.speed;
    let target = event.cruiseSpeed;

    const projectedGap = gap - closingSpeed(simulation) / 3.6 * 0.9;
    if (projectedGap < reference * 1.12) {
      target = Math.min(target, leadSpeed + clamp((projectedGap - reference) * 0.65, -22, 5));
    } else if (projectedGap > reference * 1.35) {
      target = Math.min(condition.cruiseMax, event.cruiseSpeed + 4);
    } else {
      target = Math.min(target, leadSpeed + 1.5);
    }

    const cue = !event.active && simulation.distance >= event.trigger - condition.cue;
    if (cue && gap >= reference * 0.82 && gap <= reference * 1.65) {
      target = Math.min(target, Math.max(leadSpeed - 3, simulation.speed - 4));
    }

    if (event.active && simulation.lead.state === 'braking') {
      target = Math.min(target, Math.max(0, leadSpeed - 1));
    }
    if (event.active && leadSpeed < 5) {
      const stoppingSpeed = Math.sqrt(2 * condition.normalDecel * Math.max(0, gap - 14)) * 3.6;
      target = Math.min(target, stoppingSpeed);
    }

    let brake = simulation.speed > target + 0.55;
    if (!event.active && projectedGap < reference * 0.9 && closingSpeed(simulation) > 0) brake = true;
    if (event.active && simulation.lead.state === 'braking' &&
        closingSpeed(simulation) > 0.5 && gap < reference * 2.2) brake = true;
    const throttle = !brake && simulation.speed < target - 0.65 && projectedGap > reference * 0.98 &&
      !(event.active && simulation.lead.state === 'braking');
    return { throttle: throttle, brake: brake, left: false, right: false };
  }

  function predictConflict(simulation, input) {
    const event = simulation.currentEvent;
    if (!event) return null;
    const condition = CONDITIONS[event.conditionId];
    const player = { speed: simulation.speed, distance: simulation.distance };
    const lead = {
      speed: simulation.lead.speed,
      distance: simulation.lead.distance,
      state: simulation.lead.state,
      stateTime: simulation.lead.stateTime
    };
    const dt = C.PREDICT_STEP;
    let closest = lead.distance - player.distance - C.CAR_LENGTH_M;
    let elapsed = 0;

    for (let i = 0; i < Math.ceil(C.PREDICT_HORIZON / dt); i += 1) {
      const gap = lead.distance - player.distance - C.CAR_LENGTH_M;
      const acceleration = accelerationFor(player.speed, input, condition, lead.speed, gap);
      integrateVehicle(player, acceleration, dt, condition.maxSpeed);
      if (event.active) advanceLead(lead, event, condition, dt);
      else advanceLead(lead, event, condition, dt);
      closest = Math.min(closest, lead.distance - player.distance - C.CAR_LENGTH_M);
      elapsed += dt;
      if (closest <= C.COLLISION_GAP) {
        return { time: elapsed, gap: Math.max(0, closest) };
      }
      if (player.speed <= 0 && lead.speed >= 0 && closest > C.COLLISION_GAP) break;
    }
    return null;
  }

  function Simulation(seed, options) {
    this.seed = seed == null ? 'default' : String(seed);
    this.rulePack = options && options.rulePack ? options.rulePack : C.CN_RULES;
    this.events = createEvents(this.seed);
    this.distance = 0;
    this.speed = C.START_SPEED;
    this.previousSpeed = this.speed;
    this.elapsed = 0;
    this.status = 'ready';
    this.lead = {
      distance: C.CAR_LENGTH_M + 48,
      speed: this.events[0].cruiseSpeed,
      state: 'cruise',
      stateTime: 0
    };
    this.acceleration = 0;
    this.lastDeceleration = 0;
    this.timeGap = 3;
    this.currentEvent = this.events[0];
    this.scoring = Game.Scoring.createState();
    this.freezeInfo = null;
    this.justHardBrake = false;
    this.demo = null;
    this.toastEvent = null;
  }

  Simulation.prototype.start = function () {
    if (this.status === 'ready') this.status = 'driving';
  };

  Simulation.prototype.updateApproach = function (event, input, dt) {
    if (event.active || event.resolved) return;
    const condition = CONDITIONS[event.conditionId];
    if (this.distance < event.trigger - condition.approach || this.distance > event.trigger + 30) return;
    const reference = Math.max(1, recommendedDistance(this));
    const ratio = bumperGapMeters(this) / reference;
    if (this.distance >= event.trigger - Math.min(100, condition.cue)) {
      event.approachTime += dt;
      event.minGapRatioBefore = Math.min(event.minGapRatioBefore, ratio);
      if (ratio >= 0.78 && ratio <= 1.8 && closingSpeed(this) < 12) {
        event.stableTime += dt;
      }
    }
    if (this.distance >= event.trigger - condition.cue) {
      event.cueVisible = true;
      if (!input.throttle) event.anticipationTime += dt;
      if (this.lastDeceleration > C.HARD_BRAKE) event.approachHarsh = true;
    }
  };

  Simulation.prototype.activateEvent = function (event) {
    const reference = Math.max(1, recommendedDistance(this));
    event.active = true;
    event.gapAtTrigger = timeGapSeconds(this);
    event.gapRatioAtTrigger = bumperGapMeters(this) / reference;
    if (!Number.isFinite(event.minGapRatioBefore)) event.minGapRatioBefore = event.gapRatioAtTrigger;
    event.priorHeadwayOK = event.gapRatioAtTrigger >= 0.9 && event.minGapRatioBefore >= 0.75;
    event.earlyResponse = event.anticipationTime >= 0.35 && !event.approachHarsh;
    this.lead.state = 'braking';
    this.lead.stateTime = 0;
  };

  Simulation.prototype.resolveEvent = function (event) {
    event.active = false;
    event.resolved = true;
    const ratio = event.gapRatioAtTrigger;
    const minimum = event.minGapRatioBefore;
    event.gapScore = ratio >= 1 && ratio <= 1.8 && minimum >= 0.75 ? 4 :
      (ratio >= 0.62 && minimum >= 0.52 ? 2 : 0);
    event.responseScore = event.earlyResponse ? 4 :
      (event.responseDelay != null && event.responseDelay <= 0.9 && !event.approachHarsh ? 2 : 0);
    const stableRatio = event.approachTime > 0 ? event.stableTime / event.approachTime : 0;
    event.followScore = stableRatio >= 0.62 && minimum >= 0.72 ? 2 : 0;
    event.earlySlow = event.gapScore === 4 && event.responseScore === 4;
    event.lateSlow = !event.earlySlow && event.gapScore + event.responseScore >= 4;
    event.goodGap = event.followScore === 2;
    this.toastEvent = event;
  };

  Simulation.prototype.step = function (input, dt) {
    if (this.status !== 'driving') return;
    input = input || {};
    this.justHardBrake = false;
    this.toastEvent = null;
    this.previousSpeed = this.speed;
    const event = this.currentEvent;
    const condition = conditionFor(this);
    const gap = bumperGapMeters(this);
    this.acceleration = accelerationFor(this.speed, input, condition, this.lead.speed, gap);
    integrateVehicle(this, this.acceleration, dt, condition.maxSpeed);
    this.lastDeceleration = Math.max(0, -this.acceleration);

    if (event) {
      this.updateApproach(event, input, dt);
      const reference = recommendedDistance(this);
      const canActivate = this.distance >= event.trigger && this.speed >= 15 &&
        bumperGapMeters(this) <= Math.max(180, reference * 2.4);
      if (!event.active && canActivate) this.activateEvent(event);
      if (event.active) {
        if (this.lead.state === 'braking' && event.responseDelay == null) {
          event.responseClock += dt;
          if (input.brake) event.responseDelay = event.responseClock;
        }
        const recovered = advanceLead(this.lead, event, condition, dt);
        if (recovered) this.resolveEvent(event);
      } else {
        advanceLead(this.lead, event, condition, dt);
      }
    } else {
      advanceLead(this.lead, this.events[this.events.length - 1], condition, dt);
    }

    this.timeGap = timeGapSeconds(this);
    Scoring.recordStep(this.scoring, this, dt);

    const conflict = predictConflict(this, input);
    if (conflict) {
      this.freeze(event, conflict);
      return;
    }

    this.currentEvent = this.events.find(function (item) { return !item.resolved; }) || null;
    this.elapsed += dt;
    if (!this.currentEvent && this.distance >= C.FINISH_DISTANCE) {
      this.status = 'complete';
    } else if (this.elapsed >= C.MAX_TIME) {
      this.elapsed = C.MAX_TIME;
      this.status = 'timeout';
    }
  };

  Simulation.prototype.freeze = function (event, conflict) {
    if (!event || event.failed && this.status === 'frozen') return;
    event.failed = true;
    this.status = 'frozen';
    this.freezeInfo = {
      eventId: event.id,
      conditionId: event.conditionId,
      speed: this.speed,
      gap: timeGapSeconds(this),
      distance: Math.max(0, bumperGapMeters(this)),
      predictedGap: conflict.gap,
      closingSpeed: closingSpeed(this),
      stoppingDistance: stoppingDistanceFor(this),
      recommendedHeadway: recommendedHeadway(this),
      recommendedDistance: recommendedDistance(this),
      legalMinimum: legalMinimumDistance(this)
    };
  };

  Simulation.prototype.prepareEventStart = function (eventId, preserveFailure) {
    const event = this.events[eventId];
    const failed = event.failed;
    const attempts = event.attempts;
    resetEventRuntime(event);
    event.failed = preserveFailure ? failed : false;
    event.attempts = preserveFailure ? attempts : 0;
    this.currentEvent = event;
    const condition = CONDITIONS[event.conditionId];
    this.distance = Math.max(0, event.trigger - condition.approach);
    this.speed = event.cruiseSpeed - 2;
    this.previousSpeed = this.speed;
    this.lead.speed = event.cruiseSpeed;
    this.lead.state = 'cruise';
    this.lead.stateTime = 0;
    this.lead.distance = this.distance + C.CAR_LENGTH_M +
      this.speed / 3.6 * condition.headway * 1.08;
    this.acceleration = 0;
    this.lastDeceleration = 0;
    this.timeGap = timeGapSeconds(this);
    this.freezeInfo = null;
  };

  Simulation.prototype.retryEvent = function () {
    const eventId = this.freezeInfo ? this.freezeInfo.eventId :
      (this.currentEvent ? this.currentEvent.id : 0);
    const event = this.events[eventId];
    event.attempts += 1;
    this.prepareEventStart(eventId, true);
    this.demo = null;
    this.status = 'driving';
  };

  Simulation.prototype.startDemo = function () {
    const eventId = this.freezeInfo ? this.freezeInfo.eventId :
      (this.currentEvent ? this.currentEvent.id : 0);
    this.demo = new Simulation(this.seed, { rulePack: this.rulePack });
    for (let i = 0; i < eventId; i += 1) {
      this.demo.events[i].resolved = true;
      this.demo.events[i].earlySlow = true;
      this.demo.events[i].gapScore = 4;
      this.demo.events[i].responseScore = 4;
      this.demo.events[i].followScore = 2;
    }
    this.demo.prepareEventStart(eventId, false);
    this.demo.start();
    this.status = 'demonstrating';
  };

  Simulation.prototype.stepDemo = function (dt) {
    if (this.status !== 'demonstrating' || !this.demo) return;
    const eventId = this.demo.currentEvent ? this.demo.currentEvent.id : this.events.length - 1;
    this.demo.step(defensiveInput(this.demo), dt);
    if (this.demo.events[eventId].resolved || this.demo.status !== 'driving') {
      this.retryEvent();
    }
  };

  const Scoring = {
    createState: Game.Scoring.createState,

    eventObservation: function (event) {
      return event.gapScore + event.responseScore + event.followScore;
    },

    isYieldExempt: function (simulation) {
      const event = simulation.currentEvent;
      if (!event || !event.active || simulation.speed > 0.6 || simulation.lead.speed > 1.5) return false;
      const gap = bumperGapMeters(simulation);
      return gap > C.COLLISION_GAP && gap <= 20 &&
        (simulation.lead.state === 'holding' || simulation.lead.state === 'braking');
    },

    isNecessaryEmergency: function (simulation) {
      const event = simulation.currentEvent;
      return Boolean(event && event.active && event.priorHeadwayOK && !event.approachHarsh &&
        (simulation.lead.state === 'braking' || simulation.lead.state === 'holding') &&
        bumperGapMeters(simulation) <= recommendedDistance(simulation) * 1.2);
    },

    speedQuality: function (simulation) {
      const condition = conditionFor(simulation);
      const event = simulation.currentEvent;
      const speed = simulation.speed;
      const reference = Math.max(1, recommendedDistance(simulation));
      const gap = Math.max(0, bumperGapMeters(simulation));
      let quality;
      if (event && event.active && simulation.lead.speed < event.cruiseSpeed - 5 && gap <= reference * 2) {
        const delta = speed - simulation.lead.speed;
        quality = delta >= -15 && delta <= 12 ? 1 : (delta < -15 ? Math.max(0, (delta + 30) / 15) : Math.max(0, (25 - delta) / 13));
      } else if (speed < condition.cruiseMin - 15 || speed > condition.cruiseMax + 5) {
        quality = 0;
      } else if (speed < condition.cruiseMin) {
        quality = (speed - (condition.cruiseMin - 15)) / 15;
      } else if (speed <= condition.cruiseMax) {
        quality = 1;
      } else {
        quality = (condition.cruiseMax + 5 - speed) / 5;
      }
      if (gap < reference * 0.62) quality *= 0.2;
      if (gap > reference * 2.4) quality *= 0.3;
      return clamp(quality, 0, 1);
    },

    recordStep: function (state, simulation, dt) {
      state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);
      if (this.isYieldExempt(simulation)) {
        // Necessary waiting is neutral: remove it from both efficiency numerator and denominator.
      } else {
        state.efficiencyIntegral += this.speedQuality(simulation) * dt;
        state.efficiencyTime += dt;
      }

      const harsh = simulation.lastDeceleration > C.HARD_BRAKE &&
        simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED;
      if (harsh && this.isNecessaryEmergency(simulation)) {
        state.hardBrakeDuration = 0;
        return;
      }
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
      const state = simulation.scoring;
      const resolved = simulation.events.filter(function (event) { return event.resolved; });
      const clean = resolved.filter(function (event) { return !event.failed; });
      const observation = resolved.reduce(function (sum, event) {
        return sum + Scoring.eventObservation(event);
      }, 0);
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
        grade = 'A'; titleKey = 'result.title.a'; summaryKey = 'result.summary.a';
      } else if (total >= 70 && !timedOut) {
        grade = 'B'; titleKey = 'result.title.b'; summaryKey = 'result.summary.b';
      } else if (timedOut) {
        titleKey = 'result.title.timeout'; summaryKey = 'result.summary.timeout';
      }
      const earlySlowCount = simulation.events.filter(function (event) { return event.earlySlow; }).length;
      let adviceKey = 'scene.braking.result.advice.default';
      if (failed) adviceKey = 'scene.braking.result.advice.failed';
      else if (simulation.events.some(function (event) { return event.resolved && event.gapScore < 4; })) adviceKey = 'scene.braking.result.advice.gap';
      else if (earlySlowCount < 3) adviceKey = 'scene.braking.result.advice.observation';
      else if (state.hardBrakes > 0) adviceKey = 'scene.braking.result.advice.braking';
      else if (timedOut || efficiency < 12) adviceKey = 'scene.braking.result.advice.efficiency';

      return {
        total: total, grade: grade, titleKey: titleKey, summaryKey: summaryKey,
        safety: safety, observation: Math.round(observation), efficiency: Math.round(efficiency),
        efficiencyRaw: efficiency, smooth: smooth, hardBrakes: state.hardBrakes,
        earlySlowCount: earlySlowCount, passedCount: clean.length,
        timedOut: Boolean(timedOut), failed: failed, adviceKey: adviceKey
      };
    }
  };

  function drawRoad(ctx, simulation) {
    const condition = conditionFor(simulation);
    if (condition.road === 'urban') {
      Draw.drawEnvironment(ctx, simulation, C, 172);
    } else {
      Draw.rect(ctx, condition.weather === 'rain' ? '#263f42' : '#355747', 0, 0, C.WIDTH, C.HEIGHT);
      Draw.rect(ctx, condition.weather === 'rain' ? '#27383f' : '#38464b', 72, 0, 236, C.HEIGHT);
      Draw.rect(ctx, '#d7d8c9', 82, 0, 4, C.HEIGHT);
      Draw.rect(ctx, '#d7d8c9', 294, 0, 4, C.HEIGHT);
      const scroll = (simulation.distance * C.PIXELS_PER_METER) % 40;
      for (let y = -40 + scroll; y < C.HEIGHT + 40; y += 40) {
        Draw.rect(ctx, '#eef0db', 184, y, 5, 22);
        Draw.rect(ctx, '#91a9a2', 68, y, 4, 24);
        Draw.rect(ctx, '#91a9a2', 308, y, 4, 24);
      }
    }
    if (condition.weather === 'rain') {
      ctx.fillStyle = '#8cb5c418';
      ctx.fillRect(0, 0, C.WIDTH, C.HEIGHT);
      ctx.strokeStyle = '#b9d8df88';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 34; i += 1) {
        const x = (i * 47 + Math.floor(simulation.elapsed * 90)) % 390 - 15;
        const y = (i * 83 + Math.floor(simulation.elapsed * 240)) % 680 - 20;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 5, y + 15);
      }
      ctx.stroke();
    }
  }

  function drawGapGuide(ctx, simulation) {
    const reference = recommendedDistance(simulation);
    const legal = legalMinimumDistance(simulation);
    const outer = reference * 1.22;
    const y1 = Draw.worldY(C, simulation, simulation.distance + reference);
    const y2 = Draw.worldY(C, simulation, simulation.distance + outer);
    ctx.fillStyle = '#77e5ad20';
    ctx.fillRect(139, y2, 122, Math.max(2, y1 - y2));
    ctx.strokeStyle = '#8bf0b7';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(139, y1);
    ctx.lineTo(261, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    function drawGuideLabel(text, lineY, color, below) {
      const baseline = lineY + (below ? 22 : -6);
      Draw.rect(ctx, '#0b1d27e8', 265, baseline - 11, 91, 13);
      ctx.fillStyle = color;
      Draw.fillFittedText(ctx, text, 269, baseline, 83, 10, 'monospace');
    }
    if (legal > 0) {
      const legalY = Draw.worldY(C, simulation, simulation.distance + legal);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(139, legalY);
      ctx.lineTo(261, legalY);
      ctx.stroke();
      drawGuideLabel(t('scene.braking.canvas.legal', { distance: Math.round(legal) }),
        legalY, '#ffe3a1', Math.abs(legalY - y1) < 20);
    }
    drawGuideLabel(t('scene.braking.canvas.reference', { seconds: conditionFor(simulation).headway }),
      y1, '#d7f7df', y1 < 45);
  }

  function drawRoadside(ctx, simulation) {
    const first = Math.floor((simulation.distance - 30) / 25);
    for (let i = 0; i < 7; i += 1) {
      const segment = first + i;
      const y = Draw.worldY(C, simulation, segment * 25);
      Draw.rect(ctx, '#e8e4c9', 101, y - 7, 4, 14);
      Draw.rect(ctx, '#33464a', 100, y - 7, 6, 3);
      if (segment % 4 === 0) {
        Draw.rect(ctx, '#245f55', 22, y - 18, 48, 26);
        ctx.fillStyle = '#fff2bd';
        Draw.fillFittedText(ctx, '25 m', 27, y - 2, 38, 10, 'monospace');
      }
    }
  }

  function drawTraffic(ctx, simulation) {
    const event = simulation.currentEvent;
    if (event && event.cueVisible && !event.active) {
      [48, 92].forEach(function (offset) {
        const y = Draw.worldY(C, simulation, simulation.lead.distance + offset);
        if (y > -30 && y < C.HEIGHT) {
          Draw.drawCar(ctx, 210, y, '#71858a', false);
          Draw.rect(ctx, '#ff4e47', 198, y + 19, 7, 4);
          Draw.rect(ctx, '#ff4e47', 215, y + 19, 7, 4);
        }
      });
    }
    const leadY = Draw.worldY(C, simulation, simulation.lead.distance);
    Draw.drawCar(ctx, 210, leadY, '#e7b84f', false);
    if (simulation.lead.state === 'braking' || simulation.lead.state === 'holding') {
      Draw.rect(ctx, '#ff3e39', 198, leadY + 19, 7, 5);
      Draw.rect(ctx, '#ff3e39', 215, leadY + 19, 7, 5);
      Draw.rect(ctx, '#ff6b5666', 195, leadY + 24, 30, 3);
    }
    Draw.drawCar(ctx, 210, C.CAR_Y, '#e7685b', Boolean(simulation.demo));
  }

  function drawReadout(ctx, simulation) {
    const condition = conditionFor(simulation);
    const gap = timeGapSeconds(simulation);
    const relative = closingSpeed(simulation);
    Draw.rect(ctx, '#0b1d27e8', 150, 574, 126, 52);
    ctx.fillStyle = '#d8eee7';
    Draw.fillFittedText(ctx, t('scene.braking.condition.' + condition.id), 156, 589, 114, 10, 'monospace');
    const readout = simulation.speed < 3 ?
      t('scene.braking.canvas.queueReadout', { meters: Math.max(0, Math.round(bumperGapMeters(simulation))) }) :
      t('scene.braking.canvas.gapReadout', { gap: gap.toFixed(1), target: condition.headway });
    Draw.fillFittedText(ctx, readout, 156, 606, 114, 10, 'monospace');
    const trendKey = relative > 4 ? 'closing' : (relative < -4 ? 'opening' : 'matched');
    ctx.fillStyle = relative > 4 ? '#ffd166' : '#b8d9d2';
    Draw.fillFittedText(ctx, t('scene.braking.canvas.' + trendKey, { speed: Math.abs(Math.round(relative)) }),
      156, 621, 114, 9, 'monospace');
  }

  const Renderer = {
    render: function (ctx, simulation) {
      const view = simulation.demo || simulation;
      ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
      drawRoad(ctx, view);
      drawRoadside(ctx, view);
      drawGapGuide(ctx, view);
      drawTraffic(ctx, view);
      drawReadout(ctx, view);
      if (view.status === 'frozen') {
        Draw.fillFittedText(ctx, t('scene.braking.canvas.frozen'), 92, 548, 190, 12, 'monospace');
      }
    }
  };

  Scenes['sudden-braking'] = {
    id: 'sudden-braking',
    Simulation: Simulation,
    Scoring: Scoring,
    Renderer: Renderer,
    Constants: C,
    Conditions: CONDITIONS,
    defensiveInput: defensiveInput,
    conditionFor: conditionFor,
    bumperGapMeters: bumperGapMeters,
    timeGapSeconds: timeGapSeconds,
    recommendedHeadway: recommendedHeadway,
    recommendedDistance: recommendedDistance,
    legalMinimumDistance: legalMinimumDistance,
    closingSpeed: closingSpeed,
    stoppingDistanceFor: stoppingDistanceFor,
    ui: {
      progress: function (simulation) {
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('scene.braking.hud.progress', { resolved: resolved });
      },
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && !event.failed; }).length
        ];
      },
      coach: function (simulation) {
        const event = simulation.currentEvent;
        const condition = conditionFor(simulation);
        const gap = timeGapSeconds(simulation);
        const reference = recommendedDistance(simulation);
        const actualGap = bumperGapMeters(simulation);
        let key = 'scene.braking.hud.cruise';
        let coachTone = '';
        if (event && event.active && Scoring.isYieldExempt(simulation)) {
          key = 'scene.braking.hud.necessaryStop'; coachTone = 'good';
        } else if (event && event.active && simulation.lead.state === 'braking') {
          key = 'scene.braking.hud.leadBraking'; coachTone = 'risk';
        } else if (event && event.active && simulation.lead.state === 'holding') {
          key = 'scene.braking.hud.holding'; coachTone = 'risk';
        } else if (event && event.active && simulation.lead.state === 'recovering') {
          key = 'scene.braking.hud.recover'; coachTone = 'good';
        } else if (actualGap < reference * 0.62) {
          key = 'scene.braking.hud.tooClose'; coachTone = 'risk';
        } else if (actualGap < reference * 0.9) {
          key = 'scene.braking.hud.gapNear'; coachTone = 'risk';
        } else if (closingSpeed(simulation) > 8) {
          key = 'scene.braking.hud.closing'; coachTone = 'risk';
        } else if (event && event.cueVisible && !event.active) {
          key = 'scene.braking.hud.distantBraking'; coachTone = 'risk';
        } else if (condition.weather === 'rain') {
          key = 'scene.braking.hud.rain';
        }
        return {
          text: t(key, { seconds: condition.headway }),
          coachTone: coachTone,
          status: simulation.status === 'ready' ? t('hud.ready') :
            (simulation.speed < 3 ? t('scene.braking.hud.queue', { meters: Math.max(0, Math.round(actualGap)) }) :
              t('scene.braking.hud.gap', {
                gap: gap.toFixed(1), target: recommendedHeadway(simulation).toFixed(1)
              })),
          tone: actualGap < reference * 0.62 ? 'danger' : (actualGap < reference * 0.9 ? 'warn' : '')
        };
      },
      eventToast: function (event) {
        const observation = Scoring.eventObservation(event);
        if (event.earlySlow) return { key: 'scene.braking.toast.goodGap', params: { score: observation }, neutral: false };
        if (event.gapScore < 4) return { key: 'scene.braking.toast.closeGap', params: {}, neutral: true };
        return { key: 'scene.braking.toast.lateResponse', params: {}, neutral: true };
      },
      retryToast: function () {
        return { key: 'scene.braking.toast.retry', params: {}, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t(info.legalMinimum > 0 ? 'scene.braking.failure.reasonLegal' : 'scene.braking.failure.reason', {
          gap: info.gap.toFixed(1), meters: Math.round(info.distance),
          speed: Math.round(info.speed), distance: Math.round(info.stoppingDistance),
          target: info.recommendedHeadway.toFixed(1), reference: Math.round(info.recommendedDistance),
          legal: Math.round(info.legalMinimum)
        });
      },
      demoCaption: function (simulation) {
        const demo = simulation.demo;
        let key = 'scene.braking.demo.gap';
        if (demo.lead.state === 'braking' || demo.lead.state === 'holding') key = 'scene.braking.demo.brake';
        else if (demo.lead.state === 'recovering') key = 'scene.braking.demo.recover';
        return {
          step: t(key, { seconds: conditionFor(demo).headway }),
          substep: t(key + 'Sub', { seconds: conditionFor(demo).headway })
        };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
