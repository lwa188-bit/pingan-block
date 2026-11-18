(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['obscured-signal-intersection'];
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

  function eventId(seed, template) {
    return Scene.createPlan(seed).events.findIndex(function (event) { return event.template === template; });
  }

  function runEvent(seed, id) {
    const sim = new Scene.Simulation(seed, { eventId: id });
    sim.start();
    for (let frame = 0; frame < 3600 && sim.status === 'driving'; frame += 1) {
      sim.step(Scene.defensiveInput(sim), STEP);
    }
    return sim;
  }

  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      distance: sim.distance,
      speed: sim.speed,
      previousSpeed: sim.previousSpeed,
      lateral: sim.lateral,
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
        results.push({ name: '[17] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[17] ' + name, passed: false, error: error.message });
      }
    }

    test('17 三类事件完整复现，计划冻结且不受语言和踏板影响', function () {
      ['same', 0, 45, 'obscured-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子应完整复现');
        assert(a.events.map(function (event) { return event.template; }).sort().join(',') ===
          'crosswalk-reveal,green-reveal,red-reveal', '每局必须包含三类事件');
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 120; frame += 1) a.step({ throttle: true }, STEP);
        assert(JSON.stringify(a.plan) === before, '踏板和语言不得改变计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('17 真实三维视线区分车顶、车侧和车距，不退化为二维矩形', function () {
      const box = { minX: -1.25, maxX: 1.25, minS: 10, maxS: 20, height: 3.4 };
      assert(Scene.Geometry.segmentIntersectsBox3D(
        { x: 0, s: 0, z: 1.15 }, { x: 0.2, s: 42, z: 5.1 }, box), '穿过车身的视线应被遮挡');
      assert(!Scene.Geometry.segmentIntersectsBox3D(
        { x: 0, s: 0, z: 4.2 }, { x: 0.2, s: 42, z: 5.1 }, box), '从车顶上方通过应可见');
      assert(!Scene.Geometry.segmentIntersectsBox3D(
        { x: 3, s: 0, z: 1.15 }, { x: 0, s: 42, z: 1.5 }, box), '从车侧绕过应可见');
      const sim = new Scene.Simulation(8, { eventId: 0 });
      const event = sim.currentEvent;
      sim.distance = event.stopS - 40;
      event.leader.x = 0;
      event.leader.height = 3.5;
      event.leader.s = sim.distance + 12;
      const near = Scene.Geometry.signalVisibility(sim, event);
      event.leader.s = sim.distance + 32;
      const far = Scene.Geometry.signalVisibility(sim, event);
      assert(!near.visible && far.visible, '同一目标应随纵向车距恢复视野');
    });

    test('17 信号、行人和冲突区需要连续可见，单帧不能刷确认', function () {
      const sim = new Scene.Simulation('visibility-dwell', { eventId: eventId('visibility-dwell', 'crosswalk-reveal') });
      const event = sim.currentEvent;
      sim.distance = event.stopS - 40;
      event.leader.height = 0.05;
      event.localTime = Math.max(0, event.pedestrian.enterAt - 1);
      sim.updateObservation(event, 0.1);
      sim.updateObservation(event, 0.1);
      assert(!event.signalConfirmed && !event.pedestrianConfirmed && !event.conflictConfirmed, '短暂露出不得完成确认');
      sim.updateObservation(event, 0.46);
      assert(event.signalConfirmed && event.conflictConfirmed, '信号和冲突区应分别达到连续停留门槛');
      event.localTime = event.pedestrian.enterAt + 2;
      sim.updateObservation(event, 0.1);
      sim.updateObservation(event, 0.1);
      assert(!event.pedestrianConfirmed && !event.conflictConfirmed, '行人短暂露出不得确认，占用时也不得更早确认清空');
      sim.updateObservation(event, 0.06);
      assert(event.pedestrianConfirmed, '行人应达到自己的连续确认门槛');
      event.localTime = event.pedestrian.enterAt + 9;
      sim.updateObservation(event, 0.46);
      assert(event.conflictConfirmed, '行人完全离开并连续可见后应重新确认清空');
    });

    test('17 200 个防御种子安全完成，观察满分且无重刹', function () {
      for (let seed = 1; seed <= 200; seed += 1) {
        const sim = run(seed, Scene.defensiveInput);
        const score = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '防御策略应完成，种子 ' + seed + '：' + sim.status);
        assert(score.total >= 85 && score.observation === 30, '防御策略应获得高评价，种子 ' + seed + '：' + score.total);
        assert(score.hardBrakes === 0, '正确防御不应依赖重刹，种子 ' + seed);
      }
    });

    test('17 100 个持续全油门种子均在真实接触前被拦截', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const sim = run(seed, function () { return { throttle: true }; });
        assert(sim.status !== 'complete' || Scene.Scoring.summarize(sim, false).total < 85, '全油门不得普遍高分');
        if (sim.status === 'frozen') {
          assert(sim.freezeInfo && ['leader', 'pedestrian', 'redEntry', 'cross'].includes(sim.freezeInfo.reason), '应有明确失败教学');
          assert(Scene.leaderGap(sim, sim.events[sim.freezeInfo.eventId]) >= 0, '不得在车辆重叠后才定格');
        }
      }
    });

    test('17 绿灯及时通过、红灯独立停车、行人完整清空后再走', function () {
      for (let seed = 1; seed <= 30; seed += 1) {
        ['green-reveal', 'red-reveal', 'crosswalk-reveal'].forEach(function (template) {
          const id = eventId(seed, template);
          const sim = runEvent(seed, id);
          const event = sim.events[id];
          assert(event.resolved && event.observation === 10, template + ' 应获得完整观察与行动评价，种子 ' + seed);
          if (template === 'green-reveal') assert(!event.redObserved && !event.waitedForGreen, '绿灯事件不应要求红灯等待');
          if (template === 'red-reveal') assert(event.properStop && event.redObserved && event.waitedForGreen, '红灯必须独立确认并等待放行');
          if (template === 'crosswalk-reveal') {
            assert(event.properStop && event.pedestrianConfirmed && event.waitedForFullClear && event.pedestrian.cleared,
              '行人事件必须真实看见并等待完整清空');
          }
        });
      }
    });

    test('17 大车真实停稳再起步，行人从路缘连续直行不瞬移', function () {
      for (let seed = 1; seed <= 20; seed += 1) {
        const id = eventId(seed, 'crosswalk-reveal');
        const sim = new Scene.Simulation(seed, { eventId: id });
        sim.start();
        const event = sim.currentEvent;
        let previousX = Scene.pedestrianPosition(event).x;
        let sawStopped = false;
        let sawClear = false;
        for (let frame = 0; frame < 3600 && sim.status === 'driving'; frame += 1) {
          sim.step(Scene.defensiveInput(sim), STEP);
          const position = Scene.pedestrianPosition(event);
          assert(Math.abs(position.x - previousX) <= event.pedestrian.speed * STEP + 1e-7, '行人不得瞬移或折返');
          previousX = position.x;
          if (event.leader.yieldStopped && !position.cleared) assert(event.leader.speed === 0, '行人未清空时，让行停稳的大车速度必须为零');
          sawStopped = sawStopped || event.leader.yieldStopped;
          sawClear = sawClear || position.cleared;
        }
        assert(sawStopped && sawClear && event.resolved, '应覆盖完整的大车让行和行人清空过程');
      }
    });

    test('17 行人清空前抢起步会留下记录，不能获得完整行动分', function () {
      const seed = 4;
      const id = eventId(seed, 'crosswalk-reveal');
      const sim = new Scene.Simulation(seed, { eventId: id });
      sim.start();
      while (sim.status === 'driving' && !sim.currentEvent.properStop) sim.step(Scene.defensiveInput(sim), STEP);
      assert(sim.currentEvent.properStop && !sim.currentEvent.waitedForFullClear, '应处于行人清空前的停稳状态');
      while (sim.status === 'driving') sim.step({ throttle: true }, STEP);
      const event = sim.events[id];
      assert(event.earlyStart || event.enteredOccupied || event.failed, '抢起步必须被记录');
      assert(!event.correctAction, '抢起步不得获得完整行动评价');
    });

    test('17 充分制动不误判，近距离无法避免时才预测冲突', function () {
      const sim = new Scene.Simulation(45, { eventId: 0 });
      const event = sim.currentEvent;
      assert(!Scene.predictLeaderConflict(sim, event, { brake: true }), '初始合理车距下充分制动应可避免');
      event.leader.s = sim.distance + Scene.Constants.CAR_LENGTH_M / 2 + event.leader.length / 2 + 0.8;
      event.leader.speed = 0;
      event.leader.yieldStopped = true;
      sim.speed = 60;
      assert(Scene.predictLeaderConflict(sim, event, { brake: true }), '极小车距且高速接近停止大车时风险不可避免');
      const controlled = run(45, Scene.defensiveInput);
      assert(controlled.status === 'complete' && controlled.scoring.hardBrakes === 0, '常规红灯停车不得因固定距离触发紧急制动');
    });

    test('17 红灯必要等待效率中性，放行后无故停车恢复计时', function () {
      const seed = 3;
      const id = eventId(seed, 'red-reveal');
      const sim = new Scene.Simulation(seed, { eventId: id });
      sim.start();
      while (sim.status === 'driving' && !sim.currentEvent.properStop) sim.step(Scene.defensiveInput(sim), STEP);
      const exemptTime = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 60 && !sim.currentEvent.waitedForGreen; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.scoring.efficiencyTime === exemptTime, '红灯和必要停稳等待不得计入效率损失');
      while (!sim.currentEvent.waitedForGreen && sim.status === 'driving') sim.step({ brake: true }, STEP);
      const resumedTime = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 60; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.scoring.efficiencyTime > resumedTime, '放行后继续刹停必须恢复效率计时');
    });

    test('17 行人清空前等待效率中性，清空后空等恢复计时', function () {
      const seed = 5;
      const id = eventId(seed, 'crosswalk-reveal');
      const sim = new Scene.Simulation(seed, { eventId: id });
      sim.start();
      while (sim.status === 'driving' && !sim.currentEvent.properStop) sim.step(Scene.defensiveInput(sim), STEP);
      const waitingTime = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 60 && !sim.currentEvent.waitedForFullClear; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.scoring.efficiencyTime === waitingTime, '完整清空前等待不得损失效率');
      while (!sim.currentEvent.waitedForFullClear && sim.status === 'driving') sim.step({ brake: true }, STEP);
      const resumedTime = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 180; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.scoring.efficiencyTime > resumedTime, '清空及大车必要起步延迟后继续刹停必须恢复效率计时');
    });

    test('17 不动和全程蠕行都会超时并封顶 69', function () {
      for (let seed = 1; seed <= 30; seed += 1) {
        const idleSimulation = new Scene.Simulation(seed);
        idleSimulation.speed = 0;
        const idle = run(seed, function () { return {}; }, 60, idleSimulation);
        const creep = run(seed, function (sim) { return { throttle: sim.speed < 8, brake: sim.speed > 10 }; });
        assert(idle.status === 'timeout' && Scene.Scoring.summarize(idle, true).total <= 69, '不动应超时封顶，种子 ' + seed);
        assert(creep.status === 'timeout' && Scene.Scoring.summarize(creep, true).total <= 69, '蠕行应超时封顶，种子 ' + seed);
      }
    });

    test('17 首次失败、当前事件重试和 59 分封顶不可绕过', function () {
      const sim = run('retry-cap', function () { return { throttle: true }; });
      assert(sim.status === 'frozen', '应先制造一次真实失败');
      const id = sim.freezeInfo.eventId;
      sim.retryEvent();
      assert(sim.events[id].failed && sim.events[id].attempts === 1, '重试必须保留第一次失败');
      let retries = 0;
      while (sim.status !== 'complete' && sim.status !== 'timeout' && retries < 5) {
        if (sim.status === 'frozen') {
          sim.retryEvent();
          retries += 1;
        } else sim.step(Scene.defensiveInput(sim), STEP);
      }
      assert(sim.status === 'complete', '重试后应能完成整局');
      assert(Scene.Scoring.summarize(sim, false).total <= 59, '失败后总分必须封顶 59');
    });

    test('17 正常单次选位不扣分，快速反复反向微调独立扣分', function () {
      const single = new Scene.Simulation('single-offset');
      single.start();
      for (let frame = 0; frame < 30; frame += 1) single.step({ right: true }, STEP);
      assert(single.scoring.steerPenalties === 0, '正常持续选位不应扣分');
      const repeated = new Scene.Simulation('repeated-offset');
      repeated.start();
      for (let frame = 0; frame < 240; frame += 1) {
        repeated.step(Math.floor(frame / 12) % 2 ? { left: true } : { right: true }, STEP);
      }
      assert(repeated.scoring.steerPenalties > 0 && repeated.currentEvent.lateralReversals > 0, '快速反向微调必须留下独立记录');
    });

    test('17 三类示范来自独立真实 Simulation，并逐帧一致且不改成绩', function () {
      ['green-reveal', 'red-reveal', 'crosswalk-reveal'].forEach(function (template) {
        const seed = 'demo-' + template;
        const id = eventId(seed, template);
        const official = new Scene.Simulation(seed, { eventId: id });
        official.start();
        official.step(Scene.defensiveInput(official), STEP);
        official.freeze(official.currentEvent, 'redEntry');
        const officialScoring = JSON.stringify(official.scoring);
        official.startDemo();
        assert(official.status === 'demonstrating' && official.demo instanceof Scene.Simulation, '示范必须是独立真实模拟');
        assert(official.demo !== official && JSON.stringify(official.scoring) === officialScoring, '示范不得修改正式成绩');
        const reference = new Scene.Simulation(seed, { eventId: id });
        reference.start();
        let frames = 0;
        while (official.status === 'demonstrating' && frames < 3000) {
          assert(snapshot(official.demo) === snapshot(reference), template + ' 示范与参考第 ' + frames + ' 帧不一致');
          official.stepDemo(STEP);
          if (official.status === 'demonstrating') reference.step(Scene.defensiveInput(reference), STEP);
          frames += 1;
        }
        assert(frames > 30 && frames < 3000 && official.events[id].failed, '示范结束后应恢复当前事件重试并保留失败');
      });
    });

    test('17 双视角复盘由参数绘制，渲染器不回写模拟状态', function () {
      const sim = new Scene.Simulation(9, { eventId: 0 });
      sim.start();
      sim.freeze(sim.currentEvent, 'leader');
      sim.startDemo();
      assert(sim.demoOverview === false, '示范默认使用驾驶视野');
      const button = {
        hidden: true,
        textContent: '',
        ariaPressed: '',
        listeners: {},
        setAttribute: function (name, value) { this.ariaPressed = value; },
        addEventListener: function (name, listener) { this.listeners[name] = listener; }
      };
      const doc = { getElementById: function (id) { return id === 'replay-view-button' ? button : null; } };
      Scene.bindControls(doc, function () { return sim; });
      button.listeners.click();
      Scene.ui.updateControls(doc, sim);
      assert(sim.demoOverview && !button.hidden && button.ariaPressed === 'true', '按钮应切换教学全景并同步无障碍状态');
      Scene.Renderer.render(mockContext(), sim);
      assert(sim.demoOverview === true, '绘制教学全景不得修改视角状态');
      button.listeners.click();
      Scene.Renderer.render(mockContext(), sim);
      assert(sim.demoOverview === false, '绘制驾驶视野不得修改视角状态');
    });

    test('17 被遮挡时 HUD 不泄露信号颜色或隐藏行人答案', function () {
      const sim = new Scene.Simulation(11, { eventId: eventId(11, 'red-reveal') });
      const event = sim.currentEvent;
      sim.distance = event.stopS - 40;
      event.leader.s = sim.distance + 12;
      event.leader.height = 8;
      event.visibility = null;
      assert(!Scene.Geometry.signalVisibility(sim, event).visible, '测试局面应真实遮挡信号');
      const coach = Scene.ui.coach(sim);
      assert(coach.text === Game.I18N.t('scene.obscured.hud.occluded'), '遮挡时应提示恢复视野而非隐藏颜色');
      assert(coach.text.indexOf(Game.I18N.t('scene.obscured.hud.red')) < 0, '不得提前显示红灯答案');
    });

    test('17 30 / 60 / 120 Hz 的正式驾驶结果一致', function () {
      const reference = run('fixed-step-obscured', Scene.defensiveInput, 60);
      [30, 120].forEach(function (hz) {
        const current = run('fixed-step-obscured', Scene.defensiveInput, hz);
        assert(snapshot(current) === snapshot(reference), hz + ' Hz 应与 60 Hz 一致');
      });
    });

    test('17 三类路口、定格和两种示范视野均可绘制', function () {
      const ctx = mockContext();
      ['green-reveal', 'red-reveal', 'crosswalk-reveal'].forEach(function (template) {
        const seed = 'render-' + template;
        const sim = new Scene.Simulation(seed, { eventId: eventId(seed, template) });
        Scene.Renderer.render(ctx, sim);
        sim.start();
        for (let frame = 0; frame < 120; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
        Scene.Renderer.render(ctx, sim);
        sim.freeze(sim.currentEvent, 'leader');
        Scene.Renderer.render(ctx, sim);
        sim.startDemo();
        Scene.Renderer.render(ctx, sim);
        sim.demoOverview = true;
        Scene.Renderer.render(ctx, sim);
      });
    });

    test('17 中英文文案完整，切换语言不改模拟与评分', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      const keys = Object.keys(zh).filter(function (key) { return key.indexOf('scene.obscured.') === 0; });
      assert(keys.length >= 45, '场景应具备完整独立文案');
      keys.forEach(function (key) {
        assert(typeof en[key] === 'string' && en[key].length > 0, '缺少英文：' + key);
        assert(typeof zh[key] === 'string' && zh[key].length > 0, '缺少中文：' + key);
      });
      Object.keys(en).filter(function (key) { return key.indexOf('scene.obscured.') === 0; }).forEach(function (key) {
        assert(typeof zh[key] === 'string', '英文存在孤立键：' + key);
      });
      const sim = new Scene.Simulation('language-obscured', { eventId: 0 });
      sim.start();
      for (let frame = 0; frame < 180; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      const before = snapshot(sim);
      Game.I18N.setLanguage('en');
      assert(snapshot(sim) === before, '切换语言不得改变模拟');
      assert(Scene.ui.coach(sim).text.indexOf('scene.obscured.') !== 0, '英文教练文案应可解析');
      Game.I18N.setLanguage('zh-CN');
    });

    test('17 目录注册 EP.17，编号与 G-15 设计标识分离', function () {
      const entry = Game.CATALOG.find(function (item) { return item.id === 'obscured-signal-intersection'; });
      assert(entry && entry.episode === '17' && entry.status === 'playable', '目录必须注册可玩 EP.17');
      assert(entry.href === 'obscured-signal-intersection.html' && entry.art === 'obscured-signal-intersection', '入口与卡片插画应完整');
      assert(Game.CATALOG.filter(function (item) { return item.episode === '17'; }).length === 1, 'EP.17 不得重复');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.ObscuredSignalIntersectionTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
