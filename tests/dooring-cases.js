(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes.dooring;
  const C = Scene.Constants;
  const STEP = 1 / 60;

  function assert(condition, message) {
    if (!condition) throw new Error(message || '断言失败');
  }

  function run(seed, controller, hz) {
    const simulation = new Scene.Simulation(seed);
    simulation.start();
    const frame = 1 / (hz || 60);
    let accumulator = 0;
    let guard = 0;
    while (simulation.status === 'driving' && guard < 24000) {
      accumulator += frame;
      while (accumulator >= STEP && simulation.status === 'driving') {
        simulation.step(controller(simulation), STEP);
        accumulator -= STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    return simulation;
  }

  function prepareRole(simulation, index) {
    for (let id = 0; id < index; id += 1) {
      simulation.events[id].resolved = true;
      simulation.events[id].observation = 10;
      simulation.events[id].earlySlow = true;
    }
    simulation.setupRole(index);
    simulation.start();
  }

  function unsafePassengerInput(simulation) {
    if (simulation.currentRole !== 'passenger') return Scene.defensiveInput(simulation);
    if (simulation.currentEvent.firstOpen) return {};
    return simulation.cyclist.distance < C.PARKED_POSITION - 7 ? { left: true } : { throttle: true };
  }

  function roleThrottle(role) {
    return function (simulation) {
      return simulation.currentRole === role ? { throttle: true } : Scene.defensiveInput(simulation);
    };
  }

  function runTests() {
    const results = [];
    function test(name, callback) {
      try {
        callback();
        results.push({ name: '[08] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[08] ' + name, passed: false, error: error.message });
      }
    }

    test('同一种子复现共享计划，三幕独立重演同一开门事件', function () {
      for (let seed = 0; seed < 60; seed += 1) {
        const a = new Scene.Simulation('plan-' + seed);
        const b = new Scene.Simulation('plan-' + seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '种子计划不可复现');
        assert(a.events.map(function (event) { return event.role; }).join(',') === 'passenger,cyclist,driver', '角色顺序异常');
      }
      const simulation = new Scene.Simulation('independent');
      simulation.start();
      while (simulation.currentRole === 'passenger' && simulation.status === 'driving') {
        simulation.step(Scene.defensiveInput(simulation), STEP);
      }
      assert(simulation.events[0].resolved && simulation.currentRole === 'cyclist', '乘客幕未正常切换');
      assert(simulation.justResolved === simulation.events[0], '角色完成提示被切换过程清除');
      assert(simulation.door.state === 'closed' && !simulation.door.hasOpened, '乘客开门消除了骑行者幕事件');
      assert(simulation.distance === C.PARKED_POSITION - 55, '骑行者幕未从独立接近段开始');
      assert(simulation.plan === simulation.events[0].plan || simulation.plan.seed === 'independent', '共享计划丢失');
    });

    test('车门铰链连续转动，线段距离覆盖端点、近 miss 与骑行者宽度', function () {
      const door = { angle: 0 };
      assert(!Scene.Geometry.doorContact(door, C.BIKE_X, C.PARKED_POSITION), '关闭车门不应有碰撞体');
      door.angle = 90;
      const segment = Scene.Geometry.doorSegment(door);
      assert(Math.abs(segment.end.x - (C.DOOR_HINGE_X - C.DOOR_LENGTH_PX)) < 0.000001, '九十度门端几何错误');
      assert(Scene.Geometry.doorContact(door, C.BIKE_X, C.PARKED_POSITION + C.DOOR_HINGE_OFFSET), '打开车门未覆盖骑行路径');
      assert(!Scene.Geometry.doorContact(door, 150, C.PARKED_POSITION + C.DOOR_HINGE_OFFSET), '远处近 miss 被误判');
      assert(Scene.Geometry.pointSegmentDistance({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }) === 2, '零长线段距离错误');
      const moving = { state: 'closed', stateTime: 0, angle: 0, hold: 0, holdDuration: 0.1, automatic: true, hasOpened: false, cycleComplete: false };
      Scene.Geometry.triggerDoor(moving, 0.1, true);
      const angles = [];
      for (let index = 0; index < 180 && !moving.cycleComplete; index += 1) {
        Scene.Geometry.updateDoor(moving, STEP);
        angles.push(moving.angle);
      }
      assert(moving.cycleComplete && moving.angle === 0, '车门未完成完整开闭循环');
      assert(angles.some(function (angle) { return angle > 0 && angle < 90; }), '车门瞬间生成，没有连续角度');
    });

    test('防御策略 200 种子完成三幕、观察满分且无急刹', function () {
      for (let seed = 0; seed < 200; seed += 1) {
        const simulation = run('door-defense-' + seed, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(simulation, simulation.status === 'timeout');
        assert(simulation.status === 'complete', '种子 ' + seed + ' 未完成：' + simulation.status);
        assert(!result.failed && result.total >= 85, '种子 ' + seed + ' 防御结果异常：' + result.total);
        assert(result.observation === 30 && result.earlySlowCount === 3, '种子 ' + seed + ' 观察奖励不足');
        assert(result.hardBrakes === 0, '种子 ' + seed + ' 防御策略出现急刹');
        assert(simulation.events.every(function (event) { return event.resolved && event.observation === 10; }), '三幕未分别独立评分');
      }
    });

    test('乘客在骑行者接近时开门，于实际接触前定格', function () {
      for (let seed = 0; seed < 40; seed += 1) {
        const simulation = run('passenger-fast-' + seed, unsafePassengerInput);
        assert(simulation.status === 'frozen' && simulation.freezeInfo.reason === 'passenger', '种子 ' + seed + ' 危险开门未定格');
        assert(!Scene.Geometry.doorContact(simulation.door, simulation.cyclist.x, simulation.cyclist.distance), '定格画面已经发生接触');
        assert(simulation.events[0].failed && simulation.events[0].attempts === 1, '乘客失败记录缺失');
      }
    });

    test('远手开门不能替代回头观察和微开确认', function () {
      const simulation = new Scene.Simulation('observation-not-automatic');
      prepareRole(simulation, 0);
      let opened = false;
      let guard = 0;
      while (simulation.currentRole === 'passenger' && simulation.status === 'driving' && guard < 3000) {
        const clear = simulation.cyclist.distance > C.PARKED_POSITION + 7;
        simulation.step(clear && !opened ? { throttle: true } : {}, STEP);
        if (clear) opened = true;
        guard += 1;
      }
      assert(simulation.events[0].resolved, '安全时直接开门仍应能完成');
      assert(!simulation.events[0].lookedBeforeOpen && !simulation.events[0].openedAfterCrack, '未执行动作却被记为完成');
      assert(simulation.events[0].observation === 3, '直接远手开门不应获得观察与微开分');
    });

    test('骑行者持续高速 100 种子均在车门前预测冲突', function () {
      for (let seed = 0; seed < 100; seed += 1) {
        const simulation = run('cyclist-fast-' + seed, roleThrottle('cyclist'));
        assert(simulation.status === 'frozen' && simulation.freezeInfo.reason === 'cyclistDoor', '种子 ' + seed + ' 高速骑行未定格');
        assert(!Scene.Geometry.doorContact(simulation.door, simulation.x, simulation.distance), '种子 ' + seed + ' 已重叠才定格');
      }
    });

    test('骑行者强行向左绕行车门会与相邻来车形成冲突', function () {
      const simulation = run('swerve-traffic', function (current) {
        if (current.currentRole === 'cyclist') return { left: true, throttle: true };
        return Scene.defensiveInput(current);
      });
      assert(simulation.status === 'frozen' && simulation.freezeInfo.reason === 'cyclistTraffic', '向左固定绕行被当成正确答案');
      assert(!Scene.Geometry.carBikeContact(simulation.traffic.x, simulation.traffic.distance, simulation.x, simulation.distance), '来车冲突在实际重叠后才定格');
    });

    test('输入感知预测允许充分制动，持续加速仍进入车门', function () {
      const simulation = new Scene.Simulation('input-prediction');
      prepareRole(simulation, 1);
      simulation.distance = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - 8;
      simulation.speed = 24;
      simulation.x = C.BIKE_X;
      simulation.door = Object.assign(simulation.door, { state: 'open', angle: 90, hold: 10, hasOpened: true });
      assert(!simulation.predictCyclistConflict({ brake: true }), '足够距离内制动不应误罚');
      assert(simulation.predictCyclistConflict({ throttle: true }) === 'cyclistDoor', '持续加速未预测车门冲突');
    });

    test('临近车门才大力制动能停住，但会损失平稳分', function () {
      const simulation = new Scene.Simulation('late-emergency');
      prepareRole(simulation, 1);
      simulation.distance = C.PARKED_POSITION + C.DOOR_HINGE_OFFSET - 13;
      simulation.speed = 30;
      simulation.previousSpeed = 30;
      simulation.door = Object.assign(simulation.door, { state: 'open', angle: 90, hold: 5, hasOpened: true });
      for (let index = 0; index < 20 && simulation.status === 'driving'; index += 1) {
        simulation.step({ brake: true }, STEP);
      }
      assert(simulation.status === 'driving', '足够制动距离内被误罚');
      assert(simulation.scoring.hardBrakes > 0, '临近危险的大力制动未计入平稳分');
    });

    test('后车贴近骑行者会预测冲突，未碰撞贴骑通过也独立扣分', function () {
      const tailgate = new Scene.Simulation('tailgate');
      prepareRole(tailgate, 2);
      tailgate.distance = tailgate.cyclist.distance - 7;
      tailgate.x = tailgate.cyclist.x;
      tailgate.previousSpeed = tailgate.speed;
      tailgate.door = Object.assign(tailgate.door, { state: 'open', angle: 90, hold: 3, hasOpened: true });
      tailgate.step({ throttle: true }, STEP);
      assert(tailgate.status === 'frozen' && tailgate.freezeInfo.reason === 'driver', '贴近跟车未预测冲突');
      const closePass = run('close-pass', roleThrottle('driver'));
      const event = closePass.events[2];
      const result = Scene.Scoring.summarize(closePass, closePass.status === 'timeout');
      assert(closePass.status === 'complete' && event.closePasses > 0, '高速贴骑通过没有独立记录');
      assert(event.observation === 0 && result.closePasses > 0 && result.safety < 40, '未碰撞贴骑仍获得安全或观察满分');
    });

    test('三幕必要等待效率中性，危险解除后继续停车恢复扣分', function () {
      const cyclist = new Scene.Simulation('yield-cyclist');
      prepareRole(cyclist, 1);
      cyclist.distance = C.PARKED_POSITION - 15;
      cyclist.speed = 0;
      cyclist.door = Object.assign(cyclist.door, { state: 'open', angle: 90, hold: 3, hasOpened: true });
      assert(Scene.Scoring.isYieldExempt(cyclist), '骑行者车门前停车未豁免');
      cyclist.step({ brake: true }, STEP);
      assert(cyclist.scoring.efficiencyTime === 0 && cyclist.scoring.efficiencyIntegral === 0, '必要等待计入效率');
      cyclist.door.cycleComplete = true;
      assert(!Scene.Scoring.isYieldExempt(cyclist), '车门关闭后继续停车仍被豁免');
      cyclist.step({}, STEP);
      assert(cyclist.scoring.efficiencyTime > 0, '危险解除后未恢复效率计时');
      const driver = new Scene.Simulation('yield-driver');
      prepareRole(driver, 2);
      driver.distance = driver.cyclist.distance - 20;
      driver.speed = driver.cyclist.speed;
      assert(Scene.Scoring.isYieldExempt(driver), '合理跟随慢速骑行者不应扣效率');
    });

    test('当前角色重试保留前幕成绩、失败、attempts、计划与 59 分封顶', function () {
      const simulation = run('retry-cyclist', roleThrottle('cyclist'));
      assert(simulation.status === 'frozen' && simulation.freezeInfo.eventId === 1, '应在骑行者幕失败');
      const plan = JSON.stringify(simulation.plan);
      simulation.retryEvent();
      assert(simulation.currentRole === 'cyclist' && simulation.events[0].observation === 10, '重试清除了前幕成绩');
      assert(simulation.events[1].failed && simulation.events[1].attempts === 1, '重试清除了失败记录');
      let guard = 0;
      while (simulation.status === 'driving' && guard < 12000) {
        simulation.step(Scene.defensiveInput(simulation), STEP);
        guard += 1;
      }
      const result = Scene.Scoring.summarize(simulation, false);
      assert(simulation.status === 'complete' && result.observation === 30, '重试后不能正确完成');
      assert(result.failed && result.total <= 59, '首次失败后总分未封顶 59');
      assert(JSON.stringify(simulation.plan) === plan, '重试重新随机了交通计划');
    });

    test('三个角色的示范都逐帧复用真实 Simulation 并回到原角色', function () {
      [0, 1, 2].forEach(function (roleIndex) {
        const simulation = new Scene.Simulation('demo-role-' + roleIndex);
        prepareRole(simulation, roleIndex);
        simulation.freezeInfo = { eventId: roleIndex, role: simulation.currentRole, reason: 'test', speed: simulation.speed };
        simulation.status = 'frozen';
        simulation.startDemo();
        const expected = new Scene.Simulation(simulation.seed);
        prepareRole(expected, roleIndex);
        let guard = 0;
        while (simulation.status === 'demonstrating' && guard < 4000) {
          simulation.stepDemo(STEP);
          expected.step(Scene.defensiveInput(expected), STEP);
          if (simulation.status !== 'demonstrating') break;
          assert(Math.abs(simulation.demo.distance - expected.distance) < 0.000001, '角色 ' + roleIndex + ' 示范位置不一致');
          assert(simulation.demo.speed === expected.speed && simulation.demo.door.angle === expected.door.angle, '角色 ' + roleIndex + ' 示范状态不一致');
          guard += 1;
        }
        assert(expected.events[roleIndex].resolved, '角色 ' + roleIndex + ' 示范未真实完成');
        assert(simulation.status === 'driving' && simulation.roleIndex === roleIndex && simulation.demo === null, '示范未回到原角色重试');
      });
    });

    test('30/60/120Hz 固定步长下三幕结果一致', function () {
      const reports = [30, 60, 120].map(function (hz) {
        const simulation = run('door-hz', Scene.defensiveInput, hz);
        const result = Scene.Scoring.summarize(simulation, simulation.status === 'timeout');
        return JSON.stringify({
          status: simulation.status,
          elapsed: simulation.elapsed,
          total: result.total,
          observation: result.observation,
          events: simulation.events.map(function (event) { return [event.observation, event.closePasses, event.failed]; })
        });
      });
      assert(reports[0] === reports[1] && reports[1] === reports[2], '帧率改变三幕结果');
    });

    test('乘客不操作会超时并封顶 69，不能用停车刷高分', function () {
      const simulation = run('passenger-idle', function () { return {}; });
      const result = Scene.Scoring.summarize(simulation, true);
      assert(simulation.status === 'timeout' && result.total <= 69, '长期不操作未超时或未封顶');
      assert(result.efficiency < 20, '危险解除后继续不操作没有效率损失');
    });

    test('Renderer 可绘制三幕、定格与示范，角色按钮随幕切换', function () {
      const noop = function () {};
      let clears = 0;
      const ctx = {
        clearRect: function () { clears += 1; }, fillRect: noop, beginPath: noop,
        moveTo: noop, lineTo: noop, stroke: noop, setLineDash: noop,
        save: noop, restore: noop, measureText: function (text) { return { width: String(text).length * 7 }; },
        fillText: function (text, x, y) { assert(Number.isFinite(x) && Number.isFinite(y), '绘制坐标无效'); }
      };
      for (let index = 0; index < 3; index += 1) {
        const simulation = new Scene.Simulation('render-' + index);
        prepareRole(simulation, index);
        Scene.Renderer.render(ctx, simulation);
        const controls = Scene.ui.controls(simulation);
        if (index === 0) assert(controls.right.hidden && controls.left.label !== controls.throttle.label, '乘客按钮未使用独立动作');
        else assert(!controls.left.hidden && !controls.right.hidden, '驾驶幕未恢复方向按钮');
      }
      const frozen = run('render-failure', roleThrottle('cyclist'));
      Scene.Renderer.render(ctx, frozen);
      frozen.startDemo();
      for (let index = 0; index < 60; index += 1) frozen.stepDemo(STEP);
      Scene.Renderer.render(ctx, frozen);
      assert(clears === 5, '三幕、定格和示范未全部绘制');
    });

    test('全部新增中英文文案、结果键和首页入口完整', function () {
      const simulation = run('door-i18n', Scene.defensiveInput);
      const result = Scene.Scoring.summarize(simulation, false);
      const keys = [result.titleKey, result.summaryKey, result.adviceKey,
        'scene.dooring.hud.passenger.look', 'scene.dooring.hud.cyclist.door',
        'scene.dooring.hud.driver.door', 'scene.dooring.demo.passenger',
        'scene.dooring.demo.cyclist', 'scene.dooring.demo.driver',
        'scene.dooring.failure.passenger', 'scene.dooring.failure.cyclistTraffic'];
      ['zh', 'en'].forEach(function (language) {
        Game.I18N.setLanguage(language);
        keys.forEach(function (key) {
          const value = Game.I18N.t(key);
          assert(value && value !== key, language + ' 缺少文案 ' + key);
        });
        [0, 1, 2].forEach(function (index) {
          const current = new Scene.Simulation('controls-' + index);
          prepareRole(current, index);
          assert(Scene.ui.progress(current) && Scene.ui.coach(current, 20).text, '角色 UI 文案缺失');
        });
      });
      Game.I18N.setLanguage('zh');
      const entry = Game.CATALOG.find(function (game) { return game.id === 'dooring'; });
      assert(entry && entry.episode === '08' && entry.status === 'playable' && entry.href === 'dooring.html', '首页 EP.08 入口缺失');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.DooringTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
