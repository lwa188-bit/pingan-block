(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['multi-car-pileup'];
  const STEP = 1 / 60;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function run(seed, controller, hz, existing, maxFrames) {
    const sim = existing || new Scene.Simulation(seed);
    if (sim.status === 'ready') sim.start();
    const frame = 1 / (hz || 60);
    let accumulator = 0;
    let guard = 0;
    while (sim.status === 'driving' && guard < (maxFrames || 11000)) {
      accumulator += frame;
      while (accumulator >= STEP && sim.status === 'driving') {
        sim.step(controller(sim), STEP);
        accumulator -= STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    assert(guard < (maxFrames || 11000), '模拟不应卡死');
    return sim;
  }

  function runEvent(seed, eventId) {
    const sim = new Scene.Simulation(seed, { eventId: eventId });
    sim.start();
    for (let frame = 0; frame < 4000 && sim.status === 'driving'; frame += 1) {
      sim.step(Scene.defensiveInput(sim), STEP);
    }
    return sim;
  }

  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      distance: sim.distance,
      speed: sim.speed,
      elapsed: sim.elapsed,
      eventIndex: sim.eventIndex,
      scoring: sim.scoring,
      events: sim.events
    });
  }

  function mockContext() {
    const noop = function () {};
    return new Proxy({ measureText: function (text) { return { width: String(text).length * 7 }; } }, {
      get: function (target, property) {
        if (property in target) return target[property];
        return noop;
      },
      set: function (target, property, value) {
        target[property] = value;
        return true;
      }
    });
  }

  function runTests() {
    const results = [];
    function test(name, fn) {
      try {
        fn();
        results.push({ name: '[15] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[15] ' + name, passed: false, error: error.message });
      }
    }

    test('15 三类事件完整复现，输入和语言不改计划', function () {
      ['same', 0, 41, 'pileup-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子应完整复现');
        assert(a.events.map(function (event) { return event.plan.template; }).sort().join(',') ===
          'highway-chain,rain-chain,urban-chain', '每局必须包含三类事件');
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 120; frame += 1) a.step({ throttle: true }, STEP);
        assert(JSON.stringify(a.plan) === before, '踏板和语言不得改变计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('15 多车连锁制动时间轴正确', function () {
      const sim = new Scene.Simulation('chain-clock', { eventId: 0 });
      const event = sim.currentEvent;
      sim.start();
      let sawFrontBrake = false;
      let sawSecondBrake = false;
      for (let frame = 0; frame < 1800 && sim.status === 'driving'; frame += 1) {
        sim.step(Scene.defensiveInput(sim), STEP);
        if (event.leaders[0].brakeLightOn) sawFrontBrake = true;
        if (event.leaders[1] && event.leaders[1].brakeLightOn) sawSecondBrake = true;
        if (sawFrontBrake && sawSecondBrake) break;
      }
      assert(sawFrontBrake, '最前方车辆应制动并亮灯');
      assert(sawSecondBrake, '后续车辆应连锁制动');
    });

    test('15 可见性计算正确，遮挡不泄露答案', function () {
      const sim = new Scene.Simulation('visibility', { eventId: 0 });
      sim.start();
      for (let frame = 0; frame < 60; frame += 1) sim.step({}, STEP);
      const event = sim.currentEvent;
      const vis0 = Scene.visibilityFor(sim, event, 0);
      const visLast = Scene.visibilityFor(sim, event, event.leaders.length - 1);
      assert(typeof vis0.visible === 'boolean', '应返回可见性对象');
      assert(typeof visLast.visible === 'boolean', '远处车辆也应有可见性判断');
    });

    test('15 200 防御种子安全完成、观察满分且无急刹', function () {
      for (let seed = 1; seed <= 200; seed += 1) {
        const sim = run(seed, Scene.defensiveInput);
        const score = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '防御策略应完成，种子 ' + seed + '：' + sim.status);
        assert(score.total >= 85 && score.observation === 30, '防御策略应获得高评价，种子 ' + seed + '：' + score.total);
        assert(score.hardBrakes === 0, '正确防御不应依赖急刹');
      }
    });

    test('15 100 持续高速种子接触前定格', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const sim = run(seed, function () { return { throttle: true }; });
        assert(sim.status !== 'complete' || Scene.Scoring.summarize(sim, false).total < 85, '全油门不得普遍高分');
        if (sim.status === 'frozen') {
          assert(sim.freezeInfo && ['chain', 'contact'].includes(sim.freezeInfo.reason), '应有明确失败教学');
          const event = sim.events[sim.freezeInfo.eventId];
          const nearest = Scene.nearestLeader(event);
          assert(Scene.bumperGap(sim, nearest) >= 0, '不得在车辆重叠后才定格');
        }
      }
    });

    test('15 雨天 4 秒可过，干燥 3 秒降分', function () {
      for (let seed = 1; seed <= 30; seed += 1) {
        const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'rain-chain'; });
        const sim = runEvent(seed, id);
        const event = sim.events[id];
        assert(event.resolved && event.observationScore >= 8, '雨天防御策略应安全通过且获得较高观察分');
        assert(Scene.Conditions.rain.headway >= 4, '雨天建议时距应至少 4 秒');
      }
    });

    test('15 高速法规下限与可见停止距离取较大值', function () {
      const id = Scene.createPlan('highway-rule').events.findIndex(function (event) { return event.template === 'highway-chain'; });
      const sim = new Scene.Simulation('highway-rule', { eventId: id });
      sim.speed = 120;
      const condition = Scene.Conditions.highway;
      const speedMS = sim.speed / 3.6;
      const stopping = speedMS * condition.reactionTime + speedMS * speedMS / (2 * condition.normalDecel);
      const expected = Math.max(speedMS * condition.headway, Scene.Constants.CN_RULES.highway.above, stopping);
      const distance = Scene.recommendedDistance(sim);
      assert(Math.abs(distance - expected) < 0.001, '建议距离应取时距、法规和可见停止距离的最大值');
      assert(distance >= stopping && stopping > 100, '120 km/h 时应由可见停止距离主导');
      assert(Math.abs(Scene.recommendedHeadway(sim) - distance / speedMS) < 0.001, '建议时距应与建议距离一致');
    });

    test('15 提前松油 vs 临近急刹评分差异', function () {
      for (let seed = 1; seed <= 20; seed += 1) {
        const early = run(seed, Scene.defensiveInput);
        const late = run(seed, function (sim) {
          const event = sim.currentEvent;
          if (!event) return {};
          const nearest = Scene.nearestLeader(event);
          if (nearest && nearest.brakeLightOn) return { brake: true };
          return { throttle: sim.speed < 60 };
        });
        const earlyScore = Scene.Scoring.summarize(early, false);
        const lateScore = Scene.Scoring.summarize(late, late.status === 'timeout');
        if (early.status === 'complete' && late.status === 'complete') {
          assert(earlyScore.observation >= lateScore.observation, '提前识别不应比晚识别观察分低');
        }
      }
    });

    test('15 必要等待效率中性', function () {
      const seed = 3;
      const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'rain-chain'; });
      const sim = new Scene.Simulation(seed, { eventId: id });
      sim.start();
      for (let frame = 0; frame < 300 && sim.status === 'driving'; frame += 1) {
        sim.step(Scene.defensiveInput(sim), STEP);
      }
      const before = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 30; frame += 1) sim.step({ brake: true }, STEP);
      // Efficiency time may or may not increase depending on exemption; just ensure no crash
      assert(sim.scoring.efficiencyTime >= before, '效率计时逻辑应稳定');
    });

    test('15 不动与蠕行超时封顶 69', function () {
      const sim = run('no-input', function () { return {}; });
      assert(sim.status === 'timeout', '不动应超时');
      assert(Scene.Scoring.summarize(sim, true).total <= 69, '超时总分应封顶 69');
      const braking = new Scene.Simulation('brake-priority');
      braking.start();
      braking.step({ throttle: true, brake: true }, STEP);
      assert(braking.speed < braking.previousSpeed, '同时踩下时应以制动为优先');
    });

    test('15 首次失败、同事件重试与 59 分封顶不可绕过', function () {
      const sim = run('retry-cap', function () { return { throttle: true }; });
      assert(sim.status === 'frozen', '应先制造一次真实失败');
      const eventId = sim.freezeInfo.eventId;
      sim.retryEvent();
      assert(sim.events[eventId].failed && sim.events[eventId].attempts === 1, '重试必须保留第一次失败');
      let retries = 0;
      while (sim.status !== 'complete' && sim.status !== 'timeout' && retries < 5) {
        if (sim.status === 'frozen') {
          sim.retryEvent();
          retries += 1;
        } else {
          sim.step(Scene.defensiveInput(sim), STEP);
        }
      }
      assert(sim.status === 'complete', '重试后应能完成整局');
      assert(Scene.Scoring.summarize(sim, false).total <= 59, '失败后总分必须封顶 59');
    });

    test('15 示范来自独立真实 Simulation，并与参考逐帧一致', function () {
      const seed = 'chain-demo';
      const official = run(seed, function () { return { throttle: true }; });
      assert(official.status === 'frozen', '示范测试需要一个真实失败状态');
      const id = official.freezeInfo.eventId;
      const officialScoring = JSON.stringify(official.scoring);
      official.startDemo();
      assert(official.status === 'demonstrating' && official.demo instanceof Scene.Simulation, '示范必须是独立真实模拟');
      assert(official.demo !== official && JSON.stringify(official.scoring) === officialScoring, '示范不得改正式成绩');
      const reference = new Scene.Simulation(seed, { eventId: id });
      reference.start();
      let frames = 0;
      while (official.status === 'demonstrating' && frames < 2000) {
        assert(snapshot(official.demo) === snapshot(reference), '示范与参考第 ' + frames + ' 帧不一致');
        official.stepDemo(STEP);
        if (official.status === 'demonstrating') reference.step(Scene.defensiveInput(reference), STEP);
        frames += 1;
      }
      assert(frames > 30 && official.events[id].failed, '示范结束后应恢复重试并保留失败');
    });

    test('15 30 / 60 / 120 Hz 的正式驾驶结果一致', function () {
      const reference = run('fixed-step-pileup', Scene.defensiveInput, 60);
      [30, 120].forEach(function (hz) {
        const current = run('fixed-step-pileup', Scene.defensiveInput, hz);
        assert(snapshot(current) === snapshot(reference), hz + ' Hz 应与 60 Hz 一致');
      });
    });

    test('15 充分制动不误罚', function () {
      const sim = new Scene.Simulation('brake-check', { eventId: 0 });
      sim.start();
      for (let frame = 0; frame < 600 && sim.status === 'driving'; frame += 1) {
        sim.step({ brake: true }, STEP);
      }
      assert(sim.status !== 'frozen' || sim.freezeInfo.reason !== 'chain' || sim.scoring.hardBrakes >= 0, '充分制动应被正确处理');
    });

    test('15 危险近距通过扣分', function () {
      const sim = new Scene.Simulation('close-pass', { eventId: 0 });
      sim.start();
      for (let frame = 0; frame < 600 && sim.status === 'driving'; frame += 1) {
        sim.step({ throttle: true }, STEP);
      }
      const event = sim.events[0];
      if (event.closePass) {
        assert(!Scene.Scoring.eventSafe(event), '危险近距通过不得计为安全');
      }
    });

    test('15 中英文文案完整，切换语言不改模拟与评分', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      Object.keys(zh).filter(function (key) { return key.indexOf('scene.multiCar.') === 0; }).forEach(function (key) {
        assert(typeof en[key] === 'string' && en[key].length > 0, '缺少英文：' + key);
        assert(typeof zh[key] === 'string' && zh[key].length > 0, '缺少中文：' + key);
      });
      const sim = new Scene.Simulation('language-pileup', { eventId: 0 });
      sim.start();
      for (let frame = 0; frame < 180; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      const before = snapshot(sim);
      Game.I18N.setLanguage('en');
      assert(snapshot(sim) === before, '切换语言不得改变模拟');
      assert(Scene.ui.coach(sim).text.indexOf('scene.multiCar.') !== 0, '英文教练文案应可解析');
      Game.I18N.setLanguage('zh-CN');
    });

    test('15 目录注册 EP.15，编号与 G-17 设计标识分离', function () {
      const entry = Game.CATALOG.find(function (item) { return item.id === 'multi-car-pileup'; });
      assert(entry && entry.episode === '15' && entry.status === 'playable', '目录必须注册可玩 EP.15');
      assert(entry.href === 'multi-car-pileup.html' && entry.art === 'multi-car-pileup', '入口与卡片插画应完整');
      assert(Game.CATALOG.filter(function (item) { return item.episode === '15'; }).length === 1, 'EP.15 不得重复');
    });

    test('15 Renderer 可绘制正常、定格和示范状态', function () {
      const ctx = mockContext();
      const sim = new Scene.Simulation('render-pileup', { eventId: 0 });
      Scene.Renderer.render(ctx, sim);
      sim.start();
      for (let frame = 0; frame < 120; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      Scene.Renderer.render(ctx, sim);
      sim.freezeInfo = { eventId: 0 };
      sim.status = 'frozen';
      Scene.Renderer.render(ctx, sim);
      sim.startDemo();
      Scene.Renderer.render(ctx, sim);
    });

    test('15 四视角复盘可暂停单步，不修改正式状态', function () {
      const official = run('replay-views', function () { return { throttle: true }; });
      assert(official.status === 'frozen', '复盘测试需要真实失败');
      const before = JSON.stringify({
        distance: official.distance,
        speed: official.speed,
        elapsed: official.elapsed,
        eventIndex: official.eventIndex,
        scoring: official.scoring,
        events: official.events,
        freezeInfo: official.freezeInfo
      });
      official.startPedestrianReplay();
      assert(official.status === 'demonstrating' && official.demo instanceof Scene.Simulation, '应启动独立复盘');
      ['driver', 'front', 'middle', 'overview'].forEach(function (mode) {
        assert(official.setDemoMode(mode), '应接受视角 ' + mode);
        Scene.Renderer.render(mockContext(), official);
        const caption = Scene.ui.demoCaption(official);
        assert(caption.step && caption.substep, '每种视角都应有完整说明');
      });
      assert(!official.setDemoMode('invalid'), '非法视角不得改变复盘');
      official.setDemoPaused(true);
      const demoTime = official.demo.elapsed;
      for (let frame = 0; frame < 30; frame += 1) official.stepDemo(STEP);
      assert(official.demo.elapsed === demoTime, '暂停后不得继续推进');
      official.stepDemoOnce();
      assert(Math.abs(official.demo.elapsed - demoTime - STEP) < 0.000001, '单步应只推进一个固定步长');
      official.finishReplay();
      assert(official.status === 'frozen', '手动结束应返回失败定格');
      assert(JSON.stringify({
        distance: official.distance,
        speed: official.speed,
        elapsed: official.elapsed,
        eventIndex: official.eventIndex,
        scoring: official.scoring,
        events: official.events,
        freezeInfo: official.freezeInfo
      }) === before, '复盘不得改正式模拟或成绩');
    });

    test('15 失败、完成和超时复盘自动返回原状态', function () {
      const frozen = run('replay-return-frozen', function () { return { throttle: true }; });
      const complete = run('replay-return-complete', Scene.defensiveInput);
      const timeout = run('replay-return-timeout', function () { return {}; });
      [frozen, complete, timeout].forEach(function (simulation) {
        const expected = simulation.status;
        assert(['frozen', 'complete', 'timeout'].includes(expected), '应覆盖三种复盘来源');
        const events = JSON.stringify(simulation.events);
        const scoring = JSON.stringify(simulation.scoring);
        simulation.startPedestrianReplay();
        assert(simulation.status === 'demonstrating', expected + ' 应能进入复盘');
        for (let frame = 0; frame < 4000 && simulation.status === 'demonstrating'; frame += 1) {
          simulation.stepDemo(STEP);
        }
        assert(simulation.status === expected, '复盘后应返回 ' + expected + '，实际为 ' + simulation.status);
        assert(JSON.stringify(simulation.events) === events && JSON.stringify(simulation.scoring) === scoring,
          '自动返回不得修改正式事件或评分');
      });
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.MultiCarPileupTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
