(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['crosswalk-turnback'];
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
    return { throttle: true, brake: false };
  }

  function crawlerInput(sim) {
    return { throttle: sim.speed < 15, brake: false };
  }

  function lateInput(sim) {
    const event = sim.currentEvent;
    const remaining = event ? event.crossingPosition - sim.distance : Infinity;
    const target = remaining <= 30 && remaining > -4 && event && Scene.pedestrianRequired(event) ? 0 : 47;
    return {
      throttle: sim.speed < target - 0.4,
      brake: sim.speed > target + 0.4
    };
  }

  function useEvent(sim, eventId) {
    sim.events.forEach(function (event, index) {
      event.resolved = index < eventId;
    });
    const event = sim.events[eventId];
    sim.distance = Math.max(0, event.crossingPosition - Scene.Constants.APPROACH_START);
    sim.speed = 45;
    sim.previousSpeed = 45;
    sim.status = 'driving';
    return event;
  }

  function planFingerprint(sim) {
    return JSON.stringify(sim.plan);
  }

  function actualOverlap(sim, event) {
    const pedestrian = event.pedestrian;
    if (!pedestrian.active || pedestrian.cleared) return false;
    const horizontal = Math.abs(pedestrian.x - sim.x) < 18;
    const halfLength = Scene.Constants.CAR_LENGTH_M / 2;
    const vertical = event.crossingPosition < sim.distance + halfLength &&
      event.crossingPosition > sim.distance - halfLength;
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
      elapsed: sim.elapsed,
      scoring: sim.scoring,
      events: sim.events.map(function (event) {
        return {
          resolved: event.resolved,
          failed: event.failed,
          attempts: event.attempts,
          recordedSlow: event.recordedSlow,
          speedAtSlow: event.speedAtSlow,
          maxSpeedAfterSlow: event.maxSpeedAfterSlow,
          stopDuration: event.stopDuration,
          properStop: event.properStop,
          waitedUntilClear: event.waitedUntilClear,
          earlyStart: event.earlyStart,
          lineViolation: event.lineViolation,
          pedestrian: event.pedestrian
        };
      })
    });
  }

  function runTests() {
    const results = [];
    function test(name, fn) {
      try {
        fn();
        results.push({ name: '[07] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[07] ' + name, passed: false, error: error.message });
      }
    }

    test('07 每局正常、加速、折返各一次，种子完整复现', function () {
      ['same-seed', 0, 37, 'turnback-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(planFingerprint(a) === planFingerprint(b), '种子 ' + seed + ' 的完整计划应复现');
        assert(a.events.length === 3, '每局应有三组人行横道');
        ['normal', 'surge', 'turnback'].forEach(function (behavior) {
          assert(a.events.filter(function (event) { return event.behavior === behavior; }).length === 1,
            '种子 ' + seed + ' 应恰好有一个 ' + behavior);
        });
        a.events.filter(function (event) { return event.behavior === 'turnback'; }).forEach(function (event) {
          assert(event.direction > 0 ? event.changeX > Scene.Constants.CAR_X : event.changeX < Scene.Constants.CAR_X,
            '折返必须发生在行人经过玩家车道之后');
        });
      });
    });

    test('07 行人从路缘进入，加速有过程，折返有转身和返回', function () {
      const plan = new Scene.Simulation('behavior-states');
      plan.events.forEach(function (planned, eventId) {
        const sim = new Scene.Simulation('behavior-states');
        const event = useEvent(sim, eventId);
        sim.distance = event.crossingPosition - Scene.Constants.EVENT_ACTIVATE + 0.01;
        sim.speed = 0;
        sim.previousSpeed = 0;
        const states = {};
        let minX = event.pedestrian.x;
        let maxX = event.pedestrian.x;
        let maxSurgeSpeed = 0;
        let surgeTransitionFrames = 0;
        let sawTurnbackDeceleration = false;
        for (let frame = 0; frame < 1800 && !event.pedestrian.cleared; frame += 1) {
          sim.step({}, FIXED_STEP);
          states[event.pedestrian.state] = true;
          minX = Math.min(minX, event.pedestrian.x);
          maxX = Math.max(maxX, event.pedestrian.x);
          if (event.pedestrian.state === 'surging') {
            maxSurgeSpeed = Math.max(maxSurgeSpeed, event.pedestrian.speed);
            if (event.pedestrian.speed < event.surgeSpeed) surgeTransitionFrames += 1;
          }
          if (event.pedestrian.state === 'slowing' && event.pedestrian.speed < event.walkSpeed * 0.8) {
            sawTurnbackDeceleration = true;
          }
        }
        assert(states.walking && event.pedestrian.cleared, planned.behavior + ' 应从 walking 走到 cleared');
        assert(event.pedestrian.x === event.startX || event.pedestrian.x === event.clearX,
          '行人应在真实路缘或清空点结束，不能停在路中');
        if (planned.behavior === 'surge') {
          assert(states.surging, '突然加速事件必须进入 surging');
          assert(maxSurgeSpeed > event.walkSpeed, '加速后的速度应高于初速');
          assert(surgeTransitionFrames * FIXED_STEP >= 0.4 && surgeTransitionFrames * FIXED_STEP <= 0.6,
            '突然加速应有约 0.4～0.6 秒过渡，实际 ' + (surgeTransitionFrames * FIXED_STEP).toFixed(3) + ' 秒');
        }
        if (planned.behavior === 'turnback') {
          assert(states.slowing && states.turning && states.returning, '折返必须先减速，再转身和返回');
          assert(sawTurnbackDeceleration, '折返前必须有可测量的减速过程，不能瞬间停住');
          assert(minX <= Math.min(event.startX, event.clearX) + 0.001 ||
            maxX >= Math.max(event.startX, event.clearX) - 0.001, '折返后应回到出发路缘');
        }
      });
    });

    test('07 行人计划不随玩家输入或语言改变', function () {
      const a = new Scene.Simulation('input-independent');
      const b = new Scene.Simulation('input-independent');
      Game.I18N.setLanguage('en');
      const eventA = useEvent(a, 0);
      const eventB = useEvent(b, 0);
      a.distance = b.distance = eventA.crossingPosition - Scene.Constants.EVENT_ACTIVATE + 0.01;
      a.speed = b.speed = 0;
      for (let frame = 0; frame < 500; frame += 1) {
        a.step({ throttle: frame % 2 === 0 }, FIXED_STEP);
        b.step({ brake: true }, FIXED_STEP);
        // 直接比较同一世界时刻的行人状态；车辆是否移动不得改写行为计划。
        a.distance = b.distance = eventA.crossingPosition - Scene.Constants.EVENT_ACTIVATE + 0.01;
        a.speed = b.speed = 0;
      }
      assert(JSON.stringify(eventA.pedestrian) === JSON.stringify(eventB.pedestrian), '行人状态不应读取油门或制动');
      Game.I18N.setLanguage('zh-CN');
      assert(planFingerprint(a) === planFingerprint(b), '语言不得改变计划');
    });

    test('07 200 个种子防御策略安全完成、观察满分且无急刹', function () {
      for (let seed = 0; seed < 200; seed += 1) {
        const sim = run('turnback-defensive-' + seed, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'complete', '种子 ' + seed + ' 应安全完成，实际 ' + sim.status);
        assert(result.observation === 30, '种子 ' + seed + ' 观察应满分，实际 ' + result.observation);
        assert(result.total >= 85, '种子 ' + seed + ' 应获高评价，实际 ' + result.total);
        assert(result.hardBrakes === 0, '种子 ' + seed + ' 正确策略不应依赖急刹');
        assert(sim.elapsed < 95, '种子 ' + seed + ' 防御驾驶不应龟速超时');
        sim.events.forEach(function (event) {
          assert(event.properStop && event.waitedUntilClear && !event.earlyStart,
            '种子 ' + seed + ' / ' + event.behavior + ' 应真实停稳并等待清空');
        });
      }
    });

    test('07 持续高速在真实接触前定格，不展示已经重叠的画面', function () {
      for (let seed = 0; seed < 100; seed += 1) {
        const sim = run('turnback-fast-' + seed, fullThrottleInput);
        assert(sim.status === 'frozen', '种子 ' + seed + ' 持续高速应在接触前定格');
        const event = sim.events[sim.freezeInfo.eventId];
        assert(!actualOverlap(sim, event), '种子 ' + seed + ' 定格时不应已经接触');
        assert(sim.freezeInfo.remaining >= 0, '剩余距离不得为负');
      }
    });

    test('07 全程蠕行会超时且总分不超过 69', function () {
      for (let seed = 0; seed < 50; seed += 1) {
        const sim = run('turnback-crawler-' + seed, crawlerInput);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'timeout', '种子 ' + seed + ' 全程 15 km/h 应超时');
        assert(result.total <= 69, '种子 ' + seed + ' 龟速不应获得高分');
      }
    });

    test('07 必要停车效率中性，远离路口停车和清空后停车仍计时', function () {
      const sim = new Scene.Simulation('yield-efficiency');
      const event = useEvent(sim, 0);
      sim.distance = event.crossingPosition - 11;
      sim.speed = 0;
      sim.previousSpeed = 0;
      event.pedestrian.active = true;
      event.pedestrian.state = 'turning';
      event.pedestrian.turnTimer = 10;
      for (let frame = 0; frame < 60; frame += 1) sim.step({}, FIXED_STEP);
      assert(Scene.Scoring.isYieldExempt(sim), '停止线附近必要停车应豁免效率');
      assert(sim.scoring.efficiencyTime === 0, '必要等待不应增加效率分母');
      event.pedestrian.cleared = true;
      event.pedestrian.active = false;
      event.pedestrian.state = 'cleared';
      sim.step({}, FIXED_STEP);
      assert(!Scene.Scoring.isYieldExempt(sim), '清空后继续停车不应豁免');
      assert(sim.scoring.efficiencyTime > 0, '清空后停车应恢复效率计时');

      const far = new Scene.Simulation('far-stop');
      const farEvent = useEvent(far, 0);
      far.distance = farEvent.crossingPosition - 40;
      far.speed = 0;
      farEvent.pedestrian.active = true;
      farEvent.pedestrian.state = 'walking';
      assert(!Scene.Scoring.isYieldExempt(far), '远离斑马线停车不算必要让行');
    });

    test('07 蠕行通过未真正停稳，安全与观察不能满分', function () {
      const seed = new Scene.Simulation('rolling-pass');
      const eventId = seed.events.findIndex(function (event) { return event.behavior === 'normal'; });
      const sim = new Scene.Simulation('rolling-pass');
      const event = useEvent(sim, eventId);
      sim.distance = event.crossingPosition - 8;
      sim.speed = 12;
      sim.previousSpeed = 12;
      event.pedestrian.active = true;
      event.pedestrian.state = 'walking';
      event.pedestrian.x = event.direction > 0 ? 250 : 170;
      run(null, function (current) {
        return { throttle: current.speed < 12, brake: false };
      }, null, sim);
      assert(event.resolved && sim.status !== 'frozen', '远离玩家车道的行人应允许测试无接触抢行');
      assert(event.lineViolation && !event.properStop, '未停稳越过停止线必须被记录');
      assert(Scene.Scoring.eventObservation(event) < 10, '蠕行抢行不能获得观察满分');
      assert(!Scene.Scoring.eventSafe(event), '未停车让行即使无接触也不能获高安全评价');
    });

    test('07 停稳后提前起步会丢失等待分并被记录', function () {
      const plan = new Scene.Simulation('early-start');
      const eventId = plan.events.findIndex(function (event) { return event.behavior === 'normal'; });
      const sim = new Scene.Simulation('early-start');
      const event = useEvent(sim, eventId);
      sim.distance = event.crossingPosition - 11;
      sim.speed = 0;
      sim.previousSpeed = 0;
      event.pedestrian.active = true;
      event.pedestrian.state = 'walking';
      event.pedestrian.x = event.direction > 0 ? 250 : 170;
      for (let frame = 0; frame < 30; frame += 1) sim.step({}, FIXED_STEP);
      assert(event.properStop, '测试前应先形成真实停稳');
      for (let frame = 0; frame < 20; frame += 1) sim.step({ throttle: true }, FIXED_STEP);
      assert(event.earlyStart, '未清空就重新加速必须记为提前起步');
      assert(Scene.Scoring.eventObservation(event) < 10, '提前起步不能拿等待满分');
    });

    test('07 临近才制动比提前渐进减速评价更低', function () {
      const early = run('turnback-late-comparison', Scene.defensiveInput);
      const late = run('turnback-late-comparison', lateInput);
      const earlyResult = Scene.Scoring.summarize(early, early.status === 'timeout');
      const lateResult = Scene.Scoring.summarize(late, late.status === 'timeout');
      assert(early.status === 'complete' && late.status === 'complete', '两种策略都应完成以比较评分');
      assert(lateResult.observation < earlyResult.observation,
        '晚减速观察分应更低：' + lateResult.observation + ' / ' + earlyResult.observation);
    });

    test('07 重试保留种子和首次失败，已通过事件不重复结算', function () {
      const sim = run('turnback-retry', fullThrottleInput);
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

    test('07 三类事件示范都调用同一个真实 Simulation', function () {
      ['normal', 'surge', 'turnback'].forEach(function (behavior) {
        const template = new Scene.Simulation('demo-' + behavior);
        const eventId = template.events.findIndex(function (event) { return event.behavior === behavior; });
        const official = new Scene.Simulation('demo-' + behavior);
        useEvent(official, eventId);
        official.status = 'frozen';
        official.freezeInfo = { eventId: eventId };
        official.events[eventId].failed = true;
        official.events[eventId].attempts = 1;
        official.startDemo();

        const expected = new Scene.Simulation('demo-' + behavior);
        for (let index = 0; index < eventId; index += 1) {
          expected.events[index].resolved = true;
          expected.events[index].earlySlow = true;
          expected.events[index].properStop = true;
          expected.events[index].waitedUntilClear = true;
        }
        expected.distance = Math.max(0, expected.events[eventId].crossingPosition - Scene.Constants.APPROACH_START);
        expected.speed = 45;
        expected.previousSpeed = 45;
        expected.status = 'driving';

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

    test('07 30 / 60 / 120Hz 固定步长结果一致', function () {
      const summaries = [30, 60, 120].map(function (hz) {
        const sim = run('turnback-hz', Scene.defensiveInput, hz);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        return [sim.status, result.total, result.observation, result.efficiency, result.hardBrakes,
          sim.events.map(function (event) { return event.pedestrian.state; }).join(',')].join(':');
      });
      assert(summaries[0] === summaries[1] && summaries[1] === summaries[2],
        '帧率不应改变结果：' + summaries.join(' / '));
    });

    test('07 Renderer 可绘制正常、加速、转身、定格与真实示范', function () {
      const noop = function () {};
      const ctx = {
        clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
        stroke: noop, setLineDash: noop, save: noop, restore: noop, arc: noop,
        measureText: function (text) { return { width: String(text).length * 7 }; },
        fillText: function (text, x, y) {
          assert(Number.isFinite(x) && Number.isFinite(y), '文字坐标必须有限');
          assert(String(text).indexOf('scene.turnback.') !== 0, '画面不得显示缺失文案键');
        }
      };
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        const sim = new Scene.Simulation('turnback-render');
        Scene.Renderer.render(ctx, sim);
        sim.start();
        sim.distance = sim.events[0].crossingPosition - 20;
        sim.events[0].pedestrian.active = true;
        sim.events[0].pedestrian.state = 'surging';
        Scene.Renderer.render(ctx, sim);
        sim.events[0].pedestrian.state = 'turning';
        Scene.Renderer.render(ctx, sim);
        sim.status = 'frozen';
        sim.freezeInfo = { eventId: 0 };
        Scene.Renderer.render(ctx, sim);
        sim.startDemo();
        Scene.Renderer.render(ctx, sim);
      });
      Game.I18N.setLanguage('zh-CN');
    });

    test('07 新场景、提示、失败、示范和列表文案均有中英文', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      Object.keys(zh).filter(function (key) {
        return key.indexOf('scene.turnback.') === 0 || key.indexOf('list.') === 0 || key === 'home.quickList';
      }).forEach(function (key) {
        assert(typeof en[key] === 'string', '缺少英文文案 ' + key);
      });
      Object.keys(en).filter(function (key) {
        return key.indexOf('scene.turnback.') === 0 || key.indexOf('list.') === 0 || key === 'home.quickList';
      }).forEach(function (key) {
        assert(typeof zh[key] === 'string', '缺少中文文案 ' + key);
      });
      const sim = run('turnback-i18n', Scene.defensiveInput);
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        const coach = Scene.ui.coach(sim, 47);
        const result = Scene.Scoring.summarize(sim, false);
        const eventToast = Scene.ui.eventToast(sim.events[0]);
        [coach.text, coach.status, Game.I18N.t(result.titleKey), Game.I18N.t(result.summaryKey),
          Game.I18N.t(result.adviceKey), Game.I18N.t(eventToast.key, eventToast.params)].forEach(function (text) {
          assert(String(text).indexOf('scene.turnback.') !== 0, lang + ' 不应显示未翻译键：' + text);
        });
      });
      Game.I18N.setLanguage('zh-CN');
    });

    test('07 目录保留 EP.03 隐藏，EP.07 可玩且编号唯一', function () {
      const episodes = {};
      Game.CATALOG.forEach(function (game) {
        assert(!episodes[game.episode], '编号重复：' + game.episode);
        episodes[game.episode] = true;
      });
      const hidden = Game.CATALOG.find(function (game) { return game.id === 'sudden-braking'; });
      const current = Game.CATALOG.find(function (game) { return game.id === 'crosswalk-turnback'; });
      const visible = Game.CATALOG.filter(function (game) { return game.status !== 'hidden'; });
      assert(hidden && hidden.status === 'hidden', 'EP.03 不得因新目录重新展示');
      assert(current && current.episode === '07' && current.status === 'playable' &&
        current.href === 'crosswalk-turnback.html', 'EP.07 应有真实入口');
      assert(!visible.some(function (game) { return game.id === 'sudden-braking'; }), '可见目录不得包含 EP.03');
      assert(visible.some(function (game) { return game.id === 'truck-inner-wheel' &&
        game.status === 'playable' && game.href === 'truck-inner-wheel.html'; }),
        'EP.05 可玩项目应保留真实入口');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.CrosswalkTurnbackTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
