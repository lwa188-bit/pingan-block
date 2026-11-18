(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['red-light-runner'];
  const STEP = 1 / 60;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function run(seed, controller, hz, existing) {
    const sim = existing || new Scene.Simulation(seed);
    if (sim.status === 'ready') sim.start();
    const frame = 1 / (hz || 60);
    let accumulator = 0;
    let guard = 0;
    while (sim.status === 'driving' && guard < 16000) {
      accumulator += frame;
      while (accumulator >= STEP && sim.status === 'driving') {
        sim.step(controller(sim), STEP);
        accumulator -= STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    assert(guard < 16000, '模拟不应卡死');
    return sim;
  }

  function earlyStartController(sim) {
    const event = sim.currentEvent;
    if (sim.eventIndex === 2 && event.runners[0].routeClear) {
      sim.setView('left');
      return { throttle: true };
    }
    return Scene.defensiveInput(sim);
  }

  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      elapsed: sim.elapsed,
      player: sim.player,
      view: sim.view,
      scoring: sim.scoring,
      events: sim.events.map(function (event) {
        return {
          runners: event.runners,
          resolved: event.resolved,
          failed: event.failed,
          attempts: event.attempts,
          initialObserved: event.initialObserved,
          properStop: event.properStop,
          waitedUntilClear: event.waitedUntilClear,
          clearConfirmed: event.clearConfirmed,
          earlyStart: event.earlyStart,
          observation: event.observation
        };
      })
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
        results.push({ name: '[11] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[11] ' + name, passed: false, error: error.message });
      }
    }

    test('11 三处路口都有真实闯灯车，种子和语言不改变交通计划', function () {
      ['same', 0, 41, 'runner-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子应完整复现');
        assert(a.events.map(function (event) { return event.kind; }).join(',') === 'open-left,occluded-right,follow',
          '应依次包含左侧、右侧遮挡和连续两辆来车');
        assert(a.events[2].runners.length === 2, '第三路口必须有两辆独立车辆');
        a.events.forEach(function (event) {
          event.runners.forEach(function (runner) {
            assert(runner.baseSpeed >= 48 && runner.baseSpeed <= 56 && !runner.routeClear, '每辆都应有真实高速运动');
          });
        });
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 120; frame += 1) a.step({ throttle: true }, STEP);
        assert(JSON.stringify(a.plan) === before, '输入和语言不得改写计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('11 清空方向与真实车身几何一致，左侧起点不会提前清空', function () {
      const sim = new Scene.Simulation('clear-direction');
      const left = sim.events[0].runners[0];
      assert(!left.routeClear && left.x < 0, '左侧车辆必须从真实道路外接近');
      while (!left.routeClear) Scene.Geometry.advanceRunner(left, STEP);
      assert(left.x - Scene.Constants.RUNNER_HALF_WIDTH > Scene.Constants.CAR_X + 36,
        '左到右车辆必须完整越过本车路径');
      const right = sim.events[1].runners[0];
      while (!right.routeClear) Scene.Geometry.advanceRunner(right, STEP);
      assert(right.x + Scene.Constants.RUNNER_HALF_WIDTH < Scene.Constants.CAR_X - 36,
        '右到左车辆必须完整越过本车路径');
      const player = { x: 180, y: 300 };
      assert(Scene.Geometry.vehicleClearance(player, { x: 180, y: 300 }) <= 0, '重叠车身应判定接触');
      assert(Scene.Geometry.vehicleClearance(player, { x: 180, y: 200 }) > 0, '分离车身不得判定接触');
    });

    test('11 切换按钮本身不得分，真实可见并连续停留才记录观察', function () {
      const sim = new Scene.Simulation('visible-runner');
      sim.start();
      sim.player.y = 500;
      sim.player.speed = 0;
      sim.speed = 0;
      sim.currentEvent.runners[0].x = -80;
      assert(!Scene.visibilityFor(sim, sim.currentEvent, 'front'), '左侧来车不应出现在狭窄前视中');
      assert(Scene.visibilityFor(sim, sim.currentEvent, 'left'), '左侧来车应进入左视锥');
      sim.setView('left');
      assert(!sim.currentEvent.initialObserved, '只点击视野按钮不能得分');
      for (let frame = 0; frame < 20; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.currentEvent.initialObserved, '目标连续可见后才能记为有效观察');
      assert(sim.currentEvent.runners[0].observationStreak >= Scene.Constants.SCAN_DWELL, '应记录连续可见时长');
      assert(sim.currentEvent.scanDwells.left >= Scene.Constants.SCAN_DWELL, '应记录真实左侧扫视');
      assert(sim.currentEvent.scanDwells.right === 0, '左视不能替代右侧扫视');
    });

    test('11 视野切换不暂停世界，排队车形成真实动态遮挡', function () {
      const sim = new Scene.Simulation('occlusion', { eventId: 1 });
      sim.start();
      sim.player.y = 449;
      sim.player.speed = 0;
      sim.speed = 0;
      sim.setView('right');
      const runner = sim.currentEvent.runners[0];
      const initialX = runner.x;
      let sawVisible = false;
      let sawOccluded = false;
      for (let frame = 0; frame < 180; frame += 1) {
        const visible = Scene.visibilityFor(sim, sim.currentEvent, 'right', runner);
        sawVisible = sawVisible || visible;
        if (frame > 20 && frame < 100) sawOccluded = sawOccluded || !visible;
        sim.step({}, STEP);
      }
      assert(runner.x !== initialX, '观察视野不得暂停横向车辆');
      assert(sawVisible && sawOccluded, '应存在先可见、再被排队车遮挡的真实过程');
      const obstacle = Scene.Geometry.obstaclesFor(sim.currentEvent)[0];
      assert(Scene.Geometry.segmentIntersectsRect({ x: 192, y: 437 }, { x: 400, y: 300 }, obstacle),
        '中间接近过程的视线应穿过遮挡车');
    });

    test('11 200 个防御种子全部安全完成、观察满分且总分至少 85', function () {
      for (let index = 0; index < 200; index += 1) {
        const sim = run('rlr-defense-' + index, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '种子 ' + index + ' 应完成：' + sim.status);
        assert(result.observation === 30, '种子 ' + index + ' 应观察满分');
        assert(result.safety === 40 && result.total >= 85, '种子 ' + index + ' 得分异常：' + result.total);
      }
    });

    test('11 防御过程真实停稳，第三路口观察并等待两辆车', function () {
      const sim = run('complete-yield', Scene.defensiveInput);
      sim.events.forEach(function (event) {
        assert(event.properStop && event.waitedUntilClear && event.clearConfirmed, '每个路口都应真实停稳并确认清空');
        assert(Scene.scanComplete(event) && event.initialObserved && !event.earlyStart, '扫视、识别和不抢起步缺一不可');
        assert(event.runners.every(function (runner) { return runner.routeClear && runner.observed; }), '所有车辆都应真实可见并清空');
        assert(event.observation === 10, '完整防御应获得本路口 10 分');
      });
      assert(sim.elapsed < Scene.Constants.MAX_TIME, '正确让行不应因必要等待超时');
    });

    test('11 100 个持续高速种子在真实接触前定格', function () {
      for (let index = 0; index < 100; index += 1) {
        const sim = run('rlr-rush-' + index, function () { return { throttle: true }; });
        assert(sim.status === 'frozen' && sim.freezeInfo.prediction, '种子 ' + index + ' 应预测到真实冲突');
        const event = sim.events[sim.freezeInfo.eventId];
        const clearance = Math.min.apply(null, event.runners.map(function (runner) {
          return Scene.Geometry.vehicleClearance(sim.player, runner);
        }));
        assert(clearance > 0, '种子 ' + index + ' 定格必须发生在真实接触前');
        assert(event.failed && event.attempts === 1, '失败与尝试次数应记录在当前路口');
      }
    });

    test('11 输入感知预测允许充分制动，不误罚已停住车辆', function () {
      const sim = new Scene.Simulation('full-brake');
      sim.start();
      assert(!Scene.predictConflict(sim, { brake: true }), '路口前充分制动应能避免冲突');
      for (let frame = 0; frame < 180; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.status === 'driving', '充分制动后不应被原轨迹误罚');
      assert(sim.speed < 0.1 && sim.player.y >= Scene.Constants.YIELD_MIN_Y, '车辆应在停止线后真实停稳');
      assert(Math.min.apply(null, sim.currentEvent.runners.map(function (runner) {
        return Scene.Geometry.vehicleClearance(sim.player, runner);
      })) > 0, '制动后不得发生接触');
    });

    test('11 100 个第一辆后立即起步种子与第二辆形成真实冲突', function () {
      for (let index = 0; index < 100; index += 1) {
        const sim = run('rlr-follow-' + index, earlyStartController);
        const event = sim.events[2];
        assert(sim.status === 'frozen' && sim.freezeInfo.eventId === 2, '种子 ' + index + ' 应在第三路口定格');
        assert(sim.freezeInfo.reason === 'follow' && event.earlyStart, '应识别第一辆后抢起步');
        assert(sim.freezeInfo.prediction && sim.freezeInfo.prediction.runnerId === 1, '风险必须来自第二辆真实车辆');
        assert(Scene.Geometry.vehicleClearance(sim.player, event.runners[1]) > 0, '不得等第二辆接触后才定格');
      }
    });

    test('11 必要观察与让行效率中性，清空后空等恢复计时', function () {
      const sim = new Scene.Simulation('yield-efficiency');
      sim.start();
      sim.player.y = 460;
      sim.player.speed = 0;
      sim.speed = 0;
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 0, '必要等待不得计入效率分母');
      const event = sim.currentEvent;
      event.scanDwells.left = event.scanDwells.right = Scene.Constants.SCAN_DWELL;
      event.initialObserved = true;
      event.runners.forEach(function (runner) { runner.routeClear = true; });
      event.clearConfirmed = true;
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 1, '清空后无故停车必须恢复效率计时');
    });

    test('11 危险近距通过和路口抢行加速不能获得安全或平稳满分', function () {
      const event = new Scene.Simulation('close-pass').events[0];
      event.resolved = true;
      event.unsafePass = true;
      assert(!Scene.Scoring.eventSafe(event), '危险贴边通过不得计入安全完成');
      const sim = new Scene.Simulation('rush-penalty');
      sim.start();
      sim.player.y = 474;
      sim.player.speed = 25;
      sim.speed = 25;
      sim.step({ throttle: true }, STEP);
      assert(sim.currentEvent.rushAcceleration && sim.scoring.rushPenalties === 1, '路口抢行加速应独立扣分');
    });

    test('11 当前路口重试保留首次失败、种子和前文成绩', function () {
      const sim = new Scene.Simulation('retry-runner');
      sim.start();
      let guard = 0;
      while (sim.status === 'driving' && guard++ < 5000) {
        sim.step(sim.eventIndex < 1 ? Scene.defensiveInput(sim) : { throttle: true }, STEP);
      }
      assert(sim.status === 'frozen' && sim.eventIndex === 1, '应在第二路口制造一次真实失败');
      const firstObservation = sim.events[0].observation;
      const seed = sim.seed;
      sim.retryEvent();
      assert(sim.status === 'driving' && sim.eventIndex === 1 && sim.seed === seed, '只重试当前路口并保留种子');
      assert(sim.events[1].failed && sim.events[1].attempts === 1, '重试不得清除首次失败');
      assert(sim.events[0].observation === firstObservation && sim.events[0].resolved, '前文成绩不得重置');
      run(null, Scene.defensiveInput, 60, sim);
      const result = Scene.Scoring.summarize(sim, false);
      assert(result.failed && result.total <= 59, '失败记录保留后总分必须封顶 59');
    });

    test('11 正确示范使用真实 Simulation 完成当前路口且不改正式成绩', function () {
      const sim = run('demo-runner', function () { return { throttle: true }; });
      const failedEvent = sim.freezeInfo.eventId;
      sim.startDemo();
      let steps = 0;
      let sawObservation = false;
      while (sim.status === 'demonstrating' && steps < 3000) {
        sim.stepDemo(STEP);
        sawObservation = sawObservation || Boolean(sim.demo && sim.demo.currentEvent && sim.demo.currentEvent.initialObserved);
        steps += 1;
      }
      assert(sim.status === 'driving' && steps > 300, '示范应真实行驶后返回重试');
      assert(sawObservation, '示范必须真实切换视野并观察来车');
      assert(sim.events[failedEvent].failed && sim.events[failedEvent].attempts === 1, '示范不得修改正式失败记录');
    });

    test('11 30/60/120Hz 固定步长结果一致', function () {
      const snapshots = [30, 60, 120].map(function (hz) {
        return snapshot(run('fixed-step-runner', Scene.defensiveInput, hz));
      });
      assert(snapshots[0] === snapshots[1] && snapshots[1] === snapshots[2], '不同显示帧率不得改变模拟结果');
    });

    test('11 持续制动不动与全程蠕行都会超时且总分封顶 69', function () {
      const idle = run('idle-runner', function () { return { brake: true }; });
      assert(idle.status === 'timeout', '持续停车不动应超时');
      assert(Scene.Scoring.summarize(idle, true).total <= 69, '不动超时应封顶 69');
      const creep = run('creep-runner', function (sim) {
        return { throttle: sim.speed < 4.8, brake: sim.speed > 5.2 };
      });
      assert(creep.status === 'timeout', '全程低速蠕行应超时');
      assert(Scene.Scoring.summarize(creep, true).total <= 69, '蠕行超时应封顶 69');
    });

    test('11 三种视野、放大窗口、失败定格和示范画面均可渲染', function () {
      ['left', 'front', 'right'].forEach(function (view) {
        const sim = new Scene.Simulation('render-runner');
        sim.setView(view);
        Scene.Renderer.render(mockContext(), sim);
        sim.start();
        for (let frame = 0; frame < 60; frame += 1) sim.step({ brake: true }, STEP);
        Scene.Renderer.render(mockContext(), sim);
      });
      const frozen = run('render-frozen', function () { return { throttle: true }; });
      Scene.Renderer.render(mockContext(), frozen);
      frozen.startDemo();
      frozen.stepDemo(STEP);
      Scene.Renderer.render(mockContext(), frozen);
    });

    test('11 中英文、目录入口和页面视野踏板完整', function () {
      const entry = Game.CATALOG.find(function (game) { return game.id === 'red-light-runner'; });
      assert(entry && entry.status === 'playable' && entry.href === 'red-light-runner.html', 'EP.11 必须提供真实入口');
      ['zh-CN', 'en'].forEach(function (language) {
        Game.I18N.setLanguage(language);
        ['scene.redLight.documentTitle', 'scene.redLight.hud.follow', 'scene.redLight.failure.follow',
          'scene.redLight.demo.waitSub', 'scene.redLight.view.right', 'scene.redLight.result.advice.failed'].forEach(function (key) {
            assert(Game.I18N.t(key) !== key, language + ' 缺少 ' + key);
          });
      });
      Game.I18N.setLanguage('zh-CN');
      assert(Scene.ui && typeof Scene.bindControls === 'function', '场景应接入三个触控视野按钮');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.RedLightRunnerTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
