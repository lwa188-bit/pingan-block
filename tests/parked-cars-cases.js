(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['parked-cars'];
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

  function highSpeedInput(sim) {
    return { throttle: sim.speed < 44, brake: false, left: false, right: false };
  }

  function fullThrottleInput() {
    return { throttle: true, brake: false, left: false, right: false };
  }

  function crawlerInput(sim) {
    return { throttle: sim.speed < 15, brake: false, left: false, right: false };
  }

  function lateInput(sim) {
    const event = sim.currentEvent;
    const remaining = event ? event.gapPosition - sim.distance : Infinity;
    const late = remaining <= 12 && sim.distance <= (event ? event.groupEnd + 3 : -1);
    const target = late ? 0 : 47;
    return {
      throttle: sim.speed < target - 0.45,
      brake: sim.speed > target + 0.45,
      left: late,
      right: false
    };
  }

  function runTests() {
    const results = [];
    function test(name, fn) {
      try {
        fn();
        results.push({ name: '[04] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[04] ' + name, passed: false, error: error.message });
      }
    }

    test('04 种子复现布局、危险车缝、占用和横穿速度', function () {
      ['same-seed', 0, 37, 'parked-layout'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '种子 ' + seed + ' 的完整布局应复现');
        assert(a.groups.length === 3, '应有三个车阵');
        assert(a.events.filter(function (event) { return event.occupied; }).length >= 1, '至少一个有人事件');
        assert(a.events.filter(function (event) { return event.occupied; }).length <= 2, '至多两个有人事件');
        assert(a.events.some(function (event) { return !event.occupied; }), '至少一个无人事件');
        a.groups.forEach(function (group) {
          const gaps = a.gaps.filter(function (gap) { return gap.groupId === group.id; });
          assert(gaps.length >= 3, '每组应有多个真实车缝');
          assert(group.carIds.length >= 4 && group.carIds.length <= 5, '每组应有 4～5 辆停车');
          assert(gaps.some(function (gap) { return gap.id === group.hazardGapId; }), '危险出口必须对应真实车缝');
        });
      });
    });

    test('04 segment/AABB 覆盖遮挡、平行、端点和近 miss', function () {
      const hit = Scene.Geometry.segmentIntersectsAABB;
      const rect = { left: 4, right: 6, bottom: 4, top: 6 };
      assert(hit({ x: 0, y: 0 }, { x: 10, y: 10 }, rect), '对角线穿过矩形应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 0, y: 10 }, rect), '平行且在矩形外不应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 3, y: 3 }, rect), '矩形在线段后方不应相交');
      assert(hit({ x: 0, y: 0 }, { x: 10, y: 10 }, { left: 9, right: 11, bottom: 9, top: 11 }), '矩形覆盖线段端点应相交');
      assert(!hit({ x: 0, y: 0 }, { x: 10, y: 10 }, { left: 6.1, right: 7, bottom: 0, top: 4 }), '擦边近 miss 不应相交');
      assert(hit({ x: 5, y: 5 }, { x: 5, y: 5 }, rect), '矩形内部零长线段应相交');
    });

    test('04 左移通过真实几何改善代表性车缝视线', function () {
      const sim = new Scene.Simulation(0);
      const event = sim.events[1];
      sim.distance = event.gapPosition - 10;
      event.pedestrian.state = 'emerging';
      event.pedestrian.active = true;
      event.pedestrian.x = 268;
      sim.x = 188;
      assert(Scene.Geometry.visibilityFor(sim, event).visible, '提前左移后应看见行人');
      sim.x = 210;
      assert(!Scene.Geometry.visibilityFor(sim, event).visible, '居中时同一行人应被停车遮挡');
    });

    test('04 行人从停车后方经车缝出现，远停不会提前清空', function () {
      let sim;
      let event;
      for (let seed = 0; seed < 20 && !event; seed += 1) {
        const candidate = new Scene.Simulation(seed);
        if (candidate.events[0].occupied) {
          sim = candidate;
          event = candidate.events[0];
        }
      }
      assert(event, '应找到首组有人的种子');
      sim.start();
      sim.distance = event.gapPosition - Scene.Constants.EVENT_ACTIVATE + 0.1;
      sim.speed = 0;
      sim.step({}, FIXED_STEP);
      assert(event.pedestrian.state === 'emerging', '接近后应从停车后方出现');
      assert(event.pedestrian.x <= Scene.Constants.PEDESTRIAN_START_X && event.pedestrian.x > Scene.Constants.PEDESTRIAN_EDGE_X, '行人应从停车后方向车缝口移动，而非出现在路中');
      for (let i = 0; i < 900; i += 1) sim.step({}, FIXED_STEP);
      assert(event.pedestrian.state === 'atEdge', '远处停车时行人应在车缝口等待');
      assert(event.pedestrian.x === Scene.Constants.PEDESTRIAN_EDGE_X, '等待位置应在真实车缝口');
      assert(!event.pedestrian.cleared && !event.resolved, '远停不应让事件自动清空或结算');
    });

    test('04 防御策略 200 种子全部安全完成且至少 85 分', function () {
      for (let i = 0; i < 200; i += 1) {
        const sim = run('parked-defense-' + i, Scene.defensiveInput);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'complete', '种子 ' + i + ' 应完成，实际 ' + sim.status);
        assert(!summary.failed, '种子 ' + i + ' 不应失败');
        assert(summary.total >= 85, '种子 ' + i + ' 应高分，实际 ' + summary.total);
        assert(summary.observation === 30, '种子 ' + i + ' 三次提前防御应拿满观察分，实际 ' + summary.observation);
        assert(summary.hardBrakes === 0, '种子 ' + i + ' 不应靠急刹完成');
        sim.events.filter(function (event) { return event.occupied; }).forEach(function (event) {
          assert(event.firstVisibleDistance != null, '种子 ' + i + ' 有人事件应实际可见');
          assert(event.firstVisibleDistance + 2 >= Game.Model.stoppingDistance(event.firstVisibleSpeed), '首次可见时应有保守停车余量');
        });
      }
    });

    test('04 合法横向起点均存在安全防御轨迹', function () {
      [Scene.Constants.CAR_MIN_X, Scene.Constants.CAR_X, Scene.Constants.CAR_MAX_X].forEach(function (x) {
        for (let seed = 0; seed < 40; seed += 1) {
          const sim = new Scene.Simulation('parked-x-' + seed);
          sim.x = x;
          sim.start();
          let guard = 0;
          while (sim.status === 'driving' && guard < 12000) {
            sim.step(Scene.defensiveInput(sim), FIXED_STEP);
            guard += 1;
          }
          assert(sim.status === 'complete', '横向起点 ' + x + '、种子 ' + seed + ' 应安全完成，实际 ' + sim.status);
          assert(sim.x >= Scene.Constants.CAR_MIN_X && sim.x <= Scene.Constants.CAR_MAX_X, '防御轨迹不应越过横向边界');
        }
      });
    });

    test('04 44 km/h 与持续高速均在实际接触前定格', function () {
      [highSpeedInput, fullThrottleInput].forEach(function (controller, strategy) {
        for (let i = 0; i < 100; i += 1) {
          const sim = run('parked-fast-' + strategy + '-' + i, controller);
          assert(sim.status === 'frozen', '策略 ' + strategy + '、种子 ' + i + ' 应危险定格，实际 ' + sim.status);
          const event = sim.events[sim.freezeInfo.eventId];
          const horizontal = Math.abs(event.pedestrian.x - sim.x) < 17;
          const vertical = event.gapPosition < sim.distance + Game.C.CAR_LENGTH_M / 2 &&
            event.gapPosition > sim.distance - Game.C.CAR_LENGTH_M / 2;
          assert(!(horizontal && vertical), '定格时不应已经发生实际 AABB 重叠');
          assert(sim.freezeInfo.remaining > 0, '定格时仍应有剩余距离');
          assert(event.failed, '失败事件应被记录');
        }
      });
    });

    test('04 无人车缝没有隐藏碰撞，也按相同标准奖励提前动作', function () {
      for (let seed = 0; seed < 60; seed += 1) {
        const sim = run('parked-empty-' + seed, Scene.defensiveInput);
        sim.events.filter(function (event) { return !event.occupied; }).forEach(function (event) {
          assert(event.resolved && !event.failed, '种子 ' + seed + ' 无人事件不应隐藏失败');
          assert(event.pedestrian.state === 'waiting', '无人车缝不应暗中生成行人');
          assert(event.earlySlow && event.earlyLateral, '无人车缝也应奖励提前减速和横向余量');
        });
      }
    });

    test('04 提前防御优于临近制动与晚横移', function () {
      for (let seed = 0; seed < 30; seed += 1) {
        const early = run('parked-compare-' + seed, Scene.defensiveInput);
        const late = run('parked-compare-' + seed, lateInput);
        const earlyScore = Scene.Scoring.summarize(early, early.status === 'timeout');
        const lateScore = Scene.Scoring.summarize(late, late.status === 'timeout');
        assert(earlyScore.total > lateScore.total, '种子 ' + seed + ' 提前策略总分应更高');
        assert(earlyScore.observation > lateScore.observation, '种子 ' + seed + ' 临近动作不应获得同等观察分');
      }
    });

    test('04 全程龟速超时且总分不超过 69', function () {
      for (let i = 0; i < 50; i += 1) {
        const sim = run('parked-crawl-' + i, crawlerInput);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'timeout', '种子 ' + i + ' 应超时，实际 ' + sim.status);
        assert(summary.total <= 69, '种子 ' + i + ' 龟速不应高分，实际 ' + summary.total);
      }
    });

    test('04 必要让行效率中性，行人清空后停车恢复计时', function () {
      const sim = new Scene.Simulation('yield-check');
      const event = sim.events.find(function (item) { return item.occupied; });
      sim.events.slice(0, event.id).forEach(function (item) { item.resolved = true; });
      sim.start();
      sim.distance = event.gapPosition - 10;
      sim.speed = 0;
      event.pedestrian.state = 'crossing';
      event.pedestrian.x = sim.x + 10;
      assert(Scene.Scoring.isYieldExempt(sim), '行人占用冲突走廊时应豁免必要等待');
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 0 && sim.scoring.efficiencyIntegral === 0, '必要等待不应计入效率分子或分母');
      event.pedestrian.cleared = true;
      event.pedestrian.state = 'cleared';
      assert(!Scene.Scoring.isYieldExempt(sim), '行人清空后不应继续豁免');
      Scene.Scoring.recordStep(sim.scoring, sim, 1);
      assert(sim.scoring.efficiencyTime === 1, '清空后继续停车应恢复效率计时');
    });

    test('04 重试保留失败、原布局和 59 分封顶', function () {
      const sim = run('parked-retry', highSpeedInput);
      assert(sim.status === 'frozen', '应先发生失败');
      const failedId = sim.freezeInfo.eventId;
      const layout = JSON.stringify(sim.plan);
      sim.retryEvent();
      assert(sim.status === 'driving', '重试后应恢复驾驶');
      assert(sim.events[failedId].failed && sim.events[failedId].attempts === 1, '重试不应洗掉首次失败');
      assert(JSON.stringify(sim.plan) === layout, '重试不应重新随机停车和危险车缝');
      assert(sim.distance === Math.max(0, sim.events[failedId].groupStart - Scene.Constants.APPROACH_START), '应回到车阵接近起点');
      let guard = 0;
      while (sim.status === 'driving' && guard < 12000) {
        sim.step(Scene.defensiveInput(sim), FIXED_STEP);
        guard += 1;
      }
      assert(sim.status === 'complete', '重试后防御驾驶应能完成');
      const summary = Scene.Scoring.summarize(sim, false);
      assert(summary.failed, '结算应保留首次失败');
      assert(summary.total <= 59, '失败后总分应封顶 59，实际 ' + summary.total);
      assert(summary.observation === 30, '重试后正确操作仍可获得当前事件观察分');
    });

    test('04 示范逐帧复用真实防御模拟，结束后回到原事件', function () {
      const sim = run('parked-demo', highSpeedInput);
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
      expected.distance = Math.max(0, expected.events[failedId].groupStart - Scene.Constants.APPROACH_START);
      expected.speed = 45;
      expected.previousSpeed = 45;
      expected.start();
      for (let i = 0; i < 240 && sim.status === 'demonstrating'; i += 1) {
        sim.stepDemo(FIXED_STEP);
        expected.step(Scene.defensiveInput(expected), FIXED_STEP);
        if (sim.status !== 'demonstrating') break;
        assert(Math.abs(sim.demo.distance - expected.distance) < 0.000001, '示范第 ' + i + ' 帧应复用真实车辆物理');
        assert(sim.demo.x === expected.x && sim.demo.speed === expected.speed, '示范第 ' + i + ' 帧的横移与速度应一致');
      }
      let guard = 0;
      while (sim.status === 'demonstrating' && guard < 2000) {
        sim.stepDemo(FIXED_STEP);
        guard += 1;
      }
      assert(sim.status === 'driving' && sim.demo === null, '示范结束后应回到可重试驾驶');
      assert(sim.events[failedId].failed, '示范不应洗掉失败');
      assert(JSON.stringify(sim.plan) === layout, '示范不应改变正式布局');
    });

    test('04 30/60/120Hz 固定步长结果一致', function () {
      const summaries = [30, 60, 120].map(function (hz) {
        const sim = run('parked-hz', Scene.defensiveInput, hz);
        const summary = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        return sim.status + ':' + summary.total + ':' + summary.hardBrakes + ':' + summary.observation;
      });
      assert(summaries[0] === summaries[1] && summaries[1] === summaries[2], '帧率不应改变结果：' + summaries.join(' / '));
    });

    test('04 新结算和重试文案 key 均有中英文', function () {
      const sim = run('parked-i18n', Scene.defensiveInput);
      const summary = Scene.Scoring.summarize(sim, false);
      const keys = [summary.titleKey, summary.summaryKey, summary.adviceKey, 'scene.parked.toast.retry'];
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        keys.forEach(function (key) {
          const text = Game.I18N.t(key);
          assert(text && text !== key, lang + ' 缺少文案 ' + key);
        });
        const retry = Scene.ui.retryToast(sim);
        assert(Game.I18N.t(retry.key, retry.params) !== retry.key, lang + ' 缺少场景专属重试提示');
      });
      Game.I18N.setLanguage('zh-CN');
    });

    test('04 速度偏快提示使用车缝场景文案，不串用公交场景措辞', function () {
      const feedback = Scene.ui.eventToast({ earlySlow: false, lateSlow: false, occupied: false });
      assert(feedback.key === 'scene.parked.toast.fast', '速度偏快反馈不应复用 EP.01 的 toast.fast');
      const parkedKeys = Object.keys(Game.I18N.dictionaries.zh).filter(function (key) {
        return key.indexOf('scene.parked.') === 0;
      });
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        parkedKeys.forEach(function (key) {
          assert(!/公交|巴士|\bbus(?:es)?\b/i.test(Game.I18N.t(key)), lang + ' 车缝文案混入公交措辞：' + key);
        });
        const text = Game.I18N.t(feedback.key, feedback.params);
        assert(text.indexOf(lang === 'zh-CN' ? '停车区' : 'parked cars') !== -1, lang + ' 速度偏快提示应描述停车区');
      });
      Game.I18N.setLanguage('zh-CN');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.ParkedCarsTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
