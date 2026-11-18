(function (root) {
  'use strict';

  const Game = root.BusGame;
  const C = Game.C;

  function defensiveInput(simulation) {
    const event = simulation.currentEvent;
    if (!event) return { throttle: simulation.speed < 47, brake: simulation.speed > 49, left: true };
    const distance = event.busPosition - simulation.distance;
    let target = distance < C.RISK_START + 5 && distance > -C.RISK_END ? 18 : 47;
    const pedestrian = event.pedestrian;
    if (pedestrian.visible && !pedestrian.waiting && distance < C.REVEAL_DISTANCE + 1 && pedestrian.x < 252) target = 0;
    return {
      throttle: simulation.speed < target - 0.6,
      brake: simulation.speed > target + 0.6,
      left: true
    };
  }

  function crawlerInput(simulation) {
    return { throttle: simulation.speed < 15, brake: simulation.speed > 16, left: true };
  }

  function lateBrakeInput(simulation) {
    const event = simulation.currentEvent;
    if (!event) return { throttle: simulation.speed < 30, brake: simulation.speed > 32 };
    const distance = event.busPosition - simulation.distance;
    const pedestrian = event.pedestrian;
    const shouldBrake = distance < 12 && distance > -2 &&
      (!pedestrian.waiting || simulation.speed > 18);
    if (pedestrian.waiting && distance < 8) {
      return { throttle: simulation.speed < 17, brake: simulation.speed > 19 };
    }
    return {
      throttle: !shouldBrake && simulation.speed < 30,
      brake: shouldBrake && simulation.speed > 0.2
    };
  }

  function run(seed, controller, options) {
    options = options || {};
    const simulation = new Game.Simulation(seed);
    simulation.start();
    const frameStep = 1 / (options.frameHz || 60);
    let accumulator = 0;
    let retries = 0;
    let frames = 0;
    while (!['complete', 'timeout'].includes(simulation.status) && frames < 12000) {
      if (simulation.status === 'frozen') {
        if (!options.retry || retries >= 4) break;
        simulation.retryEvent();
        retries += 1;
      }
      accumulator += frameStep;
      while (accumulator + 1e-10 >= C.FIXED_STEP) {
        simulation.step(controller(simulation), C.FIXED_STEP);
        accumulator -= C.FIXED_STEP;
        if (simulation.status !== 'driving') break;
      }
      frames += 1;
    }
    return simulation;
  }

  function runTests() {
    const results = [];
    function test(name, callback) {
      try {
        callback();
        results.push({ name: name, passed: true });
      } catch (error) {
        results.push({ name: name, passed: false, error: error.message });
      }
    }
    function assert(condition, message) {
      if (!condition) throw new Error(message || '断言失败');
    }

    test('同一种子生成相同事件，有人与无人数量符合约束', function () {
      for (let seed = 0; seed < 200; seed += 1) {
        const a = Game.Model.createEvents(seed);
        const b = Game.Model.createEvents(seed);
        assert(JSON.stringify(a.map(e => [e.occupied, e.runSpeed])) === JSON.stringify(b.map(e => [e.occupied, e.runSpeed])), '种子不可复现');
        const occupied = a.filter(e => e.occupied).length;
        assert(occupied >= 1 && occupied <= 2, '有人事件数量错误');
      }
    });

    test('防御策略在 200 个种子下均安全、按时且取得高分', function () {
      for (let seed = 0; seed < 200; seed += 1) {
        const simulation = run(seed, defensiveInput);
        const result = Game.Scoring.summarize(simulation, simulation.status === 'timeout');
        assert(simulation.status === 'complete', '种子 ' + seed + ' 未完成：' + simulation.status);
        assert(result.total >= 85, '种子 ' + seed + ' 得分偏低：' + result.total);
        assert(result.earlySlowCount === 3, '种子 ' + seed + ' 未记录三次提前减速');
      }
    });

    test('全程低速不能刷高分', function () {
      for (let seed = 0; seed < 30; seed += 1) {
        const simulation = run(seed, crawlerInput);
        const result = Game.Scoring.summarize(simulation, simulation.status === 'timeout');
        assert(result.total <= 69, '龟速得分过高：' + result.total);
        assert(result.timedOut, '龟速策略应当超时');
      }
    });

    test('持续高速在有人事件触发碰撞前定格，而非实际重叠', function () {
      for (let seed = 0; seed < 50; seed += 1) {
        const simulation = run(seed, function () { return { throttle: true }; });
        assert(simulation.status === 'frozen', '种子 ' + seed + ' 高速策略未触发定格');
        const event = simulation.events[simulation.freezeInfo.eventId];
        const carFront = simulation.distance + C.CAR_LENGTH_M / 2;
        const carRear = simulation.distance - C.CAR_LENGTH_M / 2;
        const pedestrianY = event.busPosition + 1.8;
        const horizontal = Math.abs(event.pedestrian.x - simulation.x) < C.CAR_WIDTH_M * C.PIXELS_PER_METER / 2 + 2;
        const vertical = pedestrianY > carRear && pedestrianY < carFront;
        assert(!(horizontal && vertical), '定格时已经发生重叠');
      }
    });

    test('44 km/h 居中不减速通过有人公交时，全部在接触前触发警示', function () {
      for (let seed = 0; seed < 100; seed += 1) {
        const simulation = run(seed, function (current) {
          return { throttle: current.speed < 44 };
        });
        assert(simulation.status === 'frozen', '种子 ' + seed + ' 在 44 km/h 下未触发警示');
      }
    });

    test('提前减速比临近急刹获得更高观察、平稳和总分', function () {
      const early = run(0, defensiveInput);
      const late = run(0, lateBrakeInput);
      const earlyResult = Game.Scoring.summarize(early, early.status === 'timeout');
      const lateResult = Game.Scoring.summarize(late, late.status === 'timeout');
      assert(earlyResult.observation > lateResult.observation, '观察分没有区分');
      assert(earlyResult.smooth > lateResult.smooth, '平稳分没有区分');
      assert(earlyResult.total > lateResult.total, '总分没有区分');
    });

    test('47 与 55 km/h 下从 55 米提示处反应并制动，可在 15 米节点前平稳降速', function () {
      [47, 55].forEach(function (cruiseSpeed) {
        const simulation = new Game.Simulation(0);
        simulation.start();
        simulation.distance = simulation.currentEvent.busPosition - C.APPROACH_START;
        simulation.speed = cruiseSpeed;
        let steps = 0;
        while (simulation.currentEvent.busPosition - simulation.distance > C.SLOW_CHECK && steps < 600) {
          const reacted = simulation.elapsed >= C.REACTION_TIME;
          simulation.step({ brake: reacted }, C.FIXED_STEP);
          steps += 1;
        }
        assert(simulation.speed <= C.SAFE_SPEED, cruiseSpeed + ' km/h 下来不及降速：' + simulation.speed);
        assert(simulation.scoring.hardBrakes === 0, cruiseSpeed + ' km/h 正常制动被误判为急刹');
      });
    });

    test('效率分区分畅通巡航、畅通龟速与风险区加速', function () {
      const quality = Game.Scoring.speedQuality;
      assert(quality(40, false) > quality(10, false), '畅通段未限制龟速');
      assert(quality(15, true) > quality(30, true), '风险区加速不应提高效率');
      assert(quality(18, true) === 1, '合理防御速度应得满效率');
    });

    test('重试保留首次失败惩罚，事件奖励不重复累计', function () {
      const simulation = run(0, function () { return { throttle: true }; }, { retry: true });
      assert(simulation.events.some(e => e.failed), '失败记录被清除');
      const result = Game.Scoring.summarize(simulation, simulation.status === 'timeout');
      assert(result.total <= 59, '重试后总分上限未生效');
      assert(simulation.events.filter(e => e.resolved).length <= 3, '事件被重复结算');
    });

    test('30、60、120Hz 渲染节奏下固定步长结果一致', function () {
      const baseline = run(7, defensiveInput, { frameHz: 60 });
      [30, 120].forEach(function (hz) {
        const simulation = run(7, defensiveInput, { frameHz: hz });
        assert(Math.abs(simulation.distance - baseline.distance) < 0.01, hz + 'Hz 距离不同');
        assert(Math.abs(simulation.elapsed - baseline.elapsed) < 0.02, hz + 'Hz 时间不同');
        assert(simulation.scoring.hardBrakes === baseline.scoring.hardBrakes, hz + 'Hz 急刹次数不同');
      });
    });

    test('20 km/h 的反应与舒适制动距离小于行人揭示距离', function () {
      assert(Game.Model.stoppingDistance(20) < C.REVEAL_DISTANCE, '安全速度下来不及停车');
    });

    test('行人从公交车头边缘出现并快速移动，而非在路中凭空出现', function () {
      let seed = 0;
      while (!Game.Model.createEvents(seed)[0].occupied) seed += 1;
      const simulation = new Game.Simulation(seed);
      simulation.start();
      const event = simulation.currentEvent;
      simulation.speed = 0;
      simulation.distance = event.busPosition - C.PEDESTRIAN_TRIGGER - 0.1;
      simulation.step({}, C.FIXED_STEP);
      assert(!event.pedestrian.active && !event.pedestrian.visible, '行人过早暴露');
      simulation.distance = event.busPosition - C.PEDESTRIAN_TRIGGER + 0.01;
      simulation.step({}, C.FIXED_STEP);
      assert(event.pedestrian.active && event.pedestrian.visible, '行人未在车头处出现');
      assert(Math.abs(event.pedestrian.x - C.PEDESTRIAN_START_X) <= event.runSpeed * C.FIXED_STEP + 0.01, '行人出现点不在公交车头边缘');
      const appearX = event.pedestrian.x;
      for (let i = 0; i < 30; i += 1) simulation.step({}, C.FIXED_STEP);
      assert(event.pedestrian.x < appearX - event.runSpeed * 0.4, '行人出现后没有快速横穿');
    });

    test('无人事件也按相同标准奖励提前减速', function () {
      const simulation = run(0, defensiveInput);
      const empty = simulation.events.find(e => !e.occupied);
      assert(empty && empty.earlySlow, '无人事件未记录提前减速');
      assert(Game.Scoring.eventObservation(empty) === 10, '无人事件观察奖励不同');
    });

    test('中英文文案键完整对应，且所有条目非空', function () {
      const dictionaries = Game.I18N.dictionaries;
      const zhKeys = Object.keys(dictionaries.zh).sort();
      const enKeys = Object.keys(dictionaries.en).sort();
      assert(JSON.stringify(zhKeys) === JSON.stringify(enKeys), '中英文文案键不一致');
      zhKeys.forEach(function (key) {
        assert(dictionaries.zh[key] && dictionaries.en[key], '空文案：' + key);
      });
    });

    test('语言切换支持参数插值、无效语言拒绝和缺失键回退', function () {
      const original = Game.I18N.getLanguage();
      Game.I18N.setLanguage('en');
      assert(Game.I18N.t('hud.progress', { resolved: 2 }) === 'BUSES 2 / 3', '英文插值错误');
      Game.I18N.setLanguage('unsupported');
      assert(Game.I18N.getLanguage() === 'en', '无效语言不应生效');
      assert(Game.I18N.t('not-a-real-key') === 'not-a-real-key', '缺失键没有安全回退');
      Game.I18N.setLanguage(original);
    });

    test('评分结果只返回可翻译的稳定文案键', function () {
      const result = Game.Scoring.summarize(run(0, defensiveInput), false);
      ['titleKey', 'summaryKey', 'adviceKey'].forEach(function (field) {
        assert(result[field], field + ' 缺失');
        assert(Game.I18N.dictionaries.zh[result[field]], field + ' 缺少中文');
        assert(Game.I18N.dictionaries.en[result[field]], field + ' 缺少英文');
      });
    });

    test('游戏目录 ID 唯一，入口状态和双语元数据有效', function () {
      const ids = Game.CATALOG.map(game => game.id);
      assert(new Set(ids).size === ids.length, '游戏目录 ID 重复');
      assert(Game.CATALOG.some(game => game.status === 'playable'), '目录没有可玩游戏');
      Game.CATALOG.forEach(function (game) {
        assert(['playable', 'coming-soon', 'hidden'].includes(game.status), '未知游戏状态：' + game.status);
        assert(game.title.zh && game.title.en && game.description.zh && game.description.en, '游戏双语元数据不完整：' + game.id);
        if (game.status === 'playable') assert(game.href, '可玩游戏缺少入口：' + game.id);
        if (game.status === 'coming-soon') assert(!game.href, '即将推出游戏不应有入口：' + game.id);
      });
      assert(Game.CATALOG.find(game => game.id === 'sudden-braking').status === 'hidden', 'EP.03 应保持下线状态');
      assert(Game.CATALOG.find(game => game.id === 'large-vehicle-blind-zones').status === 'hidden', 'EP.19 应保持下线状态');
    });

    return {
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      results: results
    };
  }

  root.BusGameTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
