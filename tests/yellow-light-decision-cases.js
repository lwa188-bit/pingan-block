(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['yellow-light-decision'];
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

  function runEvent(seed, eventId, branch) {
    const sim = new Scene.Simulation(seed, { eventId: eventId });
    sim.start();
    for (let frame = 0; frame < 2600 && sim.status === 'driving'; frame += 1) {
      sim.step(Scene.defensiveInput(sim, branch), STEP);
    }
    return sim;
  }

  function observe(sim) {
    const event = sim.currentEvent;
    if (event && event.active && !event.rearObserved && event.localTime >= 0.35) sim.setView('rear');
    else sim.setView('front');
  }

  function alwaysProceed(sim) {
    observe(sim);
    return { throttle: sim.speed < 46.5, brake: false };
  }

  function alwaysStop(sim) {
    observe(sim);
    const event = sim.currentEvent;
    if (!event) return {};
    if (event.properStop && event.waitedForGreen) return { throttle: sim.speed < 46.5 };
    if (event.assessment || Scene.signalPhase(event) === 'red') return { brake: sim.speed > 0.25 };
    return { throttle: sim.speed < 46.5, brake: false };
  }

  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      distance: sim.distance,
      speed: sim.speed,
      elapsed: sim.elapsed,
      eventIndex: sim.eventIndex,
      view: sim.view,
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
        results.push({ name: '[13] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[13] ' + name, passed: false, error: error.message });
      }
    }

    test('13 三类路口完整复现，输入和语言不改信号及后车计划', function () {
      ['same', 0, 41, 'yellow-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子应完整复现');
        assert(a.events.map(function (event) { return event.template; }).sort().join(',') ===
          'clear-stop,dual-choice,no-abrupt-stop', '每局必须包含三类路口');
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 120; frame += 1) a.step({ throttle: true }, STEP);
        assert(JSON.stringify(a.plan) === before, '踏板和语言不得改变计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('13 信号按绿、黄、红、绿推进，踏板与视野不改变相位', function () {
      const sim = new Scene.Simulation('signal-clock', { eventId: 0 });
      const event = sim.currentEvent;
      sim.start();
      while (event.localTime < event.yellowAt - 0.02) sim.step({ throttle: true }, 0.01);
      assert(Scene.signalPhase(event) === 'green', '黄灯前应为绿灯');
      sim.setView('rear');
      sim.step({ brake: true }, 0.03);
      assert(Scene.signalPhase(event) === 'yellow', '到达计划时刻应转黄');
      event.localTime = event.yellowAt + event.yellowDuration;
      assert(Scene.signalPhase(event) === 'red', '黄灯结束应转红');
      event.localTime = event.greenAt;
      assert(Scene.signalPhase(event) === 'green', '红灯结束应重新放行');
      assert(event.crossReleaseAt < event.greenAt, '全红清空应早于下一绿灯');
    });

    test('13 评估器区分停车、通过和双解，双解不靠加速成立', function () {
      let dualCount = 0;
      for (let seed = 1; seed <= 100; seed += 1) {
        const plan = Scene.createPlan(seed);
        for (let id = 0; id < 3; id += 1) {
          if (plan.events[id].template !== 'dual-choice') continue;
          dualCount += 1;
          const sim = new Scene.Simulation(seed, { eventId: id });
          sim.start();
          while (!sim.currentEvent.assessment && sim.status === 'driving') sim.step(Scene.defensiveInput(sim), STEP);
          const assessment = sim.currentEvent.assessment;
          assert(assessment && assessment.stopSafe && assessment.proceedSafe, '双解事件必须真实具有两条安全路径');
          assert(assessment.timeToClear < plan.events[id].crossReleaseAt - sim.currentEvent.localTime,
            '通过余量必须按当前速度成立');
        }
      }
      assert(dualCount === 100, '应验证一百个双解事件');
    });

    test('13 200 个防御种子安全完成，观察满分且无急刹或抢加速', function () {
      for (let seed = 1; seed <= 200; seed += 1) {
        const sim = run(seed, Scene.defensiveInput);
        const score = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '防御策略应完成，种子 ' + seed + '：' + sim.status);
        assert(score.total >= 85 && score.observation === 30, '防御策略应获得高评价，种子 ' + seed + '：' + score.total);
        assert(score.hardBrakes === 0 && sim.scoring.rushPenalties === 0, '正确防御不应依赖急刹或抢加速');
      }
    });

    test('13 100 个双解事件停车与通过均得满分，效率不偏向通过', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'dual-choice'; });
        const stopping = runEvent(seed, id, 'stop');
        const proceeding = runEvent(seed, id, 'proceed');
        const stopEvent = stopping.events[id];
        const proceedEvent = proceeding.events[id];
        assert(stopEvent.resolved && stopEvent.observation === 10 && stopEvent.resolvedBranch === 'stop', '停车路径应完整成立');
        assert(proceedEvent.resolved && proceedEvent.observation === 10 && proceedEvent.resolvedBranch === 'proceed', '通过路径应完整成立');
        const stopScore = Scene.Scoring.summarize(stopping, false);
        const proceedScore = Scene.Scoring.summarize(proceeding, false);
        assert(Math.abs(stopScore.efficiencyRaw - proceedScore.efficiencyRaw) < 1, '双解路径效率基准应公平');
      }
    });

    test('13 永远停车与永远通过都不是通用高分答案', function () {
      for (let seed = 1; seed <= 50; seed += 1) {
        const stopping = run(seed, alwaysStop);
        const proceeding = run(seed, alwaysProceed);
        const stopScore = Scene.Scoring.summarize(stopping, stopping.status === 'timeout');
        assert(stopping.status !== 'complete' || stopScore.total < 85, '永远停车不得稳定高分');
        assert(proceeding.status !== 'complete' || Scene.Scoring.summarize(proceeding, false).total < 85,
          '永远通过不得稳定高分');
      }
    });

    test('13 100 个持续全油门种子不会普遍高分，危险在接触前定格', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const sim = run(seed, function () { return { throttle: true }; });
        assert(sim.status !== 'complete' || Scene.Scoring.summarize(sim, false).total < 85, '全油门不得普遍高分');
        if (sim.status === 'frozen') {
          assert(sim.freezeInfo && ['rear', 'redEntry', 'cross'].includes(sim.freezeInfo.reason), '应有明确失败教学');
          assert(Scene.rearGap(sim, sim.events[sim.freezeInfo.eventId]) >= 0, '不得在车辆重叠后才定格');
        }
      }
    });

    test('13 黄灯后抢加速比同条件平稳通过失分', function () {
      for (let seed = 1; seed <= 20; seed += 1) {
        const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'dual-choice'; });
        const steady = runEvent(seed, id, 'proceed');
        const rushed = new Scene.Simulation(seed, { eventId: id });
        rushed.start();
        for (let frame = 0; frame < 2600 && rushed.status === 'driving'; frame += 1) {
          let input = Scene.defensiveInput(rushed, 'proceed');
          const event = rushed.currentEvent;
          if (event && event.assessment && event.localTime < event.yellowAt + 1.2) input = { throttle: true };
          rushed.step(input, STEP);
        }
        assert(steady.events[id].observation === 10, '平稳通过基准应满分');
        assert(rushed.events[id].observation < 10 && rushed.events[id].rushAcceleration, '抢加速必须留下独立扣分记录');
        assert(rushed.scoring.rushPenalties > 0, '抢加速应影响平稳分');
      }
    });

    test('13 后视点击本身不得分，关键阶段持续观察才记录', function () {
      const sim = new Scene.Simulation('rear-dwell', { eventId: 0 });
      const event = sim.currentEvent;
      sim.setView('rear');
      sim.updateObservation(event, 0.1);
      sim.updateObservation(event, 0.1);
      assert(!event.rearObserved, '短暂点击不得刷观察分');
      sim.updateObservation(event, 0.11);
      assert(event.rearObserved, '达到有效停留后应记录观察');
      event.decisionMade = true;
      const before = event.rearScanStreak;
      sim.updateObservation(event, 1);
      assert(event.rearScanStreak === 0 && before >= 0.3, '决策后补看不得继续累计');
    });

    test('13 近后跟车时临近重刹形成真实风险，充分制动不提前误判', function () {
      const seed = 7;
      const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'no-abrupt-stop'; });
      const sim = new Scene.Simulation(seed, { eventId: id });
      sim.start();
      while (!sim.currentEvent.assessment && sim.status === 'driving') sim.step(Scene.defensiveInput(sim), STEP);
      assert(!sim.currentEvent.assessment.stopSafe, '测试局面应不宜舒适急停');
      const late = run(seed, function (current) {
        if (current.eventIndex !== id) return Scene.defensiveInput(current);
        const event = current.currentEvent;
        if (event && event.assessment && !event.properStop) return { brake: current.speed > 0.25 };
        return Scene.defensiveInput(current);
      });
      assert(late.status !== 'complete' || Scene.Scoring.summarize(late, false).total < 85, '不宜急停时强行停车不得高分');
      const safe = runEvent(seed, id, 'proceed');
      assert(safe.events[id].resolved && safe.events[id].observation === 10, '保持平稳通过应安全完成');
    });

    test('13 必要红灯等待效率中性，放行后无故停车恢复计时', function () {
      const seed = 3;
      const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'clear-stop'; });
      const sim = new Scene.Simulation(seed, { eventId: id });
      sim.start();
      while (sim.status === 'driving' && !(sim.currentEvent.properStop && !sim.currentEvent.waitedForGreen)) {
        sim.step(Scene.defensiveInput(sim), STEP);
      }
      assert(sim.currentEvent.properStop, '应先在停止线前停稳');
      const exemptTime = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 60 && !sim.currentEvent.waitedForGreen; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.scoring.efficiencyTime === exemptTime, '红灯与必要停稳等待不得计入效率损失');
      while (!sim.currentEvent.waitedForGreen && sim.status === 'driving') sim.step({ brake: true }, STEP);
      while (!sim.currentEvent.resumeSpeedReached && sim.status === 'driving') sim.step(Scene.defensiveInput(sim), STEP);
      const resumedTime = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 60; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.scoring.efficiencyTime > resumedTime, '放行后无故停车必须恢复效率计时');
    });

    test('13 停稳后抢起步不能获得完整执行评价', function () {
      const seed = 4;
      const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'dual-choice'; });
      const sim = new Scene.Simulation(seed, { eventId: id });
      sim.start();
      while (sim.status === 'driving' && !sim.currentEvent.properStop) sim.step(Scene.defensiveInput(sim, 'stop'), STEP);
      assert(sim.currentEvent.properStop && !sim.currentEvent.waitedForGreen, '应处于红灯前停稳状态');
      while (sim.status === 'driving') sim.step({ throttle: true }, STEP);
      assert(sim.events[id].earlyStart || sim.events[id].enteredAgainstRule, '提前起步必须被记录');
      assert(!sim.events[id].execution, '提前起步不得获得执行分');
    });

    test('13 不动会超时并封顶，踏板同时输入时制动优先', function () {
      const sim = run('no-input', function () { return {}; });
      assert(sim.status === 'timeout', '不动应超时');
      assert(Scene.Scoring.summarize(sim, true).total <= 69, '超时总分应封顶 69');
      const braking = new Scene.Simulation('brake-priority');
      braking.start();
      braking.step({ throttle: true, brake: true }, STEP);
      assert(braking.speed < braking.previousSpeed, '同时踩下时应以制动为优先');
    });

    test('13 首次失败、同事件重试与 59 分封顶不可绕过', function () {
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

    test('13 双解示范来自独立真实 Simulation，并与参考逐帧一致', function () {
      const seed = 'dual-demo';
      const id = Scene.createPlan(seed).events.findIndex(function (event) { return event.template === 'dual-choice'; });
      ['stop', 'proceed'].forEach(function (branch) {
        const official = runEventFailure(seed, id);
        const officialScoring = JSON.stringify(official.scoring);
        official.startDemo(branch);
        assert(official.status === 'demonstrating' && official.demo instanceof Scene.Simulation, '示范必须是独立真实模拟');
        assert(official.demo !== official && JSON.stringify(official.scoring) === officialScoring, '示范不得改正式成绩');
        const reference = new Scene.Simulation(seed, { eventId: id });
        reference.start();
        reference.demoBranch = branch;
        let frames = 0;
        while (official.status === 'demonstrating' && frames < 2000) {
          assert(snapshot(official.demo) === snapshot(reference), branch + ' 示范与参考第 ' + frames + ' 帧不一致');
          official.stepDemo(STEP);
          if (official.status === 'demonstrating') reference.step(Scene.defensiveInput(reference, branch), STEP);
          frames += 1;
        }
        assert(frames > 30 && official.events[id].failed, '示范结束后应恢复重试并保留失败');
      });
    });

    test('13 30 / 60 / 120 Hz 的正式驾驶结果一致', function () {
      const reference = run('fixed-step-yellow', Scene.defensiveInput, 60);
      [30, 120].forEach(function (hz) {
        const current = run('fixed-step-yellow', Scene.defensiveInput, hz);
        assert(snapshot(current) === snapshot(reference), hz + ' Hz 应与 60 Hz 一致');
      });
    });

    test('13 前视、后视、定格和两种示范均可绘制', function () {
      const ctx = mockContext();
      const sim = new Scene.Simulation('render-yellow', { eventId: 0 });
      Scene.Renderer.render(ctx, sim);
      sim.setView('rear');
      Scene.Renderer.render(ctx, sim);
      sim.freezeInfo = { eventId: 0 };
      sim.status = 'frozen';
      Scene.Renderer.render(ctx, sim);
      ['stop', 'proceed'].forEach(function (branch) {
        sim.startDemo(branch);
        Scene.Renderer.render(ctx, sim);
      });
    });

    test('13 中英文文案完整，切换语言不改模拟与评分', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      Object.keys(zh).filter(function (key) { return key.indexOf('scene.yellow.') === 0; }).forEach(function (key) {
        assert(typeof en[key] === 'string' && en[key].length > 0, '缺少英文：' + key);
        assert(typeof zh[key] === 'string' && zh[key].length > 0, '缺少中文：' + key);
      });
      const sim = new Scene.Simulation('language-yellow', { eventId: 0 });
      sim.start();
      for (let frame = 0; frame < 180; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      const before = snapshot(sim);
      Game.I18N.setLanguage('en');
      assert(snapshot(sim) === before, '切换语言不得改变模拟');
      assert(Scene.ui.coach(sim).text.indexOf('scene.yellow.') !== 0, '英文教练文案应可解析');
      Game.I18N.setLanguage('zh-CN');
    });

    test('13 目录注册 EP.13，编号与 G-14 设计标识分离', function () {
      const entry = Game.CATALOG.find(function (item) { return item.id === 'yellow-light-decision'; });
      assert(entry && entry.episode === '13' && entry.status === 'playable', '目录必须注册可玩 EP.13');
      assert(entry.href === 'yellow-light-decision.html' && entry.art === 'yellow-light-decision', '入口与卡片插画应完整');
      assert(Game.CATALOG.filter(function (item) { return item.episode === '13'; }).length === 1, 'EP.13 不得重复');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  function runEventFailure(seed, eventId) {
    const sim = new Scene.Simulation(seed, { eventId: eventId });
    sim.start();
    for (let frame = 0; frame < 2000 && sim.status === 'driving'; frame += 1) {
      const waitingForRed = sim.currentEvent && Scene.signalPhase(sim.currentEvent) !== 'red';
      sim.step(waitingForRed ? {} : { throttle: true }, STEP);
    }
    assert(sim.status === 'frozen', '示范测试需要一个真实失败状态');
    return sim;
  }

  root.YellowLightDecisionTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
