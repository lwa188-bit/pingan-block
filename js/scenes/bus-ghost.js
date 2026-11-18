(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const Scenes = Game.Scenes = Game.Scenes || {};
  const C = Game.C;

  function t(key, params) {
    return Game.I18N.t(key, params);
  }

  // HUD 教练与速度状态：返回已翻译文案，main.js 只做 DOM 更新
  function coach(simulation, displaySpeed) {
    const event = simulation.getRiskEvent();
    const upcomingEvent = simulation.currentEvent;
    const approachDistance = upcomingEvent ? upcomingEvent.busPosition - simulation.distance : Infinity;
    const inApproachZone = !event && upcomingEvent &&
      approachDistance <= C.APPROACH_START && approachDistance > C.RISK_START;
    const pedestrian = event && event.occupied ? event.pedestrian : null;
    let coach = 'hud.cruise';
    let status = displaySpeed >= 40 && displaySpeed <= 55 ? 'hud.cruiseGood' : 'hud.speedUp';
    let tone = '';
    let coachTone = '';

    if (displaySpeed < 25 && !event) {
      status = 'hud.tooSlow';
      tone = 'warn';
    } else if (displaySpeed > 55 && !event) {
      status = 'hud.nearLimit';
      tone = 'danger';
    }

    if (event) {
      coachTone = 'risk';
      if (pedestrian && pedestrian.visible && !pedestrian.waiting) {
        coach = 'hud.pedestrian';
        status = displaySpeed < 1 ? 'hud.yielding' : 'hud.prepareStop';
        tone = displaySpeed < 1 ? '' : 'warn';
      } else if (displaySpeed > C.RISK_MAX_SPEED) {
        coach = 'hud.brakeNow';
        status = 'hud.tooFast';
        tone = 'danger';
      } else if (displaySpeed > C.SAFE_SPEED) {
        coach = 'hud.keepSlowing';
        status = 'hud.slowing';
        tone = 'warn';
      } else {
        coach = 'hud.controlled';
        status = displaySpeed < 8 ? 'hud.tooSlowRisk' : 'hud.defensive';
        tone = displaySpeed < 8 ? 'warn' : '';
        coachTone = displaySpeed < 8 ? 'risk' : 'good';
      }
    } else if (inApproachZone) {
      coach = 'hud.approach';
      status = 'hud.prepareSlow';
      coachTone = 'risk';
    } else if (simulation.currentEvent && simulation.distance > simulation.currentEvent.busPosition + C.RISK_END) {
      coach = 'hud.resumeSpeed';
    }

    return {
      text: t(coach),
      coachTone: coachTone,
      status: t(simulation.status === 'ready' ? 'hud.ready' : status),
      tone: tone
    };
  }

  Scenes['bus-ghost'] = {
    id: 'bus-ghost',
    Simulation: Game.Simulation,
    Scoring: Game.Scoring,
    Renderer: Game.Renderer,
    ui: {
      progress: function (simulation) {
        const resolved = simulation.events.filter(function (event) { return event.resolved; }).length;
        return t('hud.progress', { resolved: resolved });
      },
      // 侧栏三项实时数据：提前减速、急刹、安全通过
      liveStats: function (simulation) {
        return [
          simulation.events.filter(function (event) { return event.earlySlow; }).length,
          simulation.scoring.hardBrakes,
          simulation.events.filter(function (event) { return event.resolved && !event.failed; }).length
        ];
      },
      coach: coach,
      eventToast: function (event) {
        const observation = Game.Scoring.eventObservation(event);
        if (event.earlySlow) {
          return {
            key: event.occupied ? 'toast.safeOccupied' : 'toast.safeEmpty',
            params: { score: observation },
            neutral: false
          };
        }
        if (event.lateSlow) return { key: 'toast.late', params: {}, neutral: true };
        return { key: 'toast.fast', params: {}, neutral: true };
      },
      failureReason: function (simulation) {
        const info = simulation.freezeInfo;
        if (!info) return '';
        return t('failure.reason', {
          speed: Math.round(info.speed),
          distance: Math.round(info.stoppingDistance)
        });
      },
      demoCaption: function (simulation) {
        const time = simulation.demoTime;
        let key = 'demo.wait';
        if (time < 1.5) key = 'demo.early';
        else if (time < 3.1) key = 'demo.space';
        return { step: t(key), substep: t(key + 'Sub') };
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
