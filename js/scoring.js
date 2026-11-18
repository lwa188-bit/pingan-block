(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const C = Game.C;

  function createState() {
    return {
      efficiencyIntegral: 0,
      efficiencyTime: 0,
      hardBrakes: 0,
      hardBrakeDuration: 0,
      hardBrakeCooldown: 0
    };
  }

  function speedQuality(speed, inRiskZone) {
    if (inRiskZone) {
      if (speed < 8 || speed > 20) return 0;
      if (speed < 12) return (speed - 8) / 4;
      return 1;
    }
    if (speed < 25 || speed >= 60) return 0;
    if (speed < 40) return (speed - 25) / 15;
    if (speed <= 55) return 1;
    return (60 - speed) / 5;
  }

  function getRiskEvent(simulation) {
    return simulation.events.find(function (event) {
      return !event.resolved &&
        simulation.distance >= event.busPosition - C.RISK_START &&
        simulation.distance <= event.busPosition + C.RISK_END;
    }) || null;
  }

  function recordStep(state, simulation, dt) {
    const event = getRiskEvent(simulation);
    const quality = speedQuality(simulation.speed, Boolean(event));
    state.efficiencyIntegral += quality * dt;
    state.efficiencyTime += dt;
    state.hardBrakeCooldown = Math.max(0, state.hardBrakeCooldown - dt);

    const harsh = simulation.lastDeceleration > C.HARD_BRAKE &&
      simulation.previousSpeed > C.HARD_BRAKE_MIN_SPEED;

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
  }

  function eventObservation(event) {
    const speedScore = event.earlySlow ? 8 : (event.lateSlow ? 4 : 0);
    const lateralScore = event.maxLateralShift >= C.LATERAL_SHIFT ? 2 : 0;
    return speedScore + lateralScore;
  }

  function summarize(simulation, timedOut) {
    const state = simulation.scoring;
    const resolved = simulation.events.filter(function (event) { return event.resolved; });
    const clean = resolved.filter(function (event) { return !event.failed; });
    const observation = simulation.events.reduce(function (sum, event) {
      return sum + (event.resolved ? eventObservation(event) : 0);
    }, 0);
    const safety = Math.round(clean.length * (40 / 3));
    const efficiency = state.efficiencyTime > 0
      ? 20 * state.efficiencyIntegral / state.efficiencyTime
      : 0;
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
      summaryKey = 'result.summary.a';
    } else if (total >= 70 && !timedOut) {
      grade = 'B';
      titleKey = 'result.title.b';
      summaryKey = 'result.summary.b';
    } else if (timedOut) {
      titleKey = 'result.title.timeout';
      summaryKey = 'result.summary.timeout';
    }

    const earlySlowCount = simulation.events.filter(function (event) { return event.earlySlow; }).length;
    let adviceKey = 'result.advice.default';
    if (failed) {
      adviceKey = 'result.advice.failed';
    } else if (earlySlowCount < 3) {
      adviceKey = 'result.advice.early';
    } else if (state.hardBrakes > 0) {
      adviceKey = 'result.advice.braking';
    } else if (timedOut || efficiency < 12) {
      adviceKey = 'result.advice.efficiency';
    } else if (observation < 28) {
      adviceKey = 'result.advice.observation';
    }

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

  Game.Scoring = {
    createState: createState,
    speedQuality: speedQuality,
    getRiskEvent: getRiskEvent,
    recordStep: recordStep,
    eventObservation: eventObservation,
    summarize: summarize
  };
})(typeof window !== 'undefined' ? window : globalThis);
