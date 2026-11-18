(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['reversing-blind-spot'];
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
    while (sim.status === 'driving' && guard < 22000) {
      accumulator += frame;
      while (accumulator >= FIXED_STEP && sim.status === 'driving') {
        sim.step(controller(sim), FIXED_STEP);
        accumulator -= FIXED_STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    assert(guard < 22000, '模拟不应卡死');
    return sim;
  }

  function fullThrottleInput() {
    return { throttle: true, brake: false, left: false, right: false };
  }

  function cappedInput(target) {
    return function (sim) {
      if (sim.phase === 'walkaround') return fullThrottleInput();
      return { throttle: sim.speed < target - 0.1, brake: sim.speed > target + 0.1, left: false, right: false };
    };
  }

  function crawlerInput(sim) {
    if (sim.phase === 'walkaround') sim.skipInspection();
    return { throttle: sim.speed < 0.3, brake: sim.speed > 0.5, left: false, right: false };
  }

  function planFingerprint(sim) {
    return JSON.stringify(sim.plan);
  }

  function actualOverlap(sim, event) {
    const pedestrian = event.pedestrian;
    if (!pedestrian.active || pedestrian.cleared) return false;
    const y = Scene.Constants.CAR_START_Y + sim.distance * Scene.Constants.REVERSE_SCALE;
    return Math.abs(pedestrian.x - sim.x) < 22 && Math.abs(pedestrian.y - y) < 27;
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
      view: sim.view,
      inspection: sim.inspection,
      scoring: sim.scoring,
      events: sim.events.map(function (event) {
        return {
          resolved: event.resolved,
          failed: event.failed,
          attempts: event.attempts,
          scans: event.scans,
          stopDuration: event.stopDuration,
          properStop: event.properStop,
          waitedUntilClear: event.waitedUntilClear,
          earlyStart: event.earlyStart,
          unsafePass: event.unsafePass,
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
        results.push({ name: '[09] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[09] ' + name, passed: false, error: error.message });
      }
    }

    test('09 每局儿童、老人、骑行者各一次，种子完整复现', function () {
      ['same-seed', 0, 37, 'reverse-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(planFingerprint(a) === planFingerprint(b), '种子 ' + seed + ' 的完整计划应复现');
        assert(a.events.length === 3, '每局应有三次短倒车任务');
        ['child', 'elder', 'cyclist'].forEach(function (kind) {
          assert(a.events.filter(function (event) { return event.kind === kind; }).length === 1,
            '种子 ' + seed + ' 应恰好有一个 ' + kind);
        });
        a.events.forEach(function (event) {
          assert(event.startX < 60 || event.startX > 300, '参与者必须从两侧路缘进入');
          assert(event.speed > 0 && event.activateDistance > 0, '参与者行为参数必须有效');
        });
      });
    });

    test('09 语言和玩家输入不改写参与者计划或移动速度', function () {
      const sim = new Scene.Simulation('input-independent');
      const before = planFingerprint(sim);
      sim.start();
      Game.I18N.setLanguage('en');
      for (let frame = 0; frame < 360; frame += 1) sim.step(fullThrottleInput(), FIXED_STEP);
      const event = sim.currentEvent;
      const speed = event.pedestrian.speed;
      const x = event.pedestrian.x;
      sim.step({ throttle: false, brake: true }, FIXED_STEP);
      assert(planFingerprint(sim) === before, '语言和踏板不得改变种子计划');
      assert(event.pedestrian.speed === speed, '玩家输入不得临时提高参与者速度');
      assert(event.pedestrian.x !== x, '参与者应按自己的路线持续移动');
      Game.I18N.setLanguage('zh-CN');
    });

    test('09 绕车只确认当时状态，跳过检查失去 3 分', function () {
      const sim = new Scene.Simulation('walk-around');
      sim.start();
      assert(sim.phase === 'walkaround', '开始后应先绕车');
      for (let frame = 0; frame < 200; frame += 1) sim.step(fullThrottleInput(), FIXED_STEP);
      assert(sim.phase === 'reverse' && sim.currentEvent.inspected, '完整绕车应记为已检查');
      assert(!sim.currentEvent.pedestrian.active, '绕车不能提前激活或清空整局危险');
      sim.distance = 1;
      sim.step({}, FIXED_STEP);
      assert(sim.currentEvent.pedestrian.active, '上车后新的人仍应按距离进入');
      const skipped = new Scene.Simulation('walk-around');
      skipped.start();
      skipped.skipInspection();
      assert(skipped.currentEvent.skippedInspection && !skipped.currentEvent.inspected, '跳过应明确记录');
      skipped.currentEvent.resolved = true;
      assert(Scene.Scoring.eventObservation(skipped.events[0]) <= 7, '跳过绕车不能获得检查分');
    });

    test('09 四种视角使用真实锥形与遮挡，不能从上帝视角泄露答案', function () {
      let cameraMisses = 0;
      let hiddenAtStart = 0;
      ['child', 'elder', 'cyclist'].forEach(function (kind, eventId) {
        const sim = new Scene.Simulation('visibility-' + kind, { eventId: eventId });
        sim.inspection = 1;
        const event = sim.currentEvent;
        event.pedestrian.active = true;
        event.pedestrian.x = event.startX;
        const initial = ['direct', 'camera', 'left', 'right'].map(function (view) {
          return Scene.visibilityFor(sim, event, view);
        });
        if (initial.some(function (visible) { return !visible; })) hiddenAtStart += 1;
        [55, 90, 120, 145, 215, 240, 270, 305].forEach(function (x) {
          event.pedestrian.x = x;
          const visible = ['direct', 'camera', 'left', 'right'].map(function (view) {
            return Scene.visibilityFor(sim, event, view);
          });
          if (visible.some(Boolean) && !visible[1]) cameraMisses += 1;
        });
      });
      assert(hiddenAtStart === 3, '三类事件在起点都应至少受一种视角限制');
      assert(cameraMisses > 0, '应存在其他视角可见、倒车影像仍被遮挡的位置');
      const walk = new Scene.Simulation('walk-visible');
      walk.currentEvent.pedestrian.active = true;
      assert(Scene.visibilityFor(walk, walk.currentEvent, 'camera'), '绕车阶段可亲自观察，不受车内视角限制');
    });

    test('09 疯狂切换视角不能刷有效扫视，只看影像不能满分', function () {
      const sim = new Scene.Simulation('scan-dwell');
      sim.start();
      sim.skipInspection();
      const views = ['direct', 'camera', 'left', 'right'];
      for (let frame = 0; frame < 240; frame += 1) {
        sim.setView(views[frame % views.length]);
        sim.step({}, FIXED_STEP);
      }
      assert(!Scene.scanComplete(sim.currentEvent), '每个视角都只有短暂停留，不应记为有效扫视');
      const cameraOnly = new Scene.Simulation('camera-only');
      cameraOnly.start();
      cameraOnly.skipInspection();
      for (let frame = 0; frame < 120; frame += 1) {
        cameraOnly.setView('camera');
        cameraOnly.step({}, FIXED_STEP);
      }
      cameraOnly.currentEvent.resolved = true;
      assert(Scene.Scoring.eventObservation(cameraOnly.events[0]) < 10, '只看倒车影像不能获得观察满分');
    });

    test('09 200 个防御种子安全完成、观察满分且无必要急刹', function () {
      for (let index = 0; index < 200; index += 1) {
        const sim = run('defensive-' + index, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        assert(sim.status === 'complete', '防御种子 ' + index + ' 应完成，实际为 ' + sim.status);
        assert(result.observation === 30, '防御种子 ' + index + ' 应观察满分，实际 ' + result.observation);
        assert(result.total >= 85 && result.hardBrakes === 0, '防御种子 ' + index + ' 应高分且无急刹：' + result.total);
        assert(sim.elapsed >= 55 && sim.elapsed <= 84, '整局应保持短局节奏，实际 ' + sim.elapsed);
      }
    });

    test('09 100 个持续高速种子在真实重叠前定格', function () {
      for (let index = 0; index < 100; index += 1) {
        const sim = run('fast-' + index, fullThrottleInput);
        assert(sim.status === 'frozen', '持续高速种子 ' + index + ' 应定格，实际为 ' + sim.status);
        const event = sim.events[sim.freezeInfo.eventId];
        assert(!actualOverlap(sim, event), '必须在真实接触前定格，不能先撞再停');
        assert(event.failed && event.attempts === 1, '失败必须保留在当前事件');
      }
    });

    test('09 参与者出现后充分制动能停车，不提前误罚', function () {
      for (let index = 0; index < 40; index += 1) {
        const sim = new Scene.Simulation('brake-enough-' + index);
        sim.start();
        let sawActive = false;
        let guard = 0;
        while (sim.status === 'driving' && sim.eventIndex === 0 && guard++ < 1800) {
          const event = sim.currentEvent;
          let input = fullThrottleInput();
          if (sim.phase === 'reverse') {
            input = { throttle: sim.speed < 4 && !event.pedestrian.active, brake: event.pedestrian.active || sim.speed > 4.2 };
          }
          sim.step(input, FIXED_STEP);
          if (event.pedestrian.active) sawActive = true;
          if (sawActive && event.properStop && sim.speed < 0.3) break;
        }
        assert(sim.status === 'driving' && sawActive && sim.currentEvent.properStop,
          '种子 ' + index + ' 充分制动应安全停稳，实际为 ' + sim.status);
      }
    });

    test('09 低速无接触抢行不伪造碰撞，但安全与观察明显降低', function () {
      const sim = new Scene.Simulation('low-6');
      assert(sim.currentEvent.kind === 'child', '回归种子应固定为儿童事件');
      sim.start();
      let guard = 0;
      while (sim.status === 'driving' && sim.eventIndex === 0 && guard++ < 3000) sim.step(cappedInput(3.6)(sim), FIXED_STEP);
      const event = sim.events[0];
      assert(event.resolved && !event.failed && !actualOverlap(sim, event), '确实无接触通过时不得伪造碰撞');
      assert(event.unsafePass && !Scene.Scoring.eventSafe(event), '有人在通道内时未停稳，安全分应降低');
      assert(Scene.Scoring.eventObservation(event) <= 6, '未停车确认的观察分应明显降低');
    });

    test('09 必要观察和让行效率中性，清空后无故停车恢复计时', function () {
      const sim = new Scene.Simulation('yield-efficiency');
      sim.start();
      sim.skipInspection();
      sim.distance = 1.2;
      const event = sim.currentEvent;
      event.pedestrian.active = true;
      for (let frame = 0; frame < 60; frame += 1) sim.step({ brake: true }, FIXED_STEP);
      assert(event.properStop, '测试应先形成有效停车');
      assert(sim.scoring.efficiencyTime === 0, '人员占用通道时停车不得计入效率分母');
      event.pedestrian.active = false;
      event.pedestrian.cleared = true;
      for (let frame = 0; frame < 60; frame += 1) sim.step({ brake: true }, FIXED_STEP);
      assert(sim.scoring.efficiencyTime > 0.9, '危险解除后继续无故停车应恢复效率计时');
      const scanning = new Scene.Simulation('scan-efficiency');
      scanning.start();
      scanning.skipInspection();
      for (let frame = 0; frame < 30; frame += 1) scanning.step({}, FIXED_STEP);
      assert(scanning.scoring.efficiencyTime === 0, '起步阶段必要组合扫视应效率中性');
    });

    test('09 完全不操作和极慢蠕行都会超时且封顶 69', function () {
      const idle = run('idle-timeout', function () { return {}; });
      const idleResult = Scene.Scoring.summarize(idle, idle.status === 'timeout');
      assert(idle.status === 'timeout' && idleResult.total <= 69, '绕车阶段完全不操作也不能无限停留');
      const crawler = run('crawler-timeout', crawlerInput);
      const result = Scene.Scoring.summarize(crawler, crawler.status === 'timeout');
      assert(crawler.status === 'timeout', '极慢蠕行必须超时');
      assert(result.total <= 69 && result.efficiency < 10, '蠕行不能获得高效率或高总分');
    });

    test('09 重试保留种子与首次失败，历史不重复结算且封顶 59', function () {
      const sim = run('retry-cap', fullThrottleInput);
      assert(sim.status === 'frozen', '先制造一次真实失败');
      const before = planFingerprint(sim);
      const failedId = sim.freezeInfo.eventId;
      sim.retryEvent();
      assert(planFingerprint(sim) === before && sim.events[failedId].failed, '重试必须保留种子和首次失败');
      assert(sim.distance === 0 && sim.phase === 'walkaround', '重试从当前任务绕车前开始');
      run(null, Scene.defensiveInput, null, sim);
      const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
      assert(sim.status === 'complete' && result.total <= 59, '失败后重试完成仍必须封顶 59');
      assert(result.observation <= 30, '重试与已通过事件不得重复结算观察分');
    });

    test('09 正确示范与独立真实 Simulation 逐帧一致，不改正式成绩', function () {
      const official = run('demo-match', fullThrottleInput);
      const eventId = official.freezeInfo.eventId;
      const officialElapsed = official.elapsed;
      const officialEfficiency = official.scoring.efficiencyTime;
      official.startDemo();
      const direct = new Scene.Simulation(official.seed, { eventId: eventId });
      direct.start();
      let frames = 0;
      while (official.status === 'demonstrating' && frames++ < 3000) {
        official.stepDemo(FIXED_STEP);
        direct.step(Scene.defensiveInput(direct), FIXED_STEP);
        if (official.status === 'demonstrating') {
          assert(demoSnapshot(official.demo) === demoSnapshot(direct), '示范第 ' + frames + ' 帧必须与真实模拟一致');
        }
      }
      assert(frames < 3000 && official.status === 'driving', '示范结束应回到当前任务重试');
      assert(official.elapsed === officialElapsed && official.scoring.efficiencyTime === officialEfficiency,
        '示范不得修改正式计时与效率统计');
    });

    test('09 同种子行人复盘可交互且独立，不修改正式成绩', function () {
      const official = run('pedestrian-replay', fullThrottleInput);
      const eventId = official.freezeInfo.eventId;
      const elapsed = official.elapsed;
      const scoring = JSON.stringify(official.scoring);
      const plan = planFingerprint(official);
      official.startPedestrianReplay();
      assert(official.status === 'demonstrating' && official.demo.role === 'pedestrian', '失败后可进入行人复盘');
      assert(official.demo.seed === official.seed && official.demoEventId === eventId, '复盘必须使用同种子同事件');
      let frames = 0;
      let moved = false;
      while (official.status === 'demonstrating' && frames++ < 1800) {
        official.stepDemo(FIXED_STEP, { throttle: true });
        if (official.demo && official.demo.currentEvent && official.demo.currentEvent.pedestrian.x !== official.demo.events[eventId].startX) moved = true;
      }
      assert(frames < 1800 && moved, '行人复盘必须响应移动输入并自动返回');
      assert(official.status === 'driving' && official.elapsed === elapsed && JSON.stringify(official.scoring) === scoring,
        '行人复盘不得改写正式状态或评分');
      assert(planFingerprint(official) === plan, '复盘不得改写原计划');

      const complete = run('result-replay', Scene.defensiveInput);
      const resultElapsed = complete.elapsed;
      complete.startPedestrianReplay();
      for (let frame = 0; frame < 1800 && complete.status === 'demonstrating'; frame += 1) complete.stepDemo(FIXED_STEP, {});
      assert(complete.status === 'complete' && complete.elapsed === resultElapsed, '结算后的复盘应返回原结算');
    });

    test('09 方向微调有边界，30 / 60 / 120Hz 结果一致', function () {
      const steered = new Scene.Simulation('steering');
      steered.start();
      steered.skipInspection();
      for (let frame = 0; frame < 600; frame += 1) steered.step({ right: true, brake: true }, FIXED_STEP);
      assert(steered.x === Scene.Constants.CAR_MAX_X, '方向微调不得让车辆无限离开出口路线');
      const summaries = [30, 60, 120].map(function (hz) {
        const sim = run('reverse-hz', Scene.defensiveInput, hz);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        return [sim.status, result.total, result.observation, result.efficiency, result.hardBrakes,
          sim.events.map(function (event) { return event.pedestrian.x.toFixed(4); }).join(',')].join(':');
      });
      assert(summaries[0] === summaries[1] && summaries[1] === summaries[2],
        '帧率不应改变结果：' + summaries.join(' / '));
    });

    test('09 Renderer 可绘制绕车、四视角、定格、示范与行人复盘', function () {
      const noop = function () {};
      const ctx = {
        clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
        stroke: noop, strokeRect: noop, closePath: noop, setLineDash: noop, save: noop, restore: noop, arc: noop, fill: noop,
        measureText: function (text) { return { width: String(text).length * 7 }; },
        fillText: function (text, x, y) {
          assert(Number.isFinite(x) && Number.isFinite(y), '文字坐标必须有限');
          assert(String(text).indexOf('scene.reversing.') !== 0, '画面不得显示缺失文案键');
        }
      };
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        const sim = new Scene.Simulation('reverse-render');
        Scene.Renderer.render(ctx, sim);
        sim.start();
        sim.skipInspection();
        ['direct', 'camera', 'left', 'right'].forEach(function (view) {
          sim.setView(view);
          sim.currentEvent.pedestrian.active = true;
          Scene.Renderer.render(ctx, sim);
        });
        sim.status = 'frozen';
        sim.freezeInfo = { eventId: 0, speed: 5 };
        Scene.Renderer.render(ctx, sim);
        sim.startDemo();
        Scene.Renderer.render(ctx, sim);
        sim.status = 'frozen';
        sim.freezeInfo = { eventId: 0, speed: 5 };
        sim.startPedestrianReplay();
        Scene.Renderer.render(ctx, sim);
      });
      Game.I18N.setLanguage('zh-CN');
    });

    test('09 新场景、视角、失败、示范与复盘文案均有中英文', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      Object.keys(zh).filter(function (key) { return key.indexOf('scene.reversing.') === 0; }).forEach(function (key) {
        assert(typeof en[key] === 'string', '缺少英文文案 ' + key);
      });
      Object.keys(en).filter(function (key) { return key.indexOf('scene.reversing.') === 0; }).forEach(function (key) {
        assert(typeof zh[key] === 'string', '缺少中文文案 ' + key);
      });
      const sim = run('reverse-i18n', Scene.defensiveInput);
      ['zh-CN', 'en'].forEach(function (lang) {
        Game.I18N.setLanguage(lang);
        const coach = Scene.ui.coach(sim, 4);
        const result = Scene.Scoring.summarize(sim, false);
        const eventToast = Scene.ui.eventToast(sim.events[0]);
        [coach.text, coach.status, Game.I18N.t(result.titleKey), Game.I18N.t(result.summaryKey),
          Game.I18N.t(result.adviceKey), Game.I18N.t(eventToast.key, eventToast.params)].forEach(function (text) {
          assert(String(text).indexOf('scene.reversing.') !== 0, lang + ' 不应显示未翻译键：' + text);
        });
      });
      Game.I18N.setLanguage('zh-CN');
    });

    test('09 目录保留 EP.03 隐藏、EP.05 真实入口、EP.08 开门与 EP.09 倒车可玩', function () {
      const episodes = {};
      Game.CATALOG.forEach(function (game) {
        assert(!episodes[game.episode], '编号重复：' + game.episode);
        episodes[game.episode] = true;
      });
      const hidden = Game.CATALOG.find(function (game) { return game.id === 'sudden-braking'; });
      const dooring = Game.CATALOG.find(function (game) { return game.id === 'dooring'; });
      const current = Game.CATALOG.find(function (game) { return game.id === 'reversing-blind-spot'; });
      const visible = Game.CATALOG.filter(function (game) { return game.status !== 'hidden'; });
      assert(hidden && hidden.status === 'hidden', 'EP.03 不得因新目录重新展示');
      assert(dooring && dooring.episode === '08' && dooring.status === 'playable', '现有 EP.08 开门场景不得被覆盖');
      assert(current && current.episode === '09' && current.status === 'playable' &&
        current.href === 'reversing-blind-spot.html', 'EP.09 应有真实入口');
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

  root.ReversingBlindSpotTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
