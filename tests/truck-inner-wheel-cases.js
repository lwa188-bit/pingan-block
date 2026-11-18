(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['truck-inner-wheel'];
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

  function innerWheelFixture(input, frames) {
    const sim = new Scene.Simulation('inner-wheel-fixture', { eventId: 2 });
    sim.start();
    Object.assign(sim.truck, { x: 154, y: 400, heading: -Math.PI / 2, speed: 10, steer: 0 });
    sim.speed = 10;
    sim.currentEvent.turning = true;
    Object.assign(sim.currentEvent.actor, { x: 198, y: 330, speed: 0, baseSpeed: 0, cleared: false });
    if (frames) {
      for (let frame = 0; frame < frames && sim.status === 'driving'; frame += 1) {
        sim.step(input || { right: true }, STEP);
      }
      return sim;
    }
    return run(null, function () { return input || { right: true }; }, 60, sim);
  }

  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      elapsed: sim.elapsed,
      truck: sim.truck,
      scoring: sim.scoring,
      events: sim.events.map(function (event) {
        return {
          actor: event.actor,
          resolved: event.resolved,
          failed: event.failed,
          attempts: event.attempts,
          initialObserved: event.initialObserved,
          rechecked: event.rechecked,
          clearConfirmed: event.clearConfirmed,
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
        results.push({ name: '[05] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[05] ' + name, passed: false, error: error.message });
      }
    }

    test('05 三类路口都有真实参与者，种子与输入不改变计划', function () {
      ['same', 0, 41, 'truck-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子应完整复现');
        assert(a.events.map(function (event) { return event.kind; }).join(',') === 'pedestrian,ebike,cyclist',
          '应依次包含行人、电动车和车身中段骑行者');
        a.events.forEach(function (event) {
          assert(event.actor.baseSpeed > 0 && !event.actor.cleared, '每处都必须有真实移动参与者');
        });
        const before = JSON.stringify(a.plan);
        a.start();
        for (let frame = 0; frame < 120; frame += 1) a.step({ throttle: true, right: true }, STEP);
        assert(JSON.stringify(a.plan) === before, '玩家输入不得改写交通计划');
      });
    });

    test('05 内轮差由轴距和转向角计算，长车身不是普通汽车贴图', function () {
      const small = Scene.Geometry.innerWheelOffset(10 * Math.PI / 180);
      const large = Scene.Geometry.innerWheelOffset(30 * Math.PI / 180);
      assert(small > 0 && large > small, '转向越大内轮差应越大');
      assert(Scene.Constants.WHEELBASE === 42 && Scene.Constants.WHEELBASE_METERS === 6.2, '必须有独立前后轴');
      const truck = { x: 154, y: 400, heading: -Math.PI / 2, steer: 0, speed: 10 };
      const rear = Scene.Geometry.localPoint(truck, 0, 0);
      const front = Scene.Geometry.localPoint(truck, Scene.Constants.WHEELBASE, 0);
      assert(Math.abs(Math.hypot(front.x - rear.x, front.y - rear.y) - 42) < 0.001, '前后轴距必须进入几何');
      assert(Scene.Geometry.bodyPolygon(truck).length === 4, '车身碰撞必须使用完整矩形');
    });

    test('05 轮迹和扫掠带共用车辆几何并随转向变化', function () {
      const truck = { x: 154, y: 400, heading: -Math.PI / 2, steer: 0.15, speed: 10 };
      const a = Scene.Geometry.projectSweep(truck, 1);
      truck.steer = 0.45;
      const b = Scene.Geometry.projectSweep(truck, 1);
      assert(a.outer.length > 10 && a.outer.length === a.inner.length, '扫掠带应包含连续前后轴采样');
      assert(Math.abs(a.outer[a.outer.length - 1].x - b.outer[b.outer.length - 1].x) > 5,
        '不同转向角必须产生不同轮迹');
    });

    test('05 切换按钮本身不得分，目标真实可见才累计观察', function () {
      const sim = new Scene.Simulation('visible-target', { eventId: 1 });
      sim.start();
      assert(!Scene.visibilityFor(sim, sim.currentEvent, 'front'), '右后方目标不应出现在前视');
      assert(Scene.visibilityFor(sim, sim.currentEvent, 'mirror'), '右后方目标应进入右后视镜');
      sim.setView('mirror');
      assert(!sim.currentEvent.initialObserved, '只按视角按钮不能得分');
      for (let frame = 0; frame < 20; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.currentEvent.initialObserved, '目标连续可见后才能记为有效观察');
      assert(sim.currentEvent.observedViews.mirror >= Scene.Constants.SCAN_DWELL, '应记录真实可见时长');
    });

    test('05 视野切换不暂停世界，建筑遮挡不能透视', function () {
      const sim = new Scene.Simulation('occlusion');
      sim.start();
      const before = sim.currentEvent.actor.x;
      sim.setView('window');
      for (let frame = 0; frame < 30; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.currentEvent.actor.x !== before, '切换视野时参与者仍须持续移动');
      Object.assign(sim.truck, { x: 154, y: 400, heading: -Math.PI / 2 });
      Object.assign(sim.currentEvent.actor, { x: 300, y: 180, cleared: false });
      assert(!Scene.visibilityFor(sim, sim.currentEvent, 'front'), '道路设施后的目标不可见');
      Object.assign(sim.currentEvent.actor, { x: 150, y: 250 });
      assert(Scene.visibilityFor(sim, sim.currentEvent, 'front'), '无遮挡正前方目标应可见');
    });

    test('05 200 个防御种子全部安全完成、观察满分且总分至少 85', function () {
      for (let index = 0; index < 200; index += 1) {
        const sim = run('truck-defense-' + index, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '种子 ' + index + ' 应完成：' + sim.status);
        assert(result.observation === 30, '种子 ' + index + ' 应观察满分');
        assert(result.safety === 40 && result.total >= 85, '种子 ' + index + ' 得分异常：' + result.total);
      }
    });

    test('05 防御过程包含停稳让行、完全清空和连续回正', function () {
      const sim = run('real-yield', Scene.defensiveInput);
      sim.events.forEach(function (event) {
        assert(event.actor.cleared, '参与者必须沿自己的路线完全通过');
        assert(event.stoppedForActor && event.waitedUntilClear, '每个路口都应经历真实停稳等待');
        assert(event.initialObserved && event.rechecked && event.clearConfirmed, '观察与再次确认缺一不可');
        assert(event.observation === 10, '完整防御应获得本路口 10 分');
      });
      assert(Math.abs(sim.truck.heading) < 0.25 && sim.truck.x > 320, '最后应回正并驶离路口');
    });

    test('05 100 个高速抢转种子在真实接触前定格', function () {
      for (let index = 0; index < 100; index += 1) {
        const sim = run('truck-rush-' + index, function (current) {
          return { throttle: true, right: Boolean(current.currentEvent && current.currentEvent.turning) };
        });
        assert(sim.status === 'frozen' && sim.freezeInfo.prediction, '种子 ' + index + ' 应预测到真实冲突');
        const event = sim.events[sim.freezeInfo.eventId];
        assert(Scene.Geometry.actorClearance(sim.truck, event.actor) > 0, '定格必须发生在真实接触前');
        assert(event.failed && event.attempts === 1, '失败与尝试次数应记录在当前路口');
      }
    });

    test('05 内轮差专项区分车头通过与整车安全', function () {
      const sim = innerWheelFixture();
      assert(sim.status === 'frozen' && sim.freezeInfo.reason === 'innerWheel', '应给出内轮差专属失败原因');
      assert(Scene.Geometry.actorClearance(sim.truck, sim.currentEvent.actor) > 0, '不得等接触后才定格');
      assert(sim.truck.heading > -Math.PI / 2, '测试必须真的进入转向过程');
    });

    test('05 输入感知预测允许充分制动，不误罚已停住车辆', function () {
      const sim = innerWheelFixture({ brake: true, right: true }, 120);
      assert(sim.status === 'driving', '充分制动后不应被原轨迹误罚');
      assert(sim.speed < 0.1, '车辆应真实停稳');
      assert(Scene.Geometry.actorClearance(sim.truck, sim.currentEvent.actor) > 0, '制动后不得发生接触');
    });

    test('05 长按 D 不会自动完成，必须主动回正', function () {
      const sim = new Scene.Simulation('held-steering');
      sim.start();
      const event = sim.currentEvent;
      event.turning = true;
      event.actor.cleared = true;
      event.initialObserved = true;
      event.rechecked = true;
      event.clearConfirmed = true;
      Object.assign(sim.truck, { y: 400, speed: 12 });
      sim.speed = 12;
      run(null, function () { return { throttle: true, right: true }; }, 60, sim);
      assert(sim.status === 'frozen' && sim.freezeInfo.reason !== 'missedTurn', '持续转向应因未回正或冲突失败');
      assert(!event.resolved, '长按 D 不能自动完成教学路口');
    });

    test('05 必要观察与让行效率中性，清空后空等恢复计时', function () {
      const sim = new Scene.Simulation('yield-efficiency');
      sim.start();
      sim.truck.y = 400;
      sim.speed = 0;
      sim.truck.speed = 0;
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 0, '必要等待不得计入效率分母');
      const event = sim.currentEvent;
      event.actor.cleared = true;
      event.initialObserved = true;
      event.rechecked = true;
      event.clearConfirmed = true;
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 1, '清空后无故停车必须恢复效率计时');
    });

    test('05 高速猛打方向和抢转加速会留下独立记录', function () {
      const sim = new Scene.Simulation('smooth-steering');
      sim.start();
      const event = sim.currentEvent;
      event.turning = true;
      event.actor.cleared = true;
      Object.assign(sim.truck, { y: 400, speed: 20, steer: 23.9 * Math.PI / 180, heading: -1 });
      sim.speed = 20;
      sim.step({ throttle: true, right: true }, STEP);
      assert(event.rushedSteering && sim.scoring.steeringPenalties === 1, '高速猛打方向应扣平稳分');
      assert(event.rushAcceleration, '路口抢转加速应单独记录');
    });

    test('05 无接触但极小车身余量通过不能算安全', function () {
      const event = new Scene.Simulation('close-pass').events[0];
      event.resolved = true;
      event.unsafePass = true;
      assert(!Scene.Scoring.eventSafe(event), '危险贴边通过不得计入安全完成');
    });

    test('05 当前路口重试保留首次失败、种子和前文成绩', function () {
      const sim = innerWheelFixture();
      const eventId = sim.freezeInfo.eventId;
      sim.retryEvent();
      assert(sim.status === 'driving' && sim.eventIndex === eventId, '只重试当前路口');
      assert(sim.events[eventId].failed && sim.events[eventId].attempts === 1, '重试不得清除首次失败');
      assert(sim.truck.y === Scene.Constants.START_Y && !sim.currentEvent.actor.cleared, '车辆与参与者应回到路口前');
      const result = Scene.Scoring.summarize(sim, false);
      assert(result.failed, '总分仍应受首次失败限制');
    });

    test('05 正确示范使用真实 Simulation 完成当前路口', function () {
      const sim = innerWheelFixture();
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
      assert(sawObservation, '示范必须真实切换并观察目标');
      assert(sim.events[failedEvent].failed && sim.events[failedEvent].attempts === 1, '示范不得修改正式失败记录');
    });

    test('05 30/60/120Hz 固定步长结果一致', function () {
      const snapshots = [30, 60, 120].map(function (hz) {
        return snapshot(run('fixed-step-truck', Scene.defensiveInput, hz));
      });
      assert(snapshots[0] === snapshots[1] && snapshots[1] === snapshots[2], '不同显示帧率不得改变模拟结果');
    });

    test('05 不动会超时且总分封顶 69', function () {
      const sim = run('idle-truck', function () { return {}; });
      assert(sim.status === 'timeout', '一直不动应超时');
      assert(Scene.Scoring.summarize(sim, true).total <= 69, '超时总分必须封顶');
    });

    test('05 三种视野、扫掠带和结算画面均可渲染', function () {
      ['front', 'window', 'mirror'].forEach(function (view) {
        const sim = new Scene.Simulation('render-truck');
        sim.setView(view);
        Scene.Renderer.render(mockContext(), sim);
        sim.currentEvent.turning = true;
        sim.truck.steer = 0.4;
        Scene.Renderer.render(mockContext(), sim);
      });
    });

    test('05 中英文、目录入口和页面触控视图按钮完整', function () {
      const entry = Game.CATALOG.find(function (game) { return game.id === 'truck-inner-wheel'; });
      assert(entry && entry.status === 'playable' && entry.href === 'truck-inner-wheel.html', 'EP.05 必须提供真实入口');
      ['zh-CN', 'en'].forEach(function (language) {
        Game.I18N.setLanguage(language);
        ['scene.truck.documentTitle', 'scene.truck.hud.lookRight', 'scene.truck.failure.innerWheel',
          'scene.truck.demo.turnSub', 'scene.truck.view.mirror'].forEach(function (key) {
            assert(Game.I18N.t(key) !== key, language + ' 缺少 ' + key);
          });
      });
      Game.I18N.setLanguage('zh-CN');
      assert(Scene.ui && typeof Scene.bindControls === 'function', '场景应接入三个触控视角按钮');
    });
    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.TruckInnerWheelTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
