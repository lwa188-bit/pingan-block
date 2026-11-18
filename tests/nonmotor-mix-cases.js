(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['nonmotor-mix'];
  const FIXED_STEP = 1 / 60;

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
      while (accumulator >= FIXED_STEP && sim.status === 'driving') {
        sim.step(controller(sim), FIXED_STEP);
        accumulator -= FIXED_STEP;
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

  function crawlerInput(sim) {
    const input = Scene.defensiveInput(sim);
    input.throttle = sim.speed < 15;
    input.brake = sim.speed > 15.4;
    return input;
  }

  function useEvent(sim, eventId) {
    sim.events.forEach(function (event, index) {
      event.resolved = index < eventId;
    });
    const event = sim.events[eventId];
    sim.distance = Math.max(0, event.position - Scene.Constants.APPROACH_START);
    sim.speed = 40;
    sim.previousSpeed = 40;
    sim.status = 'driving';
    return event;
  }

  function eventIdFor(seed, behavior) {
    const plan = new Scene.Simulation(seed);
    return plan.events.findIndex(function (event) { return event.behavior === behavior; });
  }

  function planFingerprint(sim) {
    return JSON.stringify(sim.plan);
  }

  function actualOverlap(sim, event) {
    const rider = event.rider;
    if (!rider.active || rider.cleared || rider.routeClear) return false;
    return Math.abs(rider.x - sim.x) < Scene.Constants.CONTACT_HALF_WIDTH &&
      Math.abs(rider.position - sim.distance) < Scene.Constants.CAR_LENGTH_M / 2 + Scene.Constants.BIKE_HALF_LENGTH;
  }

  function demoSnapshot(sim) {
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
          speedAtApproach: event.speedAtApproach,
          speedAtSlow: event.speedAtSlow,
          maxSpeedAfterSlow: event.maxSpeedAfterSlow,
          earlyControlTime: event.earlyControlTime,
          correctSpaceTime: event.correctSpaceTime,
          minFollowingGap: event.minFollowingGap,
          maxHorizontalSeparation: event.maxHorizontalSeparation,
          closePass: event.closePass,
          rider: event.rider
        };
      })
    });
  }

  function lateInput(sim) {
    const event = sim.currentEvent;
    if (!event) return { throttle: sim.speed < 47 };
    const remaining = event.position - sim.distance;
    let target = remaining < 28 ? 18 : 47;
    let targetX = Scene.Constants.CAR_X;
    if (event.behavior === 'wrong-way' && event.rider.active) {
      targetX = event.rider.x >= Scene.Constants.CAR_X ? Scene.Constants.CAR_MIN_X : Scene.Constants.CAR_MAX_X;
    }
    if (event.behavior === 'diagonal' && Scene.riderRequired(event) && remaining < 12) target = 0;
    return {
      throttle: sim.speed < target - 0.4,
      brake: sim.speed > target + 0.4,
      left: sim.x > targetX + 0.5,
      right: sim.x < targetX - 0.5
    };
  }

  function runTests() {
    const results = [];
    function test(name, fn) {
      try {
        fn();
        results.push({ name: '[10] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[10] ' + name, passed: false, error: error.message });
      }
    }

    test('10 每局逆行、绕障、斜穿各一次，种子完整复现', function () {
      ['same-seed', 0, 37, 'nonmotor-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(planFingerprint(a) === planFingerprint(b), '种子 ' + seed + ' 的完整计划应复现');
        assert(a.events.length === 3, '每局应有三组事件');
        ['wrong-way', 'swerve', 'diagonal'].forEach(function (behavior) {
          assert(a.events.filter(function (event) { return event.behavior === behavior; }).length === 1,
            '种子 ' + seed + ' 应恰好有一个 ' + behavior);
        });
      });
    });

    test('10 逆行使用双方速度之和，实际位置按相向运动连续变化', function () {
      const id = eventIdFor('closing-speed', 'wrong-way');
      const sim = new Scene.Simulation('closing-speed');
      const event = useEvent(sim, id);
      sim.distance = event.position - Scene.Constants.EVENT_ACTIVATE + 0.01;
      sim.speed = 40;
      sim.step({}, FIXED_STEP);
      const before = event.rider.position - sim.distance;
      const riderBefore = event.rider.position;
      const distanceBefore = sim.distance;
      for (let frame = 0; frame < 60; frame += 1) sim.step({ brake: sim.speed > 40, throttle: sim.speed < 40 }, FIXED_STEP);
      const riderTravel = riderBefore - event.rider.position;
      const carTravel = sim.distance - distanceBefore;
      const closure = before - (event.rider.position - sim.distance);
      assert(event.rider.direction === -1 && event.rider.position < riderBefore, '骑行者必须向玩家方向运动');
      assert(Math.abs(riderTravel - event.rider.speed) < 0.15, '骑行者一秒位移应由自身速度决定');
      assert(Math.abs(closure - (riderTravel + carTravel)) < 0.001, '距离缩短必须等于双方位移之和');
      const times = Scene.estimateConflictTimes(sim, event);
      const expectedRelative = sim.speed / 3.6 + event.rider.speed;
      assert(Math.abs(times.rider - Math.max(0, event.rider.position - sim.distance) / expectedRelative) < 0.0001,
        '冲突时间应使用双方相对速度');
    });

    test('10 绕障有提前可见障碍、先减速和连续横向轨迹', function () {
      const id = eventIdFor('swerve-process', 'swerve');
      const sim = new Scene.Simulation('swerve-process');
      const event = useEvent(sim, id);
      assert(event.obstaclePosition > event.rider.position + 20, '障碍必须位于骑行者前方且提前可见');
      sim.distance = event.position - Scene.Constants.EVENT_ACTIVATE + 0.01;
      sim.speed = 0;
      sim.previousSpeed = 0;
      const states = {};
      let previousX = event.rider.x;
      let maxStep = 0;
      let lateralTravel = 0;
      let slowed = false;
      for (let frame = 0; frame < 1600 && !event.rider.routeClear; frame += 1) {
        const speedBefore = event.rider.speed;
        sim.step({}, FIXED_STEP);
        states[event.rider.state] = true;
        const delta = Math.abs(event.rider.x - previousX);
        maxStep = Math.max(maxStep, delta);
        lateralTravel += delta;
        previousX = event.rider.x;
        if (event.rider.state === 'slowing' && event.rider.speed < speedBefore) slowed = true;
      }
      assert(states.approach && states.slowing && states.swerving && states.returning && states.clearing,
        '绕障必须包含接近、减速、连续变道、返回和离开通道');
      assert(slowed, '变道前必须有真实减速过程');
      assert(lateralTravel > 55 && maxStep < 0.4, '横向轨迹必须连续，不能瞬移');
      assert(event.rider.routeClear, '绕过障碍后应离开玩家通道');
    });

    test('10 斜穿从真实路侧进入，并分别计算双方到达时序', function () {
      ['diagonal-a', 'diagonal-b'].forEach(function (seed) {
        const id = eventIdFor(seed, 'diagonal');
        const sim = new Scene.Simulation(seed);
        const event = useEvent(sim, id);
        const startX = event.rider.x;
        assert(startX === 64 || startX === 314, '斜穿必须从路缘或巷口开始');
        sim.distance = event.position - Scene.Constants.EVENT_ACTIVATE + 0.01;
        sim.speed = 36;
        sim.step({}, FIXED_STEP);
        const times = Scene.estimateConflictTimes(sim, event);
        const nearX = event.rider.direction > 0 ? Scene.Constants.CAR_X - 20 : Scene.Constants.CAR_X + 20;
        const expectedRider = Math.max(0, (nearX - event.rider.x) * event.rider.direction / event.rider.speed);
        assert(Math.abs(times.rider - expectedRider) < 0.0001, '骑行者到达时间应由横向路线和速度计算');
        assert(Number.isFinite(times.car) && Number.isFinite(times.clear), '汽车到达与骑行者清空时间应分别存在');
        const worldBefore = event.rider.position;
        for (let frame = 0; frame < 500 && !event.rider.routeClear; frame += 1) sim.step({}, FIXED_STEP);
        assert(event.rider.position < worldBefore && event.rider.x !== startX, '斜穿必须同时具有横向和纵向位移');
        assert(event.rider.routeClear, '离开本车道后应判定路线清空，而非要求走出整个世界');
      });
    });

    test('10 行为计划不随玩家输入或语言改变', function () {
      const a = new Scene.Simulation('input-independent');
      const b = new Scene.Simulation('input-independent');
      Game.I18N.setLanguage('en');
      const eventA = useEvent(a, 0);
      const eventB = useEvent(b, 0);
      a.distance = b.distance = eventA.position - Scene.Constants.EVENT_ACTIVATE + 0.01;
      a.speed = b.speed = 0;
      a.previousSpeed = b.previousSpeed = 0;
      for (let frame = 0; frame < 500; frame += 1) {
        a.step({ throttle: frame % 2 === 0 }, FIXED_STEP);
        b.step({ brake: true }, FIXED_STEP);
        a.distance = b.distance = eventA.position - Scene.Constants.EVENT_ACTIVATE + 0.01;
        a.speed = b.speed = 0;
        a.previousSpeed = b.previousSpeed = 0;
      }
      assert(JSON.stringify(eventA.rider) === JSON.stringify(eventB.rider), '骑行者状态不应读取油门或制动');
      Game.I18N.setLanguage('zh-CN');
      assert(planFingerprint(a) === planFingerprint(b), '语言不得改变计划');
    });

    test('10 200 个种子防御策略安全完成、观察满分且无急刹', function () {
      for (let seed = 0; seed < 200; seed += 1) {
        const sim = run('nonmotor-defensive-' + seed, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'complete', '种子 ' + seed + ' 应安全完成，实际 ' + sim.status);
        assert(result.observation === 30, '种子 ' + seed + ' 观察应满分，实际 ' + result.observation);
        assert(result.total >= 85, '种子 ' + seed + ' 应获高评价，实际 ' + result.total);
        assert(result.hardBrakes === 0, '种子 ' + seed + ' 正确策略不应依赖急刹');
        assert(sim.elapsed < 85, '种子 ' + seed + ' 防御驾驶不应龟速超时');
        assert(sim.events.every(function (event) { return event.resolved; }), '终点前必须结算全部三类事件');
      }
    });

    test('10 持续高速在真实接触前定格，不展示已经重叠的画面', function () {
      for (let seed = 0; seed < 100; seed += 1) {
        const sim = run('nonmotor-fast-' + seed, fullThrottleInput);
        assert(sim.status === 'frozen', '种子 ' + seed + ' 持续高速应在接触前定格');
        const event = sim.events[sim.freezeInfo.eventId];
        assert(!actualOverlap(sim, event), '种子 ' + seed + ' 定格时不应已经接触');
        assert(sim.freezeInfo.remaining >= 0, '剩余距离不得为负');
      }
    });

    test('10 三类事件充分制动都不提前误罚', function () {
      ['wrong-way', 'swerve', 'diagonal'].forEach(function (behavior) {
        const id = eventIdFor('full-brake-' + behavior, behavior);
        const sim = new Scene.Simulation('full-brake-' + behavior);
        const event = useEvent(sim, id);
        sim.distance = event.position - 30;
        sim.speed = 40;
        sim.previousSpeed = 40;
        event.rider.active = true;
        if (behavior === 'wrong-way') {
          event.rider.position = sim.distance + 27;
          // 充分制动可让车辆停下；横向也留出通道，避免静止车辆挡住继续靠近的骑行者。
          event.rider.x = sim.x + 24;
        } else if (behavior === 'swerve') {
          event.rider.position = sim.distance + 25;
          event.rider.x = sim.x;
        } else {
          event.rider.position = event.position + 2;
          event.rider.x = sim.x + 35;
        }
        for (let frame = 0; frame < 600 && sim.status === 'driving' && !event.resolved; frame += 1) {
          sim.step({ brake: true }, FIXED_STEP);
        }
        assert(sim.status !== 'frozen', behavior + ' 充分制动能停车时不应提前判罚');
        assert(!actualOverlap(sim, event), behavior + ' 制动测试不应发生真实重叠');
      });
    });

    test('10 低速无接触危险近距通过不伪造碰撞但降分', function () {
      const id = eventIdFor('close-pass', 'wrong-way');
      const sim = new Scene.Simulation('close-pass');
      const event = useEvent(sim, id);
      sim.speed = 10;
      sim.previousSpeed = 10;
      event.rider.active = true;
      event.rider.x = sim.x + 20;
      event.rider.position = sim.distance + 2.5;
      sim.step({ brake: true }, FIXED_STEP);
      assert(sim.status !== 'frozen', '20 像素横向间隔不应伪造碰撞');
      assert(event.closePass, '低于安全横向余量的近距通过应被记录');
      event.rider.routeClear = true;
      event.rider.cleared = true;
      sim.resolveEvent(event);
      assert(!Scene.Scoring.eventSafe(event), '危险近距通过不能获得安全分');
      assert(Scene.Scoring.eventObservation(event) < 10, '危险近距通过不能获得观察满分');
    });

    test('10 全程蠕行与原地不动都会超时且不超过 69 分', function () {
      for (let seed = 0; seed < 30; seed += 1) {
        const sim = run('nonmotor-crawler-' + seed, crawlerInput);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'timeout', '种子 ' + seed + ' 全程 15 km/h 应超时');
        assert(result.total <= 69, '种子 ' + seed + ' 龟速不应获得高分');
      }
      // 选取首个事件不是逆行的种子，测试车辆自身不操作，而非静止车辆被逆行骑行者撞上。
      let stoppedSeed = 'nonmotor-stopped-0';
      for (let seed = 0; new Scene.Simulation(stoppedSeed).events[0].behavior === 'wrong-way'; seed += 1) {
        stoppedSeed = 'nonmotor-stopped-' + (seed + 1);
      }
      const stopped = run(stoppedSeed, function () { return {}; });
      assert(stopped.status === 'timeout', '全程不动也必须超时');
      assert(Scene.Scoring.summarize(stopped, true).total <= 69, '不动不能获得高分');
    });

    test('10 必要停车效率中性，远离事件和清空后停车仍计时', function () {
      const id = eventIdFor('yield-efficiency', 'diagonal');
      const sim = new Scene.Simulation('yield-efficiency');
      const event = useEvent(sim, id);
      sim.distance = event.position - 11;
      sim.speed = 0;
      sim.previousSpeed = 0;
      event.rider.active = true;
      event.rider.state = 'crossing';
      event.rider.x = Scene.Constants.CAR_X;
      for (let frame = 0; frame < 30 && !event.rider.routeClear; frame += 1) sim.step({}, FIXED_STEP);
      assert(Scene.Scoring.isYieldExempt(sim), '冲突区前必要停车应豁免效率');
      assert(sim.scoring.efficiencyTime === 0, '必要等待不应增加效率分母');
      event.rider.routeClear = true;
      sim.step({}, FIXED_STEP);
      assert(!Scene.Scoring.isYieldExempt(sim), '清空后继续停车不应豁免');
      assert(sim.scoring.efficiencyTime > 0, '清空后停车应恢复效率计时');

      const far = new Scene.Simulation('far-stop');
      const farEvent = useEvent(far, 0);
      far.distance = farEvent.position - 45;
      far.speed = 0;
      farEvent.rider.active = true;
      assert(!Scene.Scoring.isYieldExempt(far), '远离冲突区停车不算必要让行');
    });

    test('10 临近才减速比提前识别与渐进控速评价更低', function () {
      const early = run('nonmotor-late-comparison', Scene.defensiveInput);
      const late = run('nonmotor-late-comparison', lateInput);
      const earlyResult = Scene.Scoring.summarize(early, early.status === 'timeout');
      const lateResult = Scene.Scoring.summarize(late, late.status === 'timeout');
      assert(lateResult.observation < earlyResult.observation,
        '晚减速观察分应更低：' + lateResult.observation + ' / ' + earlyResult.observation);
      assert(lateResult.total < earlyResult.total, '晚减速总分应更低');
    });

    test('10 固定靠左或靠右都不能成为通用最优策略', function () {
      ['left', 'right'].forEach(function (side) {
        let failuresOrLowScores = 0;
        for (let seed = 0; seed < 30; seed += 1) {
          const sim = run('fixed-' + side + '-' + seed, function (current) {
            const input = Scene.defensiveInput(current);
            input.left = side === 'left' && current.x > Scene.Constants.CAR_MIN_X;
            input.right = side === 'right' && current.x < Scene.Constants.CAR_MAX_X;
            return input;
          });
          const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
          if (sim.status !== 'complete' || result.total < 85 || result.observation < 30) failuresOrLowScores += 1;
        }
        assert(failuresOrLowScores > 0, '固定' + side + '不应在全部种子上通用满分');
      });
    });

    test('10 反复猛打方向扣平稳分，正常单次选位不扣', function () {
      const sim = new Scene.Simulation('sharp-steering');
      sim.start();
      sim.events.forEach(function (event) { event.resolved = true; });
      sim.speed = 35;
      for (let frame = 0; frame < 360; frame += 1) {
        const phase = Math.floor(frame / 24) % 2;
        sim.speed = 35;
        sim.step(phase ? { left: true } : { right: true }, FIXED_STEP);
      }
      assert(sim.scoring.sharpSteers > 0, '短时间反复反向应记为猛打方向');
      assert(Scene.Scoring.smoothScore(sim.scoring) < 10, '猛打方向应降低平稳分');
      const normal = run('nonmotor-normal-steering', Scene.defensiveInput);
      assert(normal.scoring.sharpSteers === 0, '按事件进行一次合理选位不应被罚');
    });

    test('10 重试保留种子和首次失败，已通过事件不重复结算', function () {
      const sim = run('nonmotor-retry', fullThrottleInput);
      const id = sim.freezeInfo.eventId;
      const plan = planFingerprint(sim);
      const passed = sim.events.filter(function (event) { return event.resolved; }).length;
      sim.retryEvent();
      assert(sim.status === 'driving' && sim.events[id].failed, '重试应保留首次失败');
      assert(planFingerprint(sim) === plan, '重试不得重新随机');
      assert(sim.events.filter(function (event) { return event.resolved; }).length === passed,
        '重试不得重置已通过事件或重复结算');
      run(null, Scene.defensiveInput, null, sim);
      const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
      assert(result.total <= 59, '首次失败后重试总分应封顶 59');
    });

    test('10 三类事件示范都调用同一个真实 Simulation', function () {
      ['wrong-way', 'swerve', 'diagonal'].forEach(function (behavior) {
        const seed = 'demo-' + behavior;
        const eventId = eventIdFor(seed, behavior);
        const official = new Scene.Simulation(seed);
        useEvent(official, eventId);
        official.status = 'frozen';
        official.freezeInfo = { eventId: eventId };
        official.events[eventId].failed = true;
        official.events[eventId].attempts = 1;
        official.startDemo();
        const expected = official.makeDemo(eventId);

        let frames = 0;
        while (official.status === 'demonstrating' && frames < 2200) {
          official.stepDemo(FIXED_STEP);
          expected.step(Scene.defensiveInput(expected), FIXED_STEP);
          if (official.status === 'demonstrating') {
            assert(demoSnapshot(official.demo) === demoSnapshot(expected),
              behavior + ' 第 ' + frames + ' 帧示范与正式模拟不一致');
          }
          frames += 1;
        }
        assert(official.status === 'driving' && frames < 2200, behavior + ' 示范应完成并回到正式重试');
        assert(official.events[eventId].failed, '示范不得洗掉首次失败');
        assert(official.scoring.efficiencyTime === 0, '示范不得修改正式评分');
      });
    });

    test('10 双方视角复盘复用真实事件且不修改正式成绩', function () {
      const sim = run('nonmotor-replay', fullThrottleInput);
      const before = JSON.stringify({ scoring: sim.scoring, events: sim.events, freezeInfo: sim.freezeInfo });
      sim.startPedestrianReplay();
      assert(sim.status === 'demonstrating' && sim.demoMode === 'rider', '应进入骑行者与驾驶员双方复盘');
      assert(sim.demo instanceof Scene.Simulation, '复盘必须使用真实 Simulation');
      const caption = Scene.ui.demoCaption(sim);
      assert(caption.step && caption.substep, '复盘应有中性说明');
      let frames = 0;
      while (sim.status === 'demonstrating' && frames < 2200) {
        sim.stepDemo(FIXED_STEP);
        frames += 1;
      }
      assert(sim.status === 'frozen' && frames < 2200, '复盘结束应返回原失败画面');
      assert(JSON.stringify({ scoring: sim.scoring, events: sim.events, freezeInfo: sim.freezeInfo }) === before,
        '复盘不得修改正式事件、失败或评分');
    });

    test('10 30 / 60 / 120Hz 固定步长结果一致', function () {
      const summaries = [30, 60, 120].map(function (hz) {
        const sim = run('nonmotor-hz', Scene.defensiveInput, hz);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        return [sim.status, result.total, result.observation, result.efficiency, result.smooth,
          sim.events.map(function (event) { return event.rider.state; }).join(',')].join(':');
      });
      assert(summaries[0] === summaries[1] && summaries[1] === summaries[2],
        '帧率不应改变结果：' + summaries.join(' / '));
    });

    test('10 Renderer 可绘制三类轨迹、障碍、定格、示范与复盘', function () {
      const noop = function () {};
      const ctx = {
        clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
        stroke: noop, setLineDash: noop, save: noop, restore: noop,
        measureText: function (text) { return { width: String(text).length * 7 }; },
        fillText: function (text, x, y) {
          assert(Number.isFinite(x) && Number.isFinite(y), '文字坐标必须有限');
          assert(String(text).indexOf('scene.nonmotor.') !== 0, '画面不得显示缺失文案键');
        }
      };
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        const sim = new Scene.Simulation('nonmotor-render');
        Scene.Renderer.render(ctx, sim);
        sim.start();
        sim.distance = sim.events[0].position - 60;
        sim.step({}, FIXED_STEP);
        Scene.Renderer.render(ctx, sim);
        sim.status = 'frozen';
        sim.freezeInfo = { eventId: 0, behavior: sim.events[0].behavior };
        Scene.Renderer.render(ctx, sim);
        sim.startDemo();
        Scene.Renderer.render(ctx, sim);
        sim.startPedestrianReplay();
        Scene.Renderer.render(ctx, sim);
      });
      Game.I18N.setLanguage('zh-CN');
    });

    test('10 新场景、提示、失败、示范和复盘文案均有中英文', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      Object.keys(zh).filter(function (key) { return key.indexOf('scene.nonmotor.') === 0; }).forEach(function (key) {
        assert(typeof en[key] === 'string', '缺少英文文案 ' + key);
      });
      Object.keys(en).filter(function (key) { return key.indexOf('scene.nonmotor.') === 0; }).forEach(function (key) {
        assert(typeof zh[key] === 'string', '缺少中文文案 ' + key);
      });
      const sim = run('nonmotor-i18n', Scene.defensiveInput);
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        const coach = Scene.ui.coach(sim, 47);
        const result = Scene.Scoring.summarize(sim, false);
        const eventToast = Scene.ui.eventToast(sim.events[0]);
        [coach.text, coach.status, Game.I18N.t(result.titleKey), Game.I18N.t(result.summaryKey),
          Game.I18N.t(result.adviceKey), Game.I18N.t(eventToast.key, eventToast.params)].forEach(function (text) {
          assert(String(text).indexOf('scene.nonmotor.') !== 0, lang + ' 不应显示未翻译键：' + text);
        });
      });
      Game.I18N.setLanguage('zh-CN');
    });

    test('10 目录保留既有项目，EP.10 可玩且编号唯一', function () {
      const episodes = {};
      Game.CATALOG.forEach(function (game) {
        assert(!episodes[game.episode], '编号重复：' + game.episode);
        episodes[game.episode] = true;
      });
      const hidden = Game.CATALOG.find(function (game) { return game.id === 'sudden-braking'; });
      const current = Game.CATALOG.find(function (game) { return game.id === 'nonmotor-mix'; });
      const visible = Game.CATALOG.filter(function (game) { return game.status !== 'hidden'; });
      assert(hidden && hidden.status === 'hidden', 'EP.03 不得因新目录重新展示');
      assert(current && current.episode === '10' && current.status === 'playable' &&
        current.href === 'nonmotor-mix.html', 'EP.10 应有真实入口');
      assert(!visible.some(function (game) { return game.id === 'sudden-braking'; }), '可见目录不得包含 EP.03');
      assert(visible.some(function (game) { return game.id === 'truck-inner-wheel' &&
        game.status === 'playable' && game.href === 'truck-inner-wheel.html'; }),
        'EP.05 可玩项目应保留真实入口');
      ['dooring', 'reversing-blind-spot'].forEach(function (id) {
        assert(visible.some(function (game) { return game.id === id && game.status === 'playable'; }), id + ' 必须保留');
      });
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.NonmotorMixTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
