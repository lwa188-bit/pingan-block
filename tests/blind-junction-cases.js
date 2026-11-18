(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['blind-junction'];
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

  function fullThrottleInput() {
    return { throttle: true, brake: false, left: false, right: false };
  }

  function highSpeedInput(sim) {
    return { throttle: sim.speed < 44, brake: false, left: false, right: false };
  }

  function crawlerInput(sim) {
    const event = sim.currentEvent;
    let target = 15;
    if (event) {
      const bumperRemaining = event.position - (sim.distance + Scene.Constants.CAR_LENGTH_M / 2);
      if (event.actor.visible && Scene.actorBlocking(sim, event) &&
        bumperRemaining < Scene.Constants.YIELD_ZONE_FAR && bumperRemaining > -1) {
        target = 0;
      }
    }
    return {
      throttle: sim.speed < target - 0.2,
      brake: sim.speed > target + 0.2,
      left: false,
      right: false
    };
  }

  // 只比建议速度略快，因而不拿提前控速分；不横移，并在真实冲突前停车让行。
  function lateInput(sim) {
    const event = sim.currentEvent;
    let target = 47;
    if (event) {
      const remaining = event.position - sim.distance;
      if (remaining <= event.approachStart && sim.distance <= event.position + Scene.Constants.RISK_END) {
        target = Scene.Scoring.targetSpeed(sim, event) + 4;
      }
      const bumperRemaining = event.position - (sim.distance + Scene.Constants.CAR_LENGTH_M / 2);
      if (event.actor.visible && Scene.actorBlocking(sim, event) &&
        bumperRemaining < Scene.Constants.YIELD_ZONE_FAR && bumperRemaining > -1) {
        target = 0;
      }
    }
    return {
      throttle: sim.speed < target - 0.35,
      brake: sim.speed > target + 0.35,
      left: false,
      right: false
    };
  }

  function layoutFingerprint(plan) {
    return JSON.stringify(plan.events.map(function (event) {
      return {
        id: event.id,
        position: event.position,
        direction: event.direction,
        exitSide: event.exitSide,
        kind: event.kind,
        occupied: event.occupied,
        startX: event.startX,
        clearX: event.clearX,
        maxSpeed: event.maxSpeed,
        initialSpeed: event.initialSpeed,
        acceleration: event.acceleration,
        occluders: event.occluders.map(function (rect) {
          return {
            id: rect.id,
            type: rect.type,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            top: rect.top
          };
        })
      };
    }));
  }

  function appearanceFingerprint(plan) {
    return JSON.stringify(plan.events.map(function (event) {
      return {
        coatColor: event.coatColor,
        skinColor: event.skinColor,
        bikeColor: event.bikeColor,
        occluderColor: event.occluders[0].color
      };
    }));
  }

  function prepareStoppedEvent(seed, kind) {
    const sim = new Scene.Simulation(seed);
    const event = sim.events.find(function (item) { return item.kind === kind; });
    assert(event, '种子 ' + seed + ' 应包含 ' + kind);
    sim.events.slice(0, event.id).forEach(function (item) { item.resolved = true; });
    sim.start();
    sim.distance = Math.max(0, event.position - 30);
    sim.speed = 0;
    sim.previousSpeed = 0;
    event.actor = {
      state: 'crossing',
      active: true,
      x: event.startX,
      y: event.position,
      speed: event.initialSpeed,
      visible: false,
      cleared: false,
      occluderId: null
    };
    return { sim: sim, event: event };
  }

  function actualOverlap(sim, event) {
    const actorHalfWidth = event.kind === 'ebike' ? 7 : 3;
    const actor = event.actor;
    const horizontal = actor.x + actorHalfWidth > sim.x - 14 &&
      actor.x - actorHalfWidth < sim.x + 14;
    const vertical = event.position < sim.distance + 2.05 &&
      event.position > sim.distance - 2.05;
    return horizontal && vertical;
  }

  function demoSnapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      distance: sim.distance,
      speed: sim.speed,
      previousSpeed: sim.previousSpeed,
      acceleration: sim.acceleration,
      lastDeceleration: sim.lastDeceleration,
      x: sim.x,
      elapsed: sim.elapsed,
      necessaryBraking: sim.necessaryBraking,
      scoring: sim.scoring,
      events: sim.events.map(function (event) {
        return {
          resolved: event.resolved,
          failed: event.failed,
          attempts: event.attempts,
          recordedDecision: event.recordedDecision,
          recordedLate: event.recordedLate,
          speedAtDecision: event.speedAtDecision,
          speedAtLate: event.speedAtLate,
          referenceSafeSpeed: event.referenceSafeSpeed,
          maxSpeedAfterDecision: event.maxSpeedAfterDecision,
          minSpeedInRisk: event.minSpeedInRisk,
          maxLateralShift: event.maxLateralShift,
          lateralTime: event.lateralTime,
          earlySlow: event.earlySlow,
          lateSlow: event.lateSlow,
          earlyLateral: event.earlyLateral,
          firstVisibleDistance: event.firstVisibleDistance,
          firstVisibleSpeed: event.firstVisibleSpeed,
          firstVisibleActorSpeed: event.firstVisibleActorSpeed,
          actor: event.actor
        };
      })
    });
  }

  function runTests() {
    const results = [];
    function test(name, fn) {
      try {
        fn();
        results.push({ name: '[06] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[06] ' + name, passed: false, error: error.message });
      }
    }

    test('06 种子复现，每局三类事件、左右出口和三种遮挡模板', function () {
      const occluderTypes = {};
      ['same-seed', 0, 37, 'junction-layout'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '种子 ' + seed + ' 的完整计划应复现');
        assert(a.events.length === 3, '每局应有三个巷口');
        ['empty', 'pedestrian', 'ebike'].forEach(function (kind) {
          assert(a.events.filter(function (event) { return event.kind === kind; }).length === 1,
            '种子 ' + seed + ' 应恰好有一个 ' + kind);
        });
        assert(a.events.some(function (event) { return event.exitSide === 'left'; }) &&
          a.events.some(function (event) { return event.exitSide === 'right'; }),
        '种子 ' + seed + ' 应同时包含左右出口');
      });
      for (let seed = 0; seed < 200; seed += 1) {
        const plan = Scene.createPlan('junction-occluders-' + seed);
        plan.events.forEach(function (event) {
          assert(event.occluders.length === 1, '每个巷口应有一个真实遮挡矩形');
          const type = event.occluders[0].type;
          assert(type === 'wall' || type === 'hedge' || type === 'truck', '未知遮挡类型 ' + type);
          occluderTypes[type] = true;
        });
      }
      assert(occluderTypes.wall && occluderTypes.hedge && occluderTypes.truck,
        '种子集合应覆盖围墙、绿篱和货车三类遮挡');
    });

    test('06 外观使用独立随机流，不改变布局、对象或运动参数', function () {
      const seed = 'junction-independent-paint';
      const original = Scene.createPlan(seed);
      const originalRandom = Game.Model.mulberry32;
      const paintSeed = Game.Model.hashSeed('junction-paint:' + seed);
      const layouts = [layoutFingerprint(original)];
      const appearances = [appearanceFingerprint(original)];
      try {
        [0, 0.999999999].forEach(function (paintValue) {
          Game.Model.mulberry32 = function (randomSeed) {
            if (randomSeed === paintSeed) return function () { return paintValue; };
            return originalRandom(randomSeed);
          };
          const changedPaint = Scene.createPlan(seed);
          layouts.push(layoutFingerprint(changedPaint));
          appearances.push(appearanceFingerprint(changedPaint));
        });
      } finally {
        Game.Model.mulberry32 = originalRandom;
      }
      assert(layouts[0] === layouts[1] && layouts[1] === layouts[2],
        '外观随机流不应消费或改变布局随机流');
      assert(appearances[0] !== appearances[1] && appearances[1] !== appearances[2],
        '改变外观随机流应实际改变涂装和人物外观');
    });

    test('06 segment/AABB 覆盖遮挡、平行、端点和近 miss', function () {
      const hit = Scene.Geometry.segmentIntersectsAABB;
      const rect = { left: 4, right: 6, bottom: 4, top: 6 };
      assert(hit({ x: 0, y: 0 }, { x: 10, y: 10 }, rect), '对角线穿过矩形应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 0, y: 10 }, rect), '平行且在矩形外不应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 3, y: 3 }, rect), '矩形在线段后方不应相交');
      assert(hit({ x: 0, y: 0 }, { x: 10, y: 10 },
        { left: 9, right: 11, bottom: 9, top: 11 }), '矩形覆盖线段端点应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 10, y: 10 },
        { left: 6.1, right: 7, bottom: 0, top: 4 }), '擦边近 miss 不应相交');
      assert(hit({ x: 5, y: 5 }, { x: 5, y: 5 }, rect), '矩形内部零长线段应相交');
      assert(hit({ x: 0, y: 5 }, { x: 10, y: 5 }, rect), '水平穿过矩形应相交');
      assert(hit({ x: 4, y: 0 }, { x: 4, y: 10 }, rect), '沿矩形边界应视为相交');
    });

    test('06 左右出口提前 beneficial 选位提高首次可见距离，反向不更优', function () {
      for (let seed = 0; seed < 80; seed += 1) {
        const sim = new Scene.Simulation('junction-visibility-' + seed);
        sim.events.forEach(function (event) {
          const start = event.position - 90;
          const center = Scene.Geometry.firstVisibleDistanceFor(event, Game.C.CAR_X, start);
          const beneficialX = Game.C.CAR_X + event.direction * 22;
          const reverseX = Game.C.CAR_X - event.direction * 22;
          const beneficial = Scene.Geometry.firstVisibleDistanceFor(event, beneficialX, start);
          const reverse = Scene.Geometry.firstVisibleDistanceFor(event, reverseX, start);
          assert(beneficial > center, '种子 ' + seed + '、事件 ' + event.id +
            ' beneficial 选位应提高首次可见距离：' + beneficial + ' <= ' + center);
          assert(reverse <= center + 0.000001, '种子 ' + seed + '、事件 ' + event.id +
            ' 反向选位不应更优');
          assert(Scene.Geometry.safeSpeedFor(event, beneficialX) >=
            Scene.Geometry.safeSpeedFor(event, reverseX) - 0.000001,
          '更好的视野不应得到更低的建议速度');
        });
      }
    });

    test('06 reveal 前 HUD 与建议速度不读取 kind/occupied，无人无隐藏碰撞', function () {
      for (let seed = 0; seed < 30; seed += 1) {
        const baseline = new Scene.Simulation('junction-hidden-' + seed);
        const changed = new Scene.Simulation('junction-hidden-' + seed);
        const id = seed % 3;
        baseline.events.slice(0, id).forEach(function (event) { event.resolved = true; });
        changed.events.slice(0, id).forEach(function (event) { event.resolved = true; });
        const a = baseline.events[id];
        const b = changed.events[id];
        [baseline, changed].forEach(function (sim) {
          sim.start();
          sim.distance = sim.events[id].position - sim.events[id].slowCheck + 1;
          sim.speed = 30;
          sim.previousSpeed = 30;
        });
        b.kind = a.kind === 'ebike' ? 'pedestrian' : 'ebike';
        b.occupied = !a.occupied;
        [a, b].forEach(function (event) {
          event.actor = {
            state: event.occupied ? 'waiting' : 'empty',
            active: false,
            x: event.startX,
            y: event.position,
            speed: event.initialSpeed,
            visible: false,
            cleared: false,
            occluderId: null
          };
        });
        assert(JSON.stringify(Scene.ui.coach(baseline, 30)) === JSON.stringify(Scene.ui.coach(changed, 30)),
          '种子 ' + seed + ' reveal 前 HUD 不应泄露对象类型或是否有人');
        assert(Scene.Scoring.targetSpeed(baseline, a) === Scene.Scoring.targetSpeed(changed, b),
          '种子 ' + seed + ' reveal 前建议速度不应读取 kind/occupied');
      }

      for (let seed = 0; seed < 40; seed += 1) {
        const sim = run('junction-empty-' + seed, Scene.defensiveInput);
        sim.events.filter(function (event) { return !event.occupied; }).forEach(function (event) {
          assert(event.resolved && !event.failed, '种子 ' + seed + ' 无人巷口不应隐藏失败');
          assert(event.actor.state === 'empty' && !event.actor.active && !event.actor.visible,
            '无人巷口不应暗中生成或显示对象');
          assert(event.firstVisibleDistance == null, '无人巷口不应记录虚假 reveal');
          assert(event.earlySlow && event.earlyLateral, '无人巷口也应奖励相同防御动作');
        });
      }
    });

    test('06 防御策略 200 种子安全高分完成，所有占用事件有保守停车余量', function () {
      for (let i = 0; i < 200; i += 1) {
        const sim = run('junction-defense-' + i, Scene.defensiveInput);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'complete', '种子 ' + i + ' 应完成，实际 ' + sim.status);
        assert(!summary.failed, '种子 ' + i + ' 不应失败');
        assert(summary.total >= 85, '种子 ' + i + ' 应至少 85 分，实际 ' + summary.total);
        assert(summary.observation === 30, '种子 ' + i + ' 应拿满观察分，实际 ' + summary.observation);
        assert(summary.hardBrakes === 0, '种子 ' + i + ' 不应靠急刹完成');
        sim.events.filter(function (event) { return event.occupied; }).forEach(function (event) {
          assert(event.firstVisibleDistance != null && event.firstVisibleSpeed != null,
            '种子 ' + i + '、事件 ' + event.id + ' 有人对象应实际首次可见');
          const stoppingDistance = Game.Model.stoppingDistance(event.firstVisibleSpeed);
          assert(event.firstVisibleDistance + 0.05 >= stoppingDistance + Scene.Constants.SAFETY_BUFFER_M,
            '种子 ' + i + '、事件 ' + event.id + ' 首次可见时应保留反应、舒适制动及安全缓冲：可见 ' +
            event.firstVisibleDistance.toFixed(3) + '，制动 ' + stoppingDistance.toFixed(3));
        });
      }
    });

    test('06 持续全油与 44 km/h 居中策略均在真实 AABB 重叠前定格', function () {
      [fullThrottleInput, highSpeedInput].forEach(function (controller, strategy) {
        for (let i = 0; i < 100; i += 1) {
          const sim = run('junction-fast-' + strategy + '-' + i, controller);
          assert(sim.status === 'frozen', '策略 ' + strategy + '、种子 ' + i +
            ' 应危险定格，实际 ' + sim.status);
          const event = sim.events[sim.freezeInfo.eventId];
          assert(event.occupied && event.actor.active, '定格应来自真实激活的占用事件');
          assert(!actualOverlap(sim, event), '策略 ' + strategy + '、种子 ' + i +
            ' 定格时不应已发生实际 AABB 重叠');
          assert(event.failed && event.attempts === 1, '失败与尝试次数应被记录');
        }
      });
    });

    test('06 行人与电动车运动不同，速度范围及电动车加速正确', function () {
      for (let seed = 0; seed < 100; seed += 1) {
        const plan = Scene.createPlan('junction-motion-range-' + seed);
        const pedestrian = plan.events.find(function (event) { return event.kind === 'pedestrian'; });
        const ebike = plan.events.find(function (event) { return event.kind === 'ebike'; });
        assert(pedestrian.maxSpeed >= 1.4 && pedestrian.maxSpeed <= 2.2,
          '行人 maxSpeed 应在 1.4～2.2 m/s');
        assert(ebike.maxSpeed >= 4 && ebike.maxSpeed <= 7, '电动车 maxSpeed 应在 4～7 m/s');
        assert(pedestrian.acceleration === 0 && pedestrian.initialSpeed === pedestrian.maxSpeed,
          '行人应匀速运动');
        assert(ebike.acceleration > 0 && ebike.initialSpeed < ebike.maxSpeed,
          '电动车应从较低初速度加速');
      }

      const pedestrian = prepareStoppedEvent('junction-motion', 'pedestrian');
      const ebike = prepareStoppedEvent('junction-motion', 'ebike');
      const pedestrianStart = pedestrian.event.actor.x;
      const ebikeStart = ebike.event.actor.x;
      let expectedPedestrianX = pedestrianStart;
      let expectedEbikeX = ebikeStart;
      let expectedEbikeSpeed = ebike.event.actor.speed;
      for (let frame = 0; frame < 30; frame += 1) {
        pedestrian.sim.step({}, FIXED_STEP);
        ebike.sim.step({}, FIXED_STEP);
        expectedPedestrianX += pedestrian.event.direction * pedestrian.event.maxSpeed *
          Scene.Constants.PIXELS_PER_METER * FIXED_STEP;
        expectedEbikeSpeed = Math.min(ebike.event.maxSpeed,
          expectedEbikeSpeed + ebike.event.acceleration * FIXED_STEP);
        expectedEbikeX += ebike.event.direction * expectedEbikeSpeed *
          Scene.Constants.PIXELS_PER_METER * FIXED_STEP;
      }
      assert(pedestrian.event.actor.speed === pedestrian.event.maxSpeed, '行人运动后仍应保持步速');
      assert(ebike.event.actor.speed > ebike.event.initialSpeed &&
        ebike.event.actor.speed <= ebike.event.maxSpeed, '电动车应实际加速且不超过 maxSpeed');
      assert(Math.abs(pedestrian.event.actor.x - expectedPedestrianX) < 0.000001,
        '行人逐帧位移应使用自身匀速积分');
      assert(Math.abs(ebike.event.actor.x - expectedEbikeX) < 0.000001,
        '电动车逐帧位移应包含加速度积分');
      assert(Math.abs(ebike.event.actor.x - ebikeStart) > Math.abs(pedestrian.event.actor.x - pedestrianStart),
        '相同时间内电动车应比行人移动更快');
    });

    test('06 晚减速且不选位可安全通过，但观察分低于防御策略', function () {
      for (let seed = 0; seed < 30; seed += 1) {
        const early = run('junction-compare-' + seed, Scene.defensiveInput);
        const late = run('junction-compare-' + seed, lateInput);
        const earlyScore = Scene.Scoring.summarize(early, early.status === 'timeout');
        const lateScore = Scene.Scoring.summarize(late, late.status === 'timeout');
        assert(late.status === 'complete', '种子 ' + seed + ' 晚减速对照应安全完成，实际 ' + late.status);
        assert(earlyScore.observation > lateScore.observation, '种子 ' + seed +
          ' 晚减速/不选位观察分应低于防御：' + lateScore.observation + ' vs ' + earlyScore.observation);
        late.events.forEach(function (event) {
          assert(!event.earlySlow && event.lateSlow && !event.earlyLateral,
            '种子 ' + seed + '、事件 ' + event.id + ' 应记录晚减速且没有提前选位');
        });
      }
    });

    test('06 全程不超过 15 km/h 且必要让行应超时且总分不超过 69', function () {
      for (let i = 0; i < 50; i += 1) {
        const sim = run('junction-crawl-' + i, crawlerInput);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'timeout', '种子 junction-crawl-' + i + ' 应超时，实际 ' + sim.status +
          '，distance=' + sim.distance.toFixed(3) + '，event=' +
          (sim.freezeInfo ? sim.freezeInfo.eventId : 'none'));
        assert(summary.total <= 69, '种子 ' + i + ' 龟速不应高分，实际 ' + summary.total);
      }
    });

    test('06 必要让行效率中性，对象清空后恢复效率计时', function () {
      const sim = new Scene.Simulation('junction-yield-check');
      const event = sim.events.find(function (item) { return item.occupied; });
      sim.events.slice(0, event.id).forEach(function (item) { item.resolved = true; });
      sim.start();
      sim.distance = event.position - 10;
      sim.speed = 0;
      sim.previousSpeed = 0;
      event.actor = {
        state: 'crossing',
        active: true,
        x: sim.x + 10,
        y: event.position,
        speed: event.initialSpeed,
        visible: true,
        cleared: false,
        occluderId: null
      };
      assert(Scene.actorBlocking(sim, event), '对象应实际占用本车冲突走廊');
      assert(Scene.Scoring.isYieldExempt(sim), '必要停车让行应豁免效率计时');
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 0 && sim.scoring.efficiencyIntegral === 0,
        '必要等待不应计入效率分子或分母');
      event.actor.state = 'cleared';
      event.actor.active = false;
      event.actor.cleared = true;
      event.actor.visible = false;
      event.actor.occluderId = null;
      assert(!Scene.Scoring.isYieldExempt(sim), '对象清空后不应继续豁免');
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 1, '清空后继续停车应恢复效率计时');
    });

    test('06 重试保留失败、attempts 和 plan，回当前事件接近段且封顶 59', function () {
      const sim = run('junction-retry', highSpeedInput);
      assert(sim.status === 'frozen', '应先发生失败');
      const failedId = sim.freezeInfo.eventId;
      const event = sim.events[failedId];
      const layout = JSON.stringify(sim.plan);
      sim.retryEvent();
      assert(sim.status === 'driving', '重试后应恢复驾驶');
      assert(event.failed && event.attempts === 1, '重试不应洗掉 failed/attempts');
      assert(JSON.stringify(sim.plan) === layout, '重试不应重新随机 plan');
      assert(sim.distance === Math.max(0, event.position - event.approachStart),
        '应回到当前 event.position-event.approachStart');
      assert(sim.currentEvent === event && !event.resolved, '应重试当前失败事件');
      let guard = 0;
      while (sim.status === 'driving' && guard < 12000) {
        sim.step(Scene.defensiveInput(sim), FIXED_STEP);
        guard += 1;
      }
      assert(sim.status === 'complete', '重试后防御驾驶应能完成，实际 ' + sim.status);
      const summary = Scene.Scoring.summarize(sim, false);
      assert(summary.failed, '结算应保留首次失败');
      assert(summary.total <= 59, '失败后总分应封顶 59，实际 ' + summary.total);
    });

    test('06 示范与独立 expected 真实 Simulation 逐帧一致并回到原事件', function () {
      const sim = run('junction-demo', highSpeedInput);
      assert(sim.status === 'frozen', '应先发生失败');
      const failedId = sim.freezeInfo.eventId;
      const layout = JSON.stringify(sim.plan);
      sim.startDemo();
      assert(sim.status === 'demonstrating' && sim.demo, '应进入隔离示范');
      const expected = new Scene.Simulation(sim.seed);
      for (let i = 0; i < failedId; i += 1) {
        expected.events[i].resolved = true;
        expected.events[i].earlySlow = true;
        expected.events[i].earlyLateral = true;
      }
      expected.distance = Math.max(0, expected.events[failedId].position - expected.events[failedId].approachStart);
      expected.speed = 45;
      expected.previousSpeed = 45;
      expected.start();
      let frames = 0;
      while (sim.status === 'demonstrating' && frames < 2000) {
        const actualDemo = sim.demo;
        sim.stepDemo(FIXED_STEP);
        expected.step(Scene.defensiveInput(expected), FIXED_STEP);
        assert(demoSnapshot(actualDemo) === demoSnapshot(expected),
          '示范第 ' + frames + ' 帧应与独立真实 Simulation 完全一致');
        frames += 1;
      }
      assert(frames > 0 && frames < 2000, '示范应在有限帧内结束');
      assert(sim.status === 'driving' && sim.demo === null, '示范结束后应回到可重试驾驶');
      assert(sim.currentEvent && sim.currentEvent.id === failedId, '示范结束后应返回原失败事件');
      assert(sim.distance === Math.max(0, sim.events[failedId].position - sim.events[failedId].approachStart),
        '示范结束应回到原事件接近段');
      assert(sim.events[failedId].failed && sim.events[failedId].attempts === 1,
        '示范不应洗掉失败或 attempts');
      assert(JSON.stringify(sim.plan) === layout, '示范不应改变正式 plan');
    });

    test('06 30/60/120Hz 固定步长结果一致', function () {
      const summaries = [30, 60, 120].map(function (hz) {
        const sim = run('junction-hz', Scene.defensiveInput, hz);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        return sim.status + ':' + summary.total + ':' + summary.hardBrakes + ':' + summary.observation;
      });
      assert(summaries[0] === summaries[1] && summaries[1] === summaries[2],
        '帧率不应改变结果：' + summaries.join(' / '));
    });

    test('06 所有 blindJunction 中英文 key 成对可翻译且不含公交专属措辞', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      const keys = Object.keys(zh).concat(Object.keys(en)).filter(function (key, index, all) {
        return key.indexOf('scene.blindJunction.') === 0 && all.indexOf(key) === index;
      });
      assert(keys.length > 0, '应存在 blindJunction 场景文案');
      const originalLanguage = Game.I18N.getLanguage();
      try {
        keys.forEach(function (key) {
          assert(Object.prototype.hasOwnProperty.call(zh, key), '中文缺少 key ' + key);
          assert(Object.prototype.hasOwnProperty.call(en, key), '英文缺少 key ' + key);
          ['zh-CN', 'en'].forEach(function (lang) {
            Game.I18N.setLanguage(lang);
            const text = Game.I18N.t(key, { resolved: 3, speed: 20, score: 10, roadUser: 'road user' });
            assert(text && text !== key, lang + ' 不能翻译 ' + key);
            assert(!/公交|巴士|\bbus(?:es)?\b/i.test(text), lang + ' 巷口文案混入公交措辞：' + key);
          });
        });
      } finally {
        Game.I18N.setLanguage(originalLanguage);
      }
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.BlindJunctionTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
