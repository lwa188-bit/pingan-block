(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['unsignalized-cross-traffic'];
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
    while (sim.status === 'driving' && guard < 20000) {
      accumulator += frame;
      while (accumulator >= STEP && sim.status === 'driving') {
        sim.step(controller(sim), STEP);
        accumulator -= STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    assert(guard < 20000, '模拟不应卡死');
    return sim;
  }

  function fullThrottleInput() {
    return { throttle: true, brake: false, left: false, right: false };
  }

  function useEvent(sim, eventId) {
    sim.events.forEach(function (event, index) { event.resolved = index < eventId; });
    const event = sim.events[eventId];
    sim.distance = Math.max(0, event.position - Scene.Constants.APPROACH_START);
    sim.speed = 40;
    sim.previousSpeed = 40;
    sim.status = 'driving';
    return event;
  }

  function eventIdFor(seed, behavior) {
    return new Scene.Simulation(seed).events.findIndex(function (event) { return event.behavior === behavior; });
  }

  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      distance: sim.distance,
      speed: sim.speed,
      previousSpeed: sim.previousSpeed,
      acceleration: sim.acceleration,
      lastDeceleration: sim.lastDeceleration,
      elapsed: sim.elapsed,
      x: sim.x,
      scoring: sim.scoring,
      events: sim.events.map(function (event) {
        return {
          resolved: event.resolved,
          failed: event.failed,
          attempts: event.attempts,
          earlySlow: event.earlySlow,
          stoppedDwell: event.stoppedDwell,
          stoppedScanTime: event.stoppedScanTime,
          stopScan: event.stopScan,
          observedActorTime: event.observedActorTime,
          confirmedYieldTime: event.confirmedYieldTime,
          waitedUntilClear: event.waitedUntilClear,
          enteredBeforeClear: event.enteredBeforeClear,
          closePass: event.closePass,
          correctJudgment: event.correctJudgment,
          actor: event.actor
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
        results.push({ name: '[12] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[12] ' + name, passed: false, error: error.message });
      }
    }

    test('12 三类交叉来车各一次，种子、语言和输入不改变计划', function () {
      ['same-seed', 0, 37, 'junction-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子应完整复现');
        ['right-through', 'left-yields', 'left-late'].forEach(function (behavior) {
          assert(a.events.filter(function (event) { return event.behavior === behavior; }).length === 1,
            '每局应恰好有一个 ' + behavior);
        });
        assert(a.rulePack.id === 'CN' && a.rulePack.yieldToRight, '默认规则包应明确为 CN 让右');
        const before = JSON.stringify(a.plan);
        Game.I18N.setLanguage('en');
        a.start();
        for (let frame = 0; frame < 120; frame += 1) a.step({ throttle: frame % 2 === 0, brake: frame % 2 === 1 }, STEP);
        assert(JSON.stringify(a.plan) === before, '语言和踏板不得改写在先计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('12 真实眼点与遮挡矩形决定可见性，车头探出可被看见', function () {
      const sim = new Scene.Simulation('geometry-visible');
      const event = sim.events.find(function (item) { return item.direction > 0; });
      sim.distance = Scene.Geometry.observationLine(event) - 3;
      sim.speed = 0;
      event.actor.active = true;
      event.actor.x = 40;
      assert(!Scene.Geometry.visibilityFor(sim, event).visible, '建筑后的来车不应透视可见');
      event.actor.x = 145;
      assert(Scene.Geometry.visibilityFor(sim, event).visible, '车身前部离开遮挡后应可见');
      const rect = { left: 0, right: 10, bottom: 0, top: 10 };
      assert(Scene.Geometry.segmentIntersectsAABB({ x: -5, y: 5 }, { x: 15, y: 5 }, rect), '线段应识别穿越矩形');
      assert(!Scene.Geometry.segmentIntersectsAABB({ x: -5, y: 15 }, { x: 15, y: 15 }, rect), '外部线段不应误判遮挡');
    });

    test('12 有效观察要求路口外停稳和连续扫描，蠕行不能刷分', function () {
      const sim = new Scene.Simulation('real-stop');
      const event = useEvent(sim, 0);
      sim.distance = Scene.Geometry.observationLine(event) - 3;
      sim.speed = sim.previousSpeed = 4;
      for (let frame = 0; frame < 30; frame += 1) sim.step({ brake: sim.speed > 4, throttle: sim.speed < 4 }, STEP);
      assert(!event.stopScan && event.stoppedDwell === 0, '4 km/h 蠕行不得记作停车');
      sim.distance = Scene.Geometry.observationLine(event) - 3;
      sim.speed = sim.previousSpeed = 0;
      event.actor.active = false;
      for (let frame = 0; frame < 55; frame += 1) sim.step({ brake: true }, STEP);
      assert(Scene.Geometry.inObservationZone(sim, event), '测试位置应在有效观察区');
      assert(event.stopScan && event.stoppedDwell >= Scene.Constants.STOP_DWELL, '真实停稳并持续扫描后才应得分');
      assert(Scene.Geometry.scanSightlinesClear(sim, event), '观察区应能看到左右观察点');
    });

    test('12 正常让行车辆真实舒适减速、停稳并在玩家通过后起步', function () {
      const sim = new Scene.Simulation('yield-state-machine');
      const event = useEvent(sim, eventIdFor('yield-state-machine', 'left-yields'));
      sim.distance = event.position - Scene.Constants.EVENT_ACTIVATE + 0.01;
      sim.speed = sim.previousSpeed = 0;
      let previousSpeed = Infinity;
      let maxDeceleration = 0;
      for (let frame = 0; frame < 1000 && event.actor.state !== 'yield-stopped'; frame += 1) {
        const before = event.actor.speed;
        sim.step({ brake: true }, STEP);
        maxDeceleration = Math.max(maxDeceleration, before - event.actor.speed);
        previousSpeed = event.actor.speed;
      }
      assert(event.actor.state === 'yield-stopped' && event.actor.speed === 0, '让行车必须真实停稳');
      assert(previousSpeed === 0 && maxDeceleration < 0.05, '减速应连续且舒适');
      assert(event.actor.x + Scene.Constants.CROSS_CAR_HALF_WIDTH < Scene.Constants.CAR_MIN_X - 14,
        '让行车的完整车身必须位于玩家可选走廊外');
      const stoppedX = event.actor.x;
      for (let frame = 0; frame < 120; frame += 1) sim.step({ brake: true }, STEP);
      assert(event.actor.x === stoppedX, '玩家未通过时让行车不应无故起步');
      sim.distance = event.position + 10;
      sim.step({ brake: true }, STEP);
      assert(event.actor.state === 'clearing' && event.actor.x > stoppedX, '玩家车尾通过后让行车才恢复行驶');
    });

    test('12 持续通过车辆按车尾与安全缓冲清空，未让行事件有连续预警', function () {
      const sim = new Scene.Simulation('clear-geometry');
      sim.events.forEach(function (event) {
        const actor = event.actor;
        actor.active = true;
        actor.state = event.behavior === 'left-yields' ? 'crossing' : 'approach';
        actor.x = event.direction > 0 ? 210 : 210;
        actor.speed = event.initialSpeed;
        let previousX = actor.x;
        let maxStep = 0;
        for (let frame = 0; frame < 500 && !actor.routeClear; frame += 1) {
          Scene.advanceActor(event, actor, STEP, false);
          maxStep = Math.max(maxStep, Math.abs(actor.x - previousX));
          previousX = actor.x;
        }
        assert(actor.routeClear && maxStep < 1, '车辆应连续移动而非瞬移清空');
        if (event.direction > 0) assert(actor.x - Scene.Constants.CROSS_CAR_HALF_WIDTH > Scene.Constants.CAR_MAX_X + 14,
          '左到右车辆车尾必须越过全部可选车道与缓冲');
        else assert(actor.x + Scene.Constants.CROSS_CAR_HALF_WIDTH < Scene.Constants.CAR_MIN_X - 14,
          '右到左车辆车尾必须越过全部可选车道与缓冲');
      });
      const late = sim.events.find(function (event) { return event.behavior === 'left-late'; });
      const actor = late.actor;
      actor.active = true;
      actor.state = 'approach';
      actor.x = late.startX;
      actor.speed = late.initialSpeed;
      actor.routeClear = false;
      actor.cleared = false;
      const states = {};
      for (let frame = 0; frame < 500 && !actor.routeClear; frame += 1) {
        Scene.advanceActor(late, actor, STEP, false);
        states[actor.state] = true;
      }
      assert(states.slowing && states.crossing && states.clearing, '未及时让行必须先出现减速灯和滚动接近，再继续通过');
    });

    test('12 200 个防御种子安全完成、观察满分、高评价且无急刹', function () {
      for (let seed = 0; seed < 200; seed += 1) {
        const sim = run('cross-defense-' + seed, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'complete', '种子 ' + seed + ' 应安全完成，实际 ' + sim.status);
        assert(result.observation === 30, '种子 ' + seed + ' 观察应满分，实际 ' + result.observation);
        assert(result.total >= 85 && result.safety === 40, '种子 ' + seed + ' 应获高评价，实际 ' + result.total);
        assert(result.hardBrakes === 0, '种子 ' + seed + ' 正确策略不应依赖急刹');
        assert(sim.elapsed < 85, '种子 ' + seed + ' 必要等待不应造成龟速超时');
        assert(sim.events.every(function (event) { return event.resolved && event.correctJudgment; }),
          '种子 ' + seed + ' 三种判断都应正确完成');
      }
    });

    test('12 100 个持续高速种子在真实接触前定格，正常让行不制造碰撞', function () {
      for (let seed = 0; seed < 100; seed += 1) {
        const sim = run('cross-rush-' + seed, fullThrottleInput);
        assert(sim.status === 'frozen', '种子 ' + seed + ' 持续高速应在接触前定格');
        const event = sim.events[sim.freezeInfo.eventId];
        assert(event.behavior !== 'left-yields', '正常停稳让行事件不得凭空制造碰撞');
        assert(!Scene.Geometry.rectanglesOverlap(sim.distance, sim.x, event, event.actor),
          '种子 ' + seed + ' 定格时不得已经重叠');
        assert(event.failed && event.attempts === 1, '失败应记录在当前路口');
      }
    });

    test('12 输入感知预测允许充分制动，不停在原轨迹上误罚', function () {
      const sim = new Scene.Simulation('full-brake');
      const event = useEvent(sim, eventIdFor('full-brake', 'right-through'));
      sim.distance = event.position - 18;
      sim.speed = sim.previousSpeed = 40;
      event.actor.active = true;
      event.actor.state = 'crossing';
      event.actor.x = sim.x + 42;
      event.actor.speed = event.initialSpeed;
      for (let frame = 0; frame < 240; frame += 1) sim.step({ brake: true }, STEP);
      assert(sim.status === 'driving', '充分制动可以避让时不应预测误罚');
      assert(sim.speed < 0.1 && sim.distance + Scene.Constants.CAR_LENGTH_M / 2 < event.position - Scene.Constants.SIDE_ROAD_HALF_WIDTH_M,
        '车辆应在路口外真实停稳');
      assert(!Scene.Geometry.rectanglesOverlap(sim.distance, sim.x, event, event.actor), '制动后不得真实接触');
    });

    test('12 正常停稳让行允许及时通过，不要求等对方驶离地图', function () {
      for (let seed = 0; seed < 60; seed += 1) {
        const label = 'yield-pass-' + seed;
        const sim = new Scene.Simulation(label);
        const event = useEvent(sim, eventIdFor(label, 'left-yields'));
        let guard = 0;
        while (!event.resolved && sim.status === 'driving' && guard++ < 5000) sim.step(Scene.defensiveInput(sim), STEP);
        assert(event.resolved && sim.status === 'driving', '种子 ' + seed + ' 应完成正常让行事件');
        assert(event.correctJudgment && event.confirmedYieldTime >= 0.25, '必须先真实看见并确认停稳');
        assert(!event.actor.cleared, '通过时不得要求让行车已驶离整个地图');
        assert(!event.failed && !event.closePass, '正常让行通过不得扣分或伪造近距');
      }
    });

    test('12 低速无接触危险近距通过单独降分，不伪造碰撞', function () {
      const sim = new Scene.Simulation('close-pass');
      const event = useEvent(sim, eventIdFor('close-pass', 'left-late'));
      sim.distance = event.position - 3.2;
      sim.speed = sim.previousSpeed = 0;
      event.actor.active = true;
      event.actor.state = 'crossing';
      event.actor.x = sim.x + Scene.Constants.CONTACT_HALF_WIDTH + 2;
      event.actor.speed = 0;
      sim.step({}, STEP);
      assert(sim.status === 'driving' && !Scene.Geometry.rectanglesOverlap(sim.distance, sim.x, event, event.actor),
        '分离车身不应伪造碰撞');
      assert(event.closePass && !Scene.Scoring.eventSafe(event), '极小间距通过应失去安全分');
    });

    test('12 必要停车瞭望和让行效率中性，清空后空等恢复计时', function () {
      const sim = new Scene.Simulation('yield-efficiency');
      const event = useEvent(sim, 0);
      sim.distance = Scene.Geometry.observationLine(event) - 3;
      sim.speed = sim.previousSpeed = 0;
      event.actor.active = true;
      event.actor.state = 'crossing';
      event.actor.routeClear = false;
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 0, '必要停车瞭望不得计入效率分母');
      event.stopScan = true;
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 0, '必要让行也不应计入效率');
      event.actor.routeClear = true;
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 1, '清空后无故停车必须恢复效率计时');
    });

    test('12 不动与全程蠕行都会超时且总分封顶 69', function () {
      const idle = run('idle-cross', function () { return { brake: true }; });
      assert(idle.status === 'timeout', '持续停车不动应超时');
      assert(Scene.Scoring.summarize(idle, true).total <= 69, '不动超时应封顶 69');
      const creep = run('creep-cross', function (sim) {
        return { throttle: sim.speed < 4.8, brake: sim.speed > 5.2 };
      });
      assert(creep.status === 'timeout', '全程低速蠕行应超时');
      assert(Scene.Scoring.summarize(creep, true).total <= 69, '蠕行超时应封顶 69');
    });

    test('12 当前路口重试保留种子、首次失败和前文成绩', function () {
      const sim = new Scene.Simulation('retry-cross');
      sim.start();
      let guard = 0;
      while (sim.status === 'driving' && guard++ < 12000) {
        sim.step(sim.currentEvent && sim.currentEvent.id === 0 ? Scene.defensiveInput(sim) : fullThrottleInput(), STEP);
      }
      assert(sim.status === 'frozen', '应在后续路口制造真实失败');
      const id = sim.freezeInfo.eventId;
      const seed = sim.seed;
      const firstObservation = Scene.Scoring.eventObservation(sim.events[0]);
      sim.retryEvent();
      assert(sim.status === 'driving' && sim.currentEvent.id === id && sim.seed === seed, '只重试当前路口并保留种子');
      assert(sim.events[id].failed && sim.events[id].attempts === 1, '重试不得清除首次失败');
      assert(sim.events[0].resolved && Scene.Scoring.eventObservation(sim.events[0]) === firstObservation, '前文成绩不得重置');
      run(null, Scene.defensiveInput, 60, sim);
      const result = Scene.Scoring.summarize(sim, false);
      assert(result.failed && result.total <= 59, '失败后完成必须保留 59 分封顶');
    });

    test('12 三类示范与独立同场景 Simulation 逐帧一致', function () {
      ['right-through', 'left-yields', 'left-late'].forEach(function (behavior) {
        const seed = 'demo-' + behavior;
        const id = eventIdFor(seed, behavior);
        const official = new Scene.Simulation(seed);
        const demo = official.makeDemo(id);
        const expected = official.makeDemo(id);
        let frames = 0;
        while (demo.status === 'driving' && !(demo.events[id].resolved && demo.distance > demo.events[id].position + 12) && frames < 4000) {
          const input = Scene.defensiveInput(demo);
          demo.step(input, STEP);
          expected.step(Scene.defensiveInput(expected), STEP);
          assert(snapshot(demo) === snapshot(expected), behavior + ' 示范第 ' + frames + ' 帧不一致');
          frames += 1;
        }
        assert(frames > 300 && demo.events[id].resolved && demo.status === 'driving', behavior + ' 应真实完成当前路口');
        assert(demo.events[id].stopScan && demo.events[id].correctJudgment, behavior + ' 示范必须包含停车瞭望与正确判断');
      });
    });

    test('12 失败页真实示范结束后回到当前事件且不修改正式成绩', function () {
      const sim = run('demo-official-cross', fullThrottleInput);
      const id = sim.freezeInfo.eventId;
      const official = snapshot(sim);
      sim.startDemo();
      let steps = 0;
      while (sim.status === 'demonstrating' && steps++ < 4000) sim.stepDemo(STEP);
      assert(sim.status === 'driving' && steps > 300, '示范应真实行驶后返回当前事件');
      assert(sim.currentEvent.id === id && sim.events[id].failed, '返回后应保留当前事件和首次失败');
      const after = JSON.parse(snapshot(sim));
      const before = JSON.parse(official);
      assert(JSON.stringify(after.scoring) === JSON.stringify(before.scoring), '示范不得修改正式评分');
      assert(sim.events[0].failed === before.events[0].failed, '示范不得清除正式失败记录');
    });

    test('12 双方复盘不修改正式模拟，并能返回失败或结算', function () {
      const failed = run('replay-cross', fullThrottleInput);
      const official = JSON.stringify({ scoring: failed.scoring, events: failed.events, freezeInfo: failed.freezeInfo });
      failed.startPedestrianReplay();
      assert(failed.status === 'demonstrating' && failed.demoMode === 'cross', '应进入双方视角复盘');
      for (let frame = 0; frame < 180; frame += 1) failed.stepDemo(STEP);
      assert(JSON.stringify({ scoring: failed.scoring, events: failed.events, freezeInfo: failed.freezeInfo }) === official,
        '复盘不得修改正式成绩或事件');
      failed.finishReplay();
      assert(failed.status === 'frozen' && !failed.demo, '结束复盘应返回原失败画面');
      const complete = run('replay-result-cross', Scene.defensiveInput);
      complete.startPedestrianReplay();
      complete.finishReplay();
      assert(complete.status === 'complete', '结算复盘应能返回原结算');
    });

    test('12 30/60/120Hz 固定步长结果一致', function () {
      const snapshots = [30, 60, 120].map(function (hz) {
        return snapshot(run('fixed-step-cross', Scene.defensiveInput, hz));
      });
      assert(snapshots[0] === snapshots[1] && snapshots[1] === snapshots[2], '显示帧率不得改变模拟结果');
    });

    test('12 观察区、遮挡、失败定格、示范与双方复盘均可渲染', function () {
      const sim = new Scene.Simulation('render-cross');
      Scene.Renderer.render(mockContext(), sim);
      run('render-cross-active', function (current) {
        if (current.distance > 45) return { brake: true };
        return { throttle: current.speed < 35 };
      });
      const active = new Scene.Simulation('render-cross-active');
      active.start();
      for (let frame = 0; frame < 400; frame += 1) active.step(Scene.defensiveInput(active), STEP);
      Scene.Renderer.render(mockContext(), active);
      const frozen = run('render-frozen-cross', fullThrottleInput);
      Scene.Renderer.render(mockContext(), frozen);
      frozen.startDemo();
      frozen.stepDemo(STEP);
      Scene.Renderer.render(mockContext(), frozen);
      frozen.finishReplay();
      frozen.startPedestrianReplay();
      frozen.stepDemo(STEP);
      Scene.Renderer.render(mockContext(), frozen);
    });

    test('12 中英文、规则文案、目录入口与既有编号保护完整', function () {
      const entry = Game.CATALOG.find(function (game) { return game.id === 'unsignalized-cross-traffic'; });
      assert(entry && entry.episode === '12' && entry.status === 'playable' &&
        entry.href === 'unsignalized-cross-traffic.html', 'EP.12 必须提供真实独立入口');
      ['zh-CN', 'en'].forEach(function (language) {
        Game.I18N.setLanguage(language);
        ['scene.crossTraffic.documentTitle', 'scene.crossTraffic.ruleText', 'scene.crossTraffic.hud.fullStop',
          'scene.crossTraffic.failure.right', 'scene.crossTraffic.failure.late', 'scene.crossTraffic.demo.scanSub',
          'scene.crossTraffic.replay.neutral', 'scene.crossTraffic.result.advice.judgment'].forEach(function (key) {
            assert(Game.I18N.t(key) !== key, language + ' 缺少 ' + key);
          });
      });
      Game.I18N.setLanguage('zh-CN');
      assert(Game.CATALOG.find(function (game) { return game.episode === '03'; }).status === 'hidden', 'EP.03 应保持下线');
      assert(Game.CATALOG.find(function (game) { return game.episode === '05'; }).status === 'playable', 'EP.05 应保持可玩');
      assert(Game.CATALOG.find(function (game) { return game.episode === '10'; }).status === 'playable', 'EP.10 应保持可玩');
      assert(Game.CATALOG.find(function (game) { return game.episode === '11'; }).status === 'playable', 'EP.11 应保持可玩');
      assert(new Set(Game.CATALOG.map(function (game) { return game.id; })).size === Game.CATALOG.length, '目录 ID 不得重复');
      assert(Scene.ui && typeof Scene.ui.demoCaption === 'function' && typeof Scene.Renderer.render === 'function',
        '场景应完整接入通用页面控制器');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.UnsignalizedCrossTrafficTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
