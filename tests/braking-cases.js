(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['sudden-braking'];
  const FIXED_STEP = 1 / 60;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function run(seed, controller, hz) {
    const sim = new Scene.Simulation(seed);
    sim.start();
    const frame = 1 / (hz || 60);
    let accumulator = 0;
    let guard = 0;
    while (sim.status === 'driving' && guard < 20000) {
      accumulator += frame;
      while (accumulator >= FIXED_STEP && sim.status === 'driving') {
        sim.step(controller(sim), FIXED_STEP);
        accumulator -= FIXED_STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    return sim;
  }

  function crawlerInput(sim) {
    return { throttle: sim.speed < 15, brake: false };
  }

  function fullThrottleInput() {
    return { throttle: true, brake: false };
  }

  function useEvent(sim, eventId) {
    for (let i = 0; i < eventId; i += 1) sim.events[i].resolved = true;
    sim.currentEvent = sim.events[eventId];
    sim.distance = sim.currentEvent.trigger;
    sim.lead.state = 'cruise';
    sim.lead.stateTime = 0;
    sim.lead.speed = sim.currentEvent.cruiseSpeed;
    sim.speed = sim.currentEvent.cruiseSpeed;
    sim.previousSpeed = sim.speed;
    sim.lead.distance = sim.distance + Game.C.CAR_LENGTH_M + Scene.recommendedDistance(sim) * 1.1;
    sim.status = 'driving';
  }

  function conflictSimulation(conditionId, speed, gap, leadSpeed) {
    const sim = new Scene.Simulation('conflict-' + conditionId);
    const eventId = conditionId === 'urban' ? 0 : (conditionId === 'highway' ? 1 : 2);
    useEvent(sim, eventId);
    const event = sim.currentEvent;
    event.active = true;
    event.priorHeadwayOK = true;
    sim.speed = speed;
    sim.previousSpeed = speed;
    sim.lead.speed = leadSpeed;
    sim.lead.state = leadSpeed > 0 ? 'braking' : 'holding';
    sim.lead.stateTime = 0;
    sim.lead.distance = sim.distance + Game.C.CAR_LENGTH_M + gap;
    return sim;
  }

  function fixedHeadwayInput(sim, seconds, onlyEventId) {
    if (sim.currentEvent.id !== onlyEventId) return Scene.defensiveInput(sim);
    const event = sim.currentEvent;
    const gap = Math.max(0, Scene.bumperGapMeters(sim));
    const targetGap = sim.speed / 3.6 * seconds;
    let target = event.cruiseSpeed;
    if (gap < targetGap * 1.1) target = Math.min(target, sim.lead.speed + (gap - targetGap) * 0.6);
    if (event.active && sim.lead.state === 'braking') target = Math.min(target, Math.max(0, sim.lead.speed - 1));
    if (event.active && sim.lead.speed < 5) {
      target = Math.min(target, Math.sqrt(2 * Scene.conditionFor(sim).normalDecel * Math.max(0, gap - 12)) * 3.6);
    }
    const brake = sim.speed > target + 0.5 || (event.active && Scene.closingSpeed(sim) > 0.5);
    return { throttle: !brake && sim.speed < target - 0.5 && gap > targetGap * 0.95, brake: brake };
  }

  function isolatedHeadwayRun(seed, eventId, seconds) {
    const sim = new Scene.Simulation(seed);
    useEvent(sim, eventId);
    const event = sim.currentEvent;
    sim.distance = event.trigger - 100;
    sim.speed = event.cruiseSpeed;
    sim.previousSpeed = sim.speed;
    sim.lead.speed = event.cruiseSpeed;
    sim.lead.distance = sim.distance + Game.C.CAR_LENGTH_M + sim.speed / 3.6 * seconds;
    let guard = 0;
    while (!event.resolved && sim.status === 'driving' && guard < 4000) {
      sim.step(fixedHeadwayInput(sim, seconds, eventId), FIXED_STEP);
      guard += 1;
    }
    return sim;
  }

  function runTests() {
    const results = [];
    function test(name, fn) {
      try {
        fn();
        results.push({ name: '[03] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[03] ' + name, passed: false, error: error.message });
      }
    }

    test('03 种子复现三段条件、速度与制动参数', function () {
      ['same-seed', 0, 37, 'dynamic-gap'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.events) === JSON.stringify(b.events), '种子 ' + seed + ' 应复现完整事件');
        assert(a.events.map(function (e) { return e.conditionId; }).join(',') === 'urban,highway,rain', '应固定依次经历三段');
        assert(a.events[0].cruiseSpeed >= 55 && a.events[0].cruiseSpeed <= 58, '城市巡航速度应在校准范围');
        assert(a.events[1].cruiseSpeed >= 100 && a.events[1].cruiseSpeed <= 112, '高速巡航速度应在校准范围');
        assert(a.events[2].cruiseSpeed >= 76 && a.events[2].cruiseSpeed <= 84, '雨天巡航速度应在校准范围');
        assert(a.events[2].minSpeed === 0, '最后一段应包含真实短暂停车');
        assert(a.events[2].brakeDecel < Scene.Conditions.rain.normalDecel, '雨天前车不应比玩家普通制动更强');
      });
    });

    test('03 60/80/100/110/120 km/h 动态时距与中国法规换算', function () {
      const sim = new Scene.Simulation('conversion');
      sim.speed = 60;
      assert(Math.abs(Scene.recommendedDistance(sim) - 50) < 0.001, '城市 60 km/h 三秒应为 50 米');
      assert(Scene.legalMinimumDistance(sim) === 0, '城市不应套用高速法规');
      useEvent(sim, 1);
      sim.speed = 100;
      assert(Scene.legalMinimumDistance(sim) === 50, '100 km/h 未超过阈值时本规则包取 50 米');
      assert(Math.abs(Scene.recommendedDistance(sim) - 250 / 3) < 0.001, '100 km/h 三秒应约 83.3 米');
      sim.speed = 110;
      assert(Scene.legalMinimumDistance(sim) === 100, '超过 100 km/h 应取 100 米');
      assert(Math.abs(Scene.recommendedHeadway(sim) - 100 / (110 / 3.6)) < 0.000001, '110 km/h 法规应换算为动态秒数');
      assert(Scene.recommendedDistance(sim) === 100, '法规高于三秒距离时应取法规距离');
      sim.speed = 120;
      assert(Scene.legalMinimumDistance(sim) === 100, '120 km/h 应保持 100 米法规参考');
      assert(Math.abs(Scene.recommendedDistance(sim) - 100) < 0.001, '120 km/h 三秒应约 100 米');
      useEvent(sim, 2);
      sim.speed = 80;
      assert(Scene.legalMinimumDistance(sim) === 50, '雨天高速仍显示独立法规参考');
      assert(Math.abs(Scene.recommendedDistance(sim) - 800 / 9) < 0.001, '雨天 80 km/h 四秒应约 88.9 米');
      const generic = new Scene.Simulation('generic', { rulePack: Scene.Constants.GENERIC_RULES });
      useEvent(generic, 1);
      generic.speed = 120;
      assert(generic.rulePack.id === 'GENERIC' && Scene.legalMinimumDistance(generic) === 0, '通用规则包不应伪造当地法规');
      assert(Scene.recommendedDistance(generic) === 100, '通用规则包仍保留教学时距');
    });

    test('03 语言切换不改变规则、参考距离或模拟对象', function () {
      const sim = new Scene.Simulation('language-rules');
      useEvent(sim, 1);
      sim.speed = 110;
      const before = [Scene.recommendedHeadway(sim), Scene.recommendedDistance(sim), Scene.legalMinimumDistance(sim), sim.rulePack.id];
      Game.I18N.setLanguage('en');
      const after = [Scene.recommendedHeadway(sim), Scene.recommendedDistance(sim), Scene.legalMinimumDistance(sim), sim.rulePack.id];
      assert(JSON.stringify(before) === JSON.stringify(after), '英文只应翻译，不应切换法规或物理');
      Game.I18N.setLanguage('zh-CN');
    });

    test('03 时距使用前后保险杠距离和玩家车速', function () {
      const sim = new Scene.Simulation('geometry');
      sim.distance = 100;
      sim.lead.distance = 100 + Game.C.CAR_LENGTH_M + 20;
      sim.speed = 36;
      assert(Math.abs(Scene.bumperGapMeters(sim) - 20) < 0.000001, '保险杠间距应为 20 米');
      assert(Math.abs(Scene.timeGapSeconds(sim) - 2) < 0.000001, '36 km/h、20 米应为两秒');
      sim.speed = 0;
      assert(Number.isFinite(Scene.timeGapSeconds(sim)), '停车时显示值也必须保持有限');
    });

    test('03 防御策略 200 种子安全完成、观察满分且无急刹', function () {
      for (let i = 0; i < 200; i += 1) {
        const sim = run('braking-defense-' + i, Scene.defensiveInput);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'complete', '种子 ' + i + ' 应完成，实际 ' + sim.status);
        assert(summary.total >= 85, '种子 ' + i + ' 应高分，实际 ' + summary.total);
        assert(summary.observation === 30, '种子 ' + i + ' 应通过持续动态车距获得观察满分，实际 ' + summary.observation);
        assert(summary.hardBrakes === 0, '种子 ' + i + ' 不应依赖急刹');
      }
    });

    test('03 高速仅保持两秒和雨天沿用三秒均不能满分', function () {
      for (let i = 0; i < 20; i += 1) {
        const highway = isolatedHeadwayRun('two-second-' + i, 1, 2);
        const rain = isolatedHeadwayRun('dry-gap-in-rain-' + i, 2, 3);
        assert(highway.events[1].gapScore < 4, '高速两秒不能拿时距满分');
        assert(rain.events[2].gapScore < 4, '雨天照搬三秒不能拿时距满分');
        assert(Scene.Scoring.summarize(highway, highway.status === 'timeout').observation < 30, '高速两秒总观察分不应满分');
        assert(Scene.Scoring.summarize(rain, rain.status === 'timeout').observation < 30, '雨天三秒总观察分不应满分');
      }
    });

    test('03 输入感知预测允许充分制动停车，持续滑行会在接触前定格', function () {
      const braking = conflictSimulation('rain', 70, 72, 0);
      for (let i = 0; i < 600 && braking.status === 'driving' && braking.speed > 0.1; i += 1) {
        braking.step({ brake: true }, FIXED_STEP);
      }
      assert(braking.status !== 'frozen', '充分制动且能停住时不应误罚');
      assert(braking.speed < 0.2, '制动轨迹应实际停住');
      const coasting = conflictSimulation('rain', 70, 72, 0);
      for (let i = 0; i < 600 && coasting.status === 'driving'; i += 1) coasting.step({}, FIXED_STEP);
      assert(coasting.status === 'frozen', '相同初始状态下持续滑行应预测碰撞');
      assert(Scene.bumperGapMeters(coasting) > 0, '定格应发生在真实保险杠重叠之前');
    });

    test('03 必要停车效率中性，恢复后继续远停恢复计时', function () {
      const sim = conflictSimulation('rain', 0, 12, 0);
      assert(Scene.Scoring.isYieldExempt(sim), '停止前车前合理排队距离内应豁免必要等待');
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 0 && sim.scoring.efficiencyIntegral === 0, '必要停车不得计入效率分子或分母');
      sim.lead.state = 'recovering';
      sim.lead.speed = 10;
      assert(!Scene.Scoring.isYieldExempt(sim), '车流恢复后不应继续豁免');
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 1, '恢复后继续停车应恢复效率计时');
      const distant = conflictSimulation('rain', 0, 40, 0);
      assert(!Scene.Scoring.isYieldExempt(distant), '远离前车的无故停车不应利用豁免');
    });

    test('03 必要应急制动与可预防急刹分开计数', function () {
      const necessary = conflictSimulation('highway', 55, 45, 20);
      necessary.currentEvent.priorHeadwayOK = true;
      necessary.lastDeceleration = 6.8;
      necessary.previousSpeed = 60;
      for (let i = 0; i < 12; i += 1) Scene.Scoring.recordStep(necessary.scoring, necessary, FIXED_STEP);
      assert(necessary.scoring.hardBrakes === 0, '已预留余量后的必要应急制动不应重复扣分');
      const avoidable = conflictSimulation('highway', 55, 45, 20);
      avoidable.currentEvent.priorHeadwayOK = false;
      avoidable.lastDeceleration = 6.8;
      avoidable.previousSpeed = 60;
      for (let i = 0; i < 12; i += 1) Scene.Scoring.recordStep(avoidable.scoring, avoidable, FIXED_STEP);
      assert(avoidable.scoring.hardBrakes === 1, '贴尾造成的可预防急刹应扣分且只计一次');
    });

    test('03 持续加速 100 种子均在真实重叠前定格', function () {
      for (let i = 0; i < 100; i += 1) {
        const sim = run('braking-tailgate-' + i, fullThrottleInput);
        assert(sim.status === 'frozen', '种子 ' + i + ' 持续加速应危险定格');
        assert(Scene.bumperGapMeters(sim) > 0, '种子 ' + i + ' 不应先发生真实重叠');
        assert(sim.freezeInfo && sim.events[sim.freezeInfo.eventId].failed, '失败事件和解释数据应保留');
        assert(sim.freezeInfo.recommendedDistance >= sim.freezeInfo.legalMinimum, '定格参考距离不得小于法规下限');
      }
    });

    test('03 全程龟速超时且不超过 69 分', function () {
      for (let i = 0; i < 50; i += 1) {
        const sim = run('braking-crawl-' + i, crawlerInput);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'timeout', '种子 ' + i + ' 龟速应超时，实际 ' + sim.status);
        assert(summary.total <= 69, '种子 ' + i + ' 龟速不能高分，实际 ' + summary.total);
      }
    });

    test('03 远处停车不会让事件自动触发、恢复和加分', function () {
      const sim = new Scene.Simulation('non-participation');
      sim.start();
      sim.distance = sim.events[0].trigger + 1;
      sim.speed = 0;
      sim.lead.distance = sim.distance + 500;
      sim.step({}, FIXED_STEP);
      assert(!sim.events[0].active && !sim.events[0].resolved, '脱离车流时不应自动完成制动事件');
      assert(Scene.Scoring.eventObservation(sim.events[0]) === 0, '未参与事件不得获得观察分');
    });

    test('03 各段重试保留条件、失败和种子并恢复合适初态', function () {
      ['urban', 'highway', 'rain'].forEach(function (conditionId, eventId) {
        const sim = conflictSimulation(conditionId, conditionId === 'urban' ? 55 : 90, 12, 0);
        const original = JSON.stringify(sim.events.map(function (e) { return [e.conditionId, e.cruiseSpeed, e.brakeDecel]; }));
        sim.step({ throttle: true }, FIXED_STEP);
        assert(sim.status === 'frozen', conditionId + ' 应先发生可重试失败');
        sim.retryEvent();
        assert(sim.status === 'driving' && sim.currentEvent.id === eventId, conditionId + ' 应回到原事件');
        assert(sim.speed === sim.currentEvent.cruiseSpeed - 2, conditionId + ' 重试速度应符合本段车流');
        assert(sim.events[eventId].failed && sim.events[eventId].attempts === 1, '重试不得洗掉首次失败');
        assert(JSON.stringify(sim.events.map(function (e) { return [e.conditionId, e.cruiseSpeed, e.brakeDecel]; })) === original, '重试不得重新随机条件');
        assert(Scene.conditionFor(sim).id === conditionId, '重试应立即恢复正确路面和制动能力');
      });
    });

    test('03 重试后防御完成仍保留 59 分封顶', function () {
      const sim = run('braking-retry-cap', fullThrottleInput);
      assert(sim.status === 'frozen', '应先失败');
      sim.retryEvent();
      let guard = 0;
      while (sim.status === 'driving' && guard < 12000) {
        sim.step(Scene.defensiveInput(sim), FIXED_STEP);
        guard += 1;
      }
      const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
      assert(sim.status === 'complete', '重试后防御驾驶应完成，实际 ' + sim.status);
      assert(summary.failed && summary.total <= 59, '首次失败应保留并封顶 59，实际 ' + summary.total);
      assert(summary.observation === 30, '重试正确操作仍可获得当前事件观察分');
    });

    test('03 三段示范均逐帧复用真实 Simulation 且不修改正式成绩', function () {
      ['urban', 'highway', 'rain'].forEach(function (conditionId) {
        const sim = conflictSimulation(conditionId, conditionId === 'urban' ? 55 : 90, 12, 0);
        sim.step({ throttle: true }, FIXED_STEP);
        const failedId = sim.freezeInfo.eventId;
        const official = JSON.stringify(sim.scoring);
        sim.startDemo();
        assert(sim.status === 'demonstrating' && sim.demo, conditionId + ' 应进入隔离示范');
        const expected = new Scene.Simulation(sim.seed, { rulePack: sim.rulePack });
        for (let i = 0; i < failedId; i += 1) expected.events[i].resolved = true;
        expected.prepareEventStart(failedId, false);
        expected.start();
        for (let i = 0; i < 2400 && sim.status === 'demonstrating'; i += 1) {
          sim.stepDemo(FIXED_STEP);
          expected.step(Scene.defensiveInput(expected), FIXED_STEP);
          if (sim.status !== 'demonstrating') break;
          assert(Math.abs(sim.demo.distance - expected.distance) < 0.000001, conditionId + ' 示范第 ' + i + ' 帧距离应一致');
          assert(Math.abs(sim.demo.speed - expected.speed) < 0.000001, conditionId + ' 示范第 ' + i + ' 帧速度应一致');
        }
        assert(sim.status === 'driving' && sim.demo === null, conditionId + ' 示范结束后应返回重试');
        assert(JSON.stringify(sim.scoring) === official, conditionId + ' 示范不得修改正式评分');
        assert(sim.events[failedId].failed, conditionId + ' 示范不得洗掉失败');
      });
    });

    test('03 30/60/120Hz 固定步长结果一致', function () {
      const summaries = [30, 60, 120].map(function (hz) {
        const sim = run('braking-hz', Scene.defensiveInput, hz);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        return [sim.status, summary.total, summary.observation, summary.efficiency, summary.hardBrakes].join(':');
      });
      assert(summaries[0] === summaries[1] && summaries[1] === summaries[2], '帧率不应改变结果：' + summaries.join(' / '));
    });

    test('03 静态 Renderer 可绘制三段、低速读数、定格与示范', function () {
      const texts = [];
      let clears = 0;
      const noop = function () {};
      const ctx = {
        clearRect: function () { clears += 1; },
        fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
        stroke: noop, setLineDash: noop, save: noop, restore: noop,
        measureText: function (text) { return { width: String(text).length * 7 }; },
        fillText: function (text, x, y) {
          texts.push(String(text));
          assert(Number.isFinite(x) && Number.isFinite(y), '文字坐标必须有限');
        }
      };
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        ['urban', 'highway', 'rain'].forEach(function (conditionId, eventId) {
          const sim = new Scene.Simulation('render-' + conditionId);
          useEvent(sim, eventId);
          sim.speed = 0;
          sim.previousSpeed = 0;
          sim.lead.distance = sim.distance + Game.C.CAR_LENGTH_M + 12;
          Scene.Renderer.render(ctx, sim);
          const queue = Game.I18N.t('scene.braking.canvas.queueReadout', { meters: 12 });
          assert(texts.indexOf(queue) >= 0, lang + ' / ' + conditionId + ' 低速应显示实际米数');
          assert(texts.every(function (text) { return text.indexOf('scene.braking.') !== 0; }), '渲染不得显示缺失文案键');
          const hud = Scene.ui.coach(sim);
          assert(hud.status === Game.I18N.t('scene.braking.hud.queue', { meters: 12 }), 'HUD 低速读数应与 Canvas 一致');
          texts.length = 0;
        });
      });
      const frozen = conflictSimulation('highway', 100, 8, 0);
      frozen.status = 'frozen';
      Scene.Renderer.render(ctx, frozen);
      const demo = conflictSimulation('rain', 80, 30, 20);
      demo.demo = new Scene.Simulation('render-demo');
      useEvent(demo.demo, 2);
      Scene.Renderer.render(ctx, demo);
      assert(clears === 8, '三段双语、定格和示范均应通过静态 render 接口清屏绘制');
      Game.I18N.setLanguage('zh-CN');
    });

    test('03 动态教学、失败、重试和示范文案均有中英文', function () {
      const sim = run('braking-i18n', Scene.defensiveInput);
      const summary = Scene.Scoring.summarize(sim, false);
      const keys = [summary.adviceKey, 'scene.braking.failure.reason', 'scene.braking.failure.reasonLegal',
        'scene.braking.hud.distantBraking', 'scene.braking.hud.necessaryStop',
        'scene.braking.demo.gap', 'scene.braking.demo.brakeSub', 'scene.braking.canvas.legal',
        'scene.braking.hud.queue', 'scene.braking.canvas.queueReadout'];
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        keys.forEach(function (key) {
          const text = Game.I18N.t(key, { seconds: 4, gap: '2.0', meters: 30, speed: 80, distance: 60, target: '4.0', reference: 89, legal: 50 });
          assert(text && text !== key, lang + ' 缺少文案 ' + key);
        });
        const retry = Scene.ui.retryToast(sim);
        assert(Game.I18N.t(retry.key, retry.params) !== retry.key, lang + ' 缺少场景专属重试提示');
      });
      Game.I18N.setLanguage('zh-CN');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.BrakingTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
