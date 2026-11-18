(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['crosswalk-occlusion'];
  const C = Scene.Constants;
  const FIXED_STEP = 1 / 60;

  function assert(condition, message) {
    if (!condition) throw new Error(message || '断言失败');
  }

  function run(seed, controller, hz) {
    const simulation = new Scene.Simulation(seed);
    simulation.start();
    const frame = 1 / (hz || 60);
    let accumulator = 0;
    let guard = 0;
    while (simulation.status === 'driving' && guard < 20000) {
      accumulator += frame;
      while (accumulator >= FIXED_STEP && simulation.status === 'driving') {
        simulation.step(controller(simulation), FIXED_STEP);
        accumulator -= FIXED_STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    return simulation;
  }

  function fullThrottleInput() {
    return { throttle: true, brake: false, left: false, right: false };
  }

  function crawlerInput(simulation) {
    const event = simulation.currentEvent;
    const target = Scene.yieldRequired(simulation, event, true) ? 0 : 15;
    return {
      throttle: simulation.speed < target - 0.5,
      brake: simulation.speed > target + 0.5,
      right: true
    };
  }

  function lateInput(simulation) {
    const event = simulation.currentEvent;
    if (!event) return { throttle: simulation.speed < 47, brake: false, right: false };
    const remaining = event.crossingPosition - simulation.distance;
    let target = 30;
    if (remaining < 12 && remaining > -C.RISK_END) {
      target = Scene.yieldRequired(simulation, event, true) ? 0 : 18;
    }
    return {
      throttle: simulation.speed < target - 0.5,
      brake: simulation.speed > target + 0.5,
      right: remaining < 45 && remaining > -C.RISK_END
    };
  }

  function firstOccupiedSeed(prefix) {
    let seed = 0;
    while (!new Scene.Simulation((prefix || 'occupied-') + seed).events[0].occupied) seed += 1;
    return (prefix || 'occupied-') + seed;
  }

  function prepareEvent(simulation, event) {
    simulation.events.slice(0, event.id).forEach(function (item) { item.resolved = true; });
    simulation.distance = event.crossingPosition - C.REVEAL_DISTANCE + 0.01;
    simulation.speed = 0;
    simulation.previousSpeed = 0;
    simulation.start();
  }

  function runTests() {
    const results = [];
    function test(name, callback) {
      try {
        callback();
        results.push({ name: '[02] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[02] ' + name, passed: false, error: error.message });
      }
    }

    test('同一种子复现事件，每局三条斑马线均有行人', function () {
      for (let seed = 0; seed < 60; seed += 1) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.events) === JSON.stringify(b.events), '种子 ' + seed + ' 不可复现');
        const occupied = a.events.filter(function (event) { return event.occupied; }).length;
        assert(occupied === 3, '每局应固定有三组有人事件：' + occupied);
        a.events.forEach(function (event) {
          assert(event.occupied, '仍存在无人斑马线');
          assert(event.neighborSpeed >= 34 && event.neighborSpeed <= 38, '蓝车巡航速度越界');
          assert(event.runSpeed >= 22 && event.runSpeed <= 28, '行人动画速度越界');
          assert(event.neighbor.speed === event.neighborSpeed, '蓝车应从巡航状态进入，而非瞬间加速');
        });
      }
    });

    test('segment/AABB 覆盖平行、端点、零长线段和近 miss', function () {
      const hit = Scene.Geometry.segmentIntersectsAABB;
      const rect = { left: 4, right: 6, bottom: 4, top: 6 };
      assert(hit({ x: 0, y: 0 }, { x: 10, y: 10 }, rect), '对角线穿过矩形应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 0, y: 10 }, rect), '矩形外平行线不应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 3, y: 3 }, rect), '线段后方的矩形不应相交');
      assert(hit({ x: 0, y: 0 }, { x: 10, y: 10 }, { left: 9, right: 11, bottom: 9, top: 11 }), '端点覆盖应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 10, y: 10 }, { left: 6.1, right: 7, bottom: 0, top: 4 }), '擦边近 miss 不应相交');
      assert(hit({ x: 5, y: 5 }, { x: 5, y: 5 }, rect), '矩形内部零长线段应相交');
    });

    test('蓝车连续制动不越前置线，行人清空后恢复并驶离', function () {
      for (let seed = 0; seed < 40; seed += 1) {
        const simulation = new Scene.Simulation('neighbor-' + seed);
        const event = simulation.events.find(function (item) { return item.occupied; });
        prepareEvent(simulation, event);
        const states = [];
        let maxDrop = 0;
        let previousSpeed = event.neighbor.speed;
        let guard = 0;
        while (event.neighbor.state !== 'gone' && guard < 60 * 30) {
          simulation.step({}, FIXED_STEP);
          if (states[states.length - 1] !== event.neighbor.state) states.push(event.neighbor.state);
          if (event.active && ['approach', 'braking', 'yielding'].includes(event.neighbor.state)) {
            maxDrop = Math.max(maxDrop, previousSpeed - event.neighbor.speed);
            const front = event.neighbor.distance + C.NEIGHBOR_LENGTH_PX / 2 / C.PIXELS_PER_METER;
            assert(front <= event.crossingPosition - C.NEIGHBOR_STOP_LINE_GAP + 0.0001, '蓝车车头越过前置停止线');
          }
          previousSpeed = event.neighbor.speed;
          guard += 1;
        }
        assert(states.join('>') === 'approach>braking>yielding>recovering>gone', '状态顺序异常：' + states.join('>'));
        assert(maxDrop < 0.5, '蓝车发生高速瞬间归零：' + maxDrop + ' km/h/frame');
        const stopFront = Scene.Geometry.neighborStopPosition(event) + C.NEIGHBOR_LENGTH_PX / 2 / C.PIXELS_PER_METER;
        assert(stopFront < event.crossingPosition - C.NEIGHBOR_STOP_LINE_GAP, '停车目标未保留车头缓冲');
        assert(event.pedestrian.active && event.pedestrian.cleared, '有人事件未经过完整横穿过程');
        assert(!event.resolved, '玩家远停不应自动结算事件');
      }
    });

    test('每次游玩的三条斑马线都有完整行人与蓝车让行过程', function () {
      for (let seed = 0; seed < 30; seed += 1) {
        const simulation = run('all-occupied-' + seed, Scene.defensiveInput);
        assert(simulation.status === 'complete', '种子 ' + seed + ' 未完成');
        simulation.events.forEach(function (event) {
          assert(event.occupied && event.pedestrian.active && event.pedestrian.cleared,
            '种子 ' + seed + ' 第 ' + event.id + ' 条斑马线没有完整行人过程');
          assert(event.pedestrian.firstVisibleDistance != null,
            '种子 ' + seed + ' 第 ' + event.id + ' 条斑马线行人从未真实可见');
          assert(['recovering', 'gone'].includes(event.neighbor.state),
            '种子 ' + seed + ' 第 ' + event.id + ' 条斑马线蓝车未在清空后恢复');
        });
      }
    });

    test('正常接近和远停时，蓝车停稳都对应真实过街行人', function () {
      ['normal', 'far'].forEach(function (mode) {
        const simulation = new Scene.Simulation('occupied-' + mode);
        const event = simulation.events[0];
        if (mode === 'far') prepareEvent(simulation, event);
        else simulation.start();
        let guard = 0;
        while (event.neighbor.state !== 'yielding' && guard < 60 * 30) {
          simulation.step(mode === 'far' ? {} : Scene.defensiveInput(simulation), FIXED_STEP);
          guard += 1;
        }
        assert(event.neighbor.state === 'yielding', mode + ' 蓝车未停车让行');
        assert(event.occupied && event.pedestrian.active && !event.pedestrian.cleared,
          mode + ' 蓝车停稳时没有实际过街行人');
        while (event.neighbor.state === 'yielding' && guard < 60 * 30) {
          simulation.step(mode === 'far' ? {} : Scene.defensiveInput(simulation), FIXED_STEP);
          guard += 1;
        }
        assert(event.pedestrian.cleared && event.neighbor.state === 'recovering',
          mode + ' 蓝车未等行人清空后恢复');
      });
    });

    test('动态 LOS 随距离、横向选位和蓝车离开改变', function () {
      const simulation = new Scene.Simulation('los');
      const event = simulation.events[0];
      event.active = true;
      event.occupied = true;
      event.neighbor.distance = Scene.Geometry.neighborStopPosition(event);
      event.neighbor.state = 'yielding';
      event.pedestrian.active = true;
      event.pedestrian.x = C.PEDESTRIAN_START_X;
      simulation.distance = event.crossingPosition - 60;
      simulation.x = C.CAR_X;
      assert(!Scene.Geometry.visibilityFor(simulation, event).visible, '远处代表性视线应被蓝车遮挡');
      simulation.x = C.CAR_MAX_X;
      assert(Scene.Geometry.visibilityFor(simulation, event).visible, '向右选位应改善同一视线');
      simulation.x = C.CAR_X;
      simulation.distance = event.crossingPosition - 20;
      assert(Scene.Geometry.visibilityFor(simulation, event).visible, '前置停止线应改善近处视线');
      simulation.distance = event.crossingPosition - 60;
      event.neighbor.state = 'gone';
      assert(Scene.Geometry.visibilityFor(simulation, event).visible, '蓝车离开后不应继续遮挡');
    });

    test('防御策略 200 种子安全完成、观察满分且无急刹', function () {
      for (let seed = 0; seed < 200; seed += 1) {
        const simulation = run('cw-defense-' + seed, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(simulation, simulation.status === 'timeout');
        assert(simulation.status === 'complete', '种子 ' + seed + ' 未完成：' + simulation.status);
        assert(!result.failed, '种子 ' + seed + ' 防御策略失败');
        assert(result.total >= 85, '种子 ' + seed + ' 得分偏低：' + result.total);
        assert(result.observation === 30 && result.earlySlowCount === 3, '种子 ' + seed + ' 观察奖励不足');
        assert(result.hardBrakes === 0, '种子 ' + seed + ' 依靠急刹完成');
        assert(simulation.elapsed < 95, '种子 ' + seed + ' 超时');
        simulation.events.filter(function (event) { return event.occupied; }).forEach(function (event) {
          assert(event.pedestrian.firstVisibleDistance != null, '种子 ' + seed + ' 有人事件从未真实可见');
        });
      }
    });

    test('持续高速 100 种子均在真实接触前定格', function () {
      for (let seed = 0; seed < 100; seed += 1) {
        const simulation = run('cw-fast-' + seed, fullThrottleInput);
        assert(simulation.status === 'frozen', '种子 ' + seed + ' 高速未定格：' + simulation.status);
        const event = simulation.events[simulation.freezeInfo.eventId];
        assert(event.occupied && event.pedestrian.active && !event.pedestrian.cleared, '定格不是来自真实冲突');
        const horizontal = Math.abs(event.pedestrian.x - simulation.x) <
          Game.C.CAR_WIDTH_M * C.PIXELS_PER_METER / 2 + 3.2;
        const vertical = event.crossingPosition < simulation.distance + Game.C.CAR_LENGTH_M / 2 &&
          event.crossingPosition > simulation.distance - Game.C.CAR_LENGTH_M / 2;
        assert(!(horizontal && vertical), '种子 ' + seed + ' 展示已重叠画面');
        assert(simulation.freezeInfo.distanceToCross > 0, '种子 ' + seed + ' 定格时已经越过斑马线');
      }
    });

    test('输入感知预测允许充分制动，持续加速仍会冲突', function () {
      const simulation = new Scene.Simulation('prediction');
      const event = simulation.events[0];
      event.occupied = true;
      event.pedestrian.active = true;
      event.pedestrian.x = simulation.x - 12;
      simulation.distance = event.crossingPosition - 9;
      simulation.speed = 30;
      simulation.acceleration = -C.EMERGENCY_BRAKE_DECELERATION;
      assert(!simulation.predictConflict(event, { brake: true }), '充分制动不应被误罚');
      assert(simulation.predictConflict(event, { throttle: true }), '持续加速应预测到冲突');
    });

    test('提前防御优于临近制动，低速且必要让行仍不能刷高分', function () {
      for (let seed = 0; seed < 30; seed += 1) {
        const early = run('compare-' + seed, Scene.defensiveInput);
        const late = run('compare-' + seed, lateInput);
        assert(early.status === 'complete' && late.status === 'complete', '对照策略应安全完成：' + seed);
        const earlyResult = Scene.Scoring.summarize(early, false);
        const lateResult = Scene.Scoring.summarize(late, false);
        assert(earlyResult.observation > lateResult.observation, '种子 ' + seed + ' 观察分无差异');
        assert(earlyResult.total > lateResult.total, '种子 ' + seed + ' 总分无差异');
      }
      for (let seed = 0; seed < 50; seed += 1) {
        const simulation = run('crawl-' + seed, crawlerInput);
        const result = Scene.Scoring.summarize(simulation, simulation.status === 'timeout');
        assert(simulation.status === 'timeout', '种子 ' + seed + ' 龟速应超时：' + simulation.status);
        assert(result.total <= 69, '种子 ' + seed + ' 龟速得分过高：' + result.total);
      }
    });

    test('必要让行效率中性，清空或远停时恢复计时', function () {
      const simulation = new Scene.Simulation('yield-efficiency');
      const event = simulation.events.find(function (item) { return item.occupied; });
      prepareEvent(simulation, event);
      simulation.distance = event.crossingPosition - 10;
      event.active = true;
      event.neighbor.state = 'yielding';
      event.neighbor.stopped = true;
      event.pedestrian.active = true;
      event.pedestrian.visible = true;
      event.pedestrian.x = simulation.x;
      assert(Scene.Scoring.isYieldExempt(simulation), '合理让行区停车应豁免');
      Scene.Scoring.recordStep(simulation.scoring, simulation, 1);
      assert(simulation.scoring.efficiencyTime === 0 && simulation.scoring.efficiencyIntegral === 0,
        '必要等待计入效率分子或分母');
      event.neighbor.state = 'recovering';
      event.neighbor.stopped = false;
      event.pedestrian.cleared = true;
      event.pedestrian.visible = false;
      assert(!Scene.Scoring.isYieldExempt(simulation), '清空后继续停车不应豁免');
      Scene.Scoring.recordStep(simulation.scoring, simulation, 1);
      assert(simulation.scoring.efficiencyTime === 1, '清空后未恢复效率计时');
      event.neighbor.state = 'yielding';
      event.neighbor.stopped = true;
      simulation.distance = event.crossingPosition - 40;
      assert(!Scene.Scoring.isYieldExempt(simulation), '远离冲突区停车不应豁免');
    });

    test('重试保留失败、attempts、布局与 59 分封顶', function () {
      const simulation = run(firstOccupiedSeed('retry-'), fullThrottleInput);
      assert(simulation.status === 'frozen', '应先发生失败');
      const failedId = simulation.freezeInfo.eventId;
      const layout = JSON.stringify(simulation.events.map(function (event) {
        return { occupied: event.occupied, runSpeed: event.runSpeed, neighborSpeed: event.neighborSpeed };
      }));
      simulation.retryEvent();
      assert(simulation.status === 'driving', '重试后应恢复驾驶');
      assert(simulation.events[failedId].failed && simulation.events[failedId].attempts === 1, '重试洗掉失败记录');
      assert(simulation.distance === simulation.events[failedId].crossingPosition - 55, '未回到当前事件接近段');
      let guard = 0;
      while (simulation.status === 'driving' && guard < 12000) {
        simulation.step(Scene.defensiveInput(simulation), FIXED_STEP);
        guard += 1;
      }
      const result = Scene.Scoring.summarize(simulation, simulation.status === 'timeout');
      assert(simulation.status === 'complete', '重试后防御驾驶应完成');
      assert(result.failed && result.total <= 59, '失败后未封顶 59');
      assert(result.observation === 30, '重试后正确操作未获得当前事件观察分');
      const afterLayout = JSON.stringify(simulation.events.map(function (event) {
        return { occupied: event.occupied, runSpeed: event.runSpeed, neighborSpeed: event.neighborSpeed };
      }));
      assert(afterLayout === layout, '重试或示范重新随机了事件');
    });

    test('示范逐帧复用真实 Simulation，结束后回到原失败事件', function () {
      const simulation = run(firstOccupiedSeed('demo-'), fullThrottleInput);
      assert(simulation.status === 'frozen', '应先发生失败');
      const failedId = simulation.freezeInfo.eventId;
      simulation.startDemo();
      assert(simulation.status === 'demonstrating' && simulation.demo, '未进入隔离示范');
      const expected = new Scene.Simulation(simulation.seed);
      for (let index = 0; index < failedId; index += 1) {
        expected.events[index].resolved = true;
        expected.events[index].earlySlow = true;
        expected.events[index].maxLateralShift = C.LATERAL_SHIFT;
      }
      expected.distance = expected.events[failedId].crossingPosition - 55;
      expected.speed = 45;
      expected.previousSpeed = 45;
      expected.start();
      let guard = 0;
      while (simulation.status === 'demonstrating' && guard < 1200) {
        simulation.stepDemo(FIXED_STEP);
        expected.step(Scene.defensiveInput(expected), FIXED_STEP);
        if (simulation.status !== 'demonstrating') break;
        assert(Math.abs(simulation.demo.distance - expected.distance) < 0.000001, '示范第 ' + guard + ' 帧位置不一致');
        assert(simulation.demo.speed === expected.speed && simulation.demo.x === expected.x, '示范车辆状态不一致');
        const actualEvent = simulation.demo.events[failedId];
        assert(actualEvent.neighbor.state === expected.events[failedId].neighbor.state &&
          actualEvent.pedestrian.x === expected.events[failedId].pedestrian.x, '示范交通状态不一致');
        guard += 1;
      }
      assert(simulation.status === 'driving' && simulation.demo === null, '示范结束未回到重试');
      assert(simulation.events[failedId].failed && simulation.events[failedId].attempts === 1, '示范洗掉正式失败');
      assert(expected.events[failedId].resolved, '示范未真实通过事件');
      assert(['recovering', 'gone'].includes(expected.events[failedId].neighbor.state), '示范未展示蓝车恢复');
    });

    test('30/60/120Hz 固定步长结果和事件轨迹一致', function () {
      const summaries = [30, 60, 120].map(function (hz) {
        const simulation = run('hz-consistency', Scene.defensiveInput, hz);
        const result = Scene.Scoring.summarize(simulation, simulation.status === 'timeout');
        return JSON.stringify({
          status: simulation.status,
          elapsed: simulation.elapsed,
          total: result.total,
          observation: result.observation,
          hardBrakes: result.hardBrakes,
          events: simulation.events.map(function (event) {
            return [event.earlySlow, event.lateSlow, event.failed, event.neighbor.state, event.pedestrian.x];
          })
        });
      });
      assert(summaries[0] === summaries[1] && summaries[1] === summaries[2], '帧率改变模拟结果');
    });

    test('Renderer 可绘制正常、动态遮挡、定格和真实示范', function () {
      const noop = function () {};
      let clears = 0;
      const ctx = {
        clearRect: function () { clears += 1; },
        fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
        stroke: noop, setLineDash: noop, save: noop, restore: noop,
        measureText: function (text) { return { width: String(text).length * 7 }; },
        fillText: function (text, x, y) {
          assert(Number.isFinite(x) && Number.isFinite(y), '文字坐标必须有限');
        }
      };
      const normal = run('render-normal', Scene.defensiveInput);
      Scene.Renderer.render(ctx, normal);
      const frozen = run(firstOccupiedSeed('render-freeze-'), fullThrottleInput);
      Scene.Renderer.render(ctx, frozen);
      frozen.startDemo();
      for (let index = 0; index < 180 && frozen.status === 'demonstrating'; index += 1) frozen.stepDemo(FIXED_STEP);
      Scene.Renderer.render(ctx, frozen);
      assert(clears === 3, '正常、定格和示范都应完成静态渲染');
    });

    test('评分、HUD 与示范均返回可翻译的稳定文案', function () {
      const simulation = run('i18n', Scene.defensiveInput);
      const result = Scene.Scoring.summarize(simulation, false);
      const keys = [result.titleKey, result.summaryKey, result.adviceKey,
        'scene.crosswalk.hud.neighborSignal', 'scene.crosswalk.demo.wait'];
      ['zh-CN', 'en'].forEach(function (language) {
        Game.I18N.setLanguage(language);
        keys.forEach(function (key) {
          const text = Game.I18N.t(key);
          assert(text && text !== key, language + ' 缺少文案 ' + key);
        });
      });
      Game.I18N.setLanguage('zh-CN');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.CrosswalkTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
