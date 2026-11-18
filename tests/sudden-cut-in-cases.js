(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['sudden-cut-in'];
  const STEP = 1 / 60;
  const TEST_PLANS = Object.create(null);

  function planFor(seed) {
    const key = String(seed);
    if (!TEST_PLANS[key]) TEST_PLANS[key] = Scene.createPlan(seed);
    return TEST_PLANS[key];
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function eventIdFor(seed, template) {
    return planFor(seed).events.findIndex(function (event) { return event.template === template; });
  }

  function run(seed, controller, hz, existing, maxFrames) {
    const sim = existing || new Scene.Simulation(seed, { plan: planFor(seed) });
    if (sim.status === 'ready') sim.start();
    const frame = 1 / (hz || 60);
    let accumulator = 0;
    let guard = 0;
    const limit = maxFrames || 14000;
    while (sim.status === 'driving' && guard < limit) {
      accumulator += frame;
      while (accumulator + 1e-12 >= STEP && sim.status === 'driving') {
        sim.step(controller(sim), STEP);
        accumulator -= STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    assert(guard < limit, '模拟不应卡死：' + seed);
    return sim;
  }

  function runEvent(seed, eventId, controller, maxSteps, allowLimit) {
    const sim = new Scene.Simulation(seed, { plan: planFor(seed), eventId: eventId });
    sim.start();
    const policy = controller || Scene.defensiveInput;
    let steps = 0;
    const limit = maxSteps || 6200;
    while (sim.status === 'driving' && !sim.events[eventId].resolved && steps < limit) {
      sim.step(policy(sim), STEP);
      steps += 1;
    }
    assert(allowLimit || steps < limit, '事件模拟不应卡死：' + seed + '/' + eventId);
    return sim;
  }

  function runClose(seed, controller) {
    return runEvent(seed, eventIdFor(seed, 'close-merge'), controller);
  }

  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status,
      elapsed: sim.elapsed,
      distance: sim.distance,
      speed: sim.speed,
      eventIndex: sim.eventIndex,
      player: sim.player,
      scoring: sim.scoring,
      events: sim.events
    });
  }

  function fullThrottle() {
    return { throttle: true, brake: false };
  }

  function noBrake(sim) {
    return { throttle: sim.speed < 46.5, brake: false };
  }

  function cuePanicBrake(sim) {
    const event = sim.currentEvent;
    if (event && event.cueVisible) return { throttle: false, brake: sim.speed > 0.2 };
    return Scene.defensiveInput(sim);
  }

  function earlyCloseController(sim) {
    const event = sim.currentEvent;
    if (event && event.fullyInLaneAt != null && !event.resolved) {
      return { throttle: true, brake: false };
    }
    return Scene.defensiveInput(sim);
  }

  function freezeWithThrottle(seed) {
    const id = eventIdFor(seed, 'close-merge');
    const sim = runEvent(seed, id, fullThrottle, 4200);
    assert(sim.status === 'frozen' && sim.freezeInfo, '持续封堵应在接触前定格：' + seed);
    const event = sim.events[id];
    assert(Game.Scenes['sudden-cut-in'].Geometry.obbClearance(sim.player, event.merger) > 0,
      '定格必须发生在真实车身接触之前');
    return sim;
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

  function translationExists(key) {
    return Game.I18N.dictionaries.zh[key] != null && Game.I18N.dictionaries.en[key] != null;
  }

  function runTests(options) {
    options = options || {};
    const results = [];
    function test(name, fn) {
      if (options.filter && !options.filter(name)) return;
      try {
        fn();
        results.push({ name: '[14] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[14] ' + name, passed: false, error: error.message });
      }
      if (options.onResult) options.onResult(results[results.length - 1]);
    }

    test('14 三类事件各一次，同种子完整复现且输入和语言不改计划', function () {
      [0, 1, 41, 'cut-in-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子必须生成相同计划');
        assert(a.events.map(function (event) { return event.template; }).sort().join(',') ===
          'close-merge,merge-and-brake,normal-merge', '每局必须包含三类事件');
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 90; frame += 1) a.step(fullThrottle(), STEP);
        assert(JSON.stringify(a.plan) === before, '踏板和语言不得改写 NPC 计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('14 横向轨迹连续、首尾速度为零且偏航平滑回正', function () {
      for (let seed = 1; seed <= 30; seed += 1) {
        Scene.createPlan(seed).events.forEach(function (plan) {
          const trajectory = new Scene.MergerTrajectory(plan);
          const start = plan.merger.mergeStartTime - plan.merger.driftDuration;
          const end = plan.merger.mergeStartTime + plan.merger.mergeDuration;
          const initial = trajectory.evaluate(start, plan.merger.initialSpeed);
          const settled = trajectory.evaluate(end, plan.merger.initialSpeed);
          assert(Math.abs(initial.x - plan.merger.initialX) < 1e-8 && Math.abs(initial.vx) < 1e-8,
            '漂移必须从相邻车道中心连续开始');
          assert(Math.abs(settled.x - plan.merger.targetX) < 1e-8 && Math.abs(settled.vx) < 1e-8 &&
            Math.abs(settled.yaw) < 1e-8, '并线结束必须连续回正');
          const before = trajectory.evaluate(plan.merger.mergeStartTime - 1e-5, plan.merger.initialSpeed);
          const after = trajectory.evaluate(plan.merger.mergeStartTime + 1e-5, plan.merger.initialSpeed);
          assert(Math.abs(before.x - after.x) < 0.001 && Math.abs(before.vx - after.vx) < 0.01,
            'DRIFTING 与 MERGING 接缝不得横跳');
        });
      }
    });

    test('14 有偏航 OBB 使用分离轴检测角部接触和净间距', function () {
      const player = { x: 0, s: 0, width: 1.8, length: 4.35, yaw: 0 };
      const rotated = { x: 1.65, s: 1.5, width: 1.8, length: 4.3, yaw: Math.PI / 4 };
      const separated = { x: 7, s: 0, width: 1.8, length: 4.3, yaw: Math.PI / 4 };
      assert(Scene.Geometry.obbIntersects(player, rotated), '旋转车身的真实角部接触必须可检测');
      assert(!Scene.Geometry.obbIntersects(player, separated), '分离 OBB 不得误判接触');
      assert(Scene.Geometry.obbClearance(player, separated) > 3.9 && Scene.Geometry.obbClearance(player, separated) < 4,
        '净间距必须来自真实多边形');
      assert(Scene.Geometry.frontGap(player, { x: 0, s: 10, width: 1.8, length: 4, yaw: 0 }) > 5.7 &&
        Scene.Geometry.frontGap(player, { x: 0, s: 10, width: 1.8, length: 4, yaw: 0 }) < 6,
      '前距必须使用前后保险杠而非中心距');
    });

    test('14 200 个防御种子安全完成、观察满分且无危险近距或急刹', function () {
      for (let seed = 1; seed <= 200; seed += 1) {
        const sim = run(seed, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '防御种子 ' + seed + ' 应完成：' + sim.status + '/' + sim.eventIndex);
        assert(result.observation === 30 && result.safety === 40 && result.total >= 85,
          '防御种子 ' + seed + ' 得分异常：' + result.total + '/' + result.observation);
        assert(result.hardBrakes === 0 && sim.scoring.rushPenalties === 0,
          '正确防御不得依赖急刹或封堵');
        sim.events.forEach(function (event) {
          assert(!event.failed && !event.nearConflict && event.gapRecoveredAt != null,
            '防御种子 ' + seed + ' 的每个事件都应安全恢复空间');
        });
      }
    });

    test('14 左、右并线各 100 个事件均通过同一可解性门槛', function () {
      let left = 0;
      let right = 0;
      for (let seed = 1; seed <= 500 && (left < 100 || right < 100); seed += 1) {
        const plan = planFor(seed);
        plan.events.forEach(function (event) {
          const side = event.side;
          if ((side === 'left' && left >= 100) || (side === 'right' && right >= 100)) return;
          const sim = runEvent(seed, event.id);
          const record = sim.events[event.id];
          assert(record.resolved && !record.failed && !record.nearConflict && record.observation === 10,
            side + ' 并线种子 ' + seed + '/' + event.id + ' 未通过防御门槛');
          if (side === 'left') left += 1;
          else right += 1;
        });
      }
      assert(left >= 100 && right >= 100, '采样必须覆盖左右各 100 个事件');
    });

    test('14 合理并线保持平稳即可满分，无必要制动不是防御加分项', function () {
      for (let seed = 1; seed <= 60; seed += 1) {
        const id = eventIdFor(seed, 'normal-merge');
        const sim = runEvent(seed, id, function (current) {
          const input = Scene.defensiveInput(current);
          input.brake = false;
          return input;
        });
        const event = sim.events[id];
        assert(event.resolved && event.observation === 10 && !event.failed,
          '合理并线不制动路径应安全满分：' + seed);
        assert(!event.unnecessaryBrakeRecorded && sim.scoring.hardBrakes === 0,
          '合理并线稳定保持不得被记为过度制动');
      }
    });

    test('14 100 个持续全油门种子不能普遍通过且封堵留下独立记录', function () {
      let marked = 0;
      for (let seed = 1; seed <= 100; seed += 1) {
        const sim = run(seed, fullThrottle);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        const risky = sim.status === 'frozen' || sim.events.some(function (event) {
          return event.blockingAcceleration || event.nearConflict;
        });
        if (risky) marked += 1;
        assert(sim.status !== 'complete' || result.total < 85, '永远加速不得获得稳定高分：' + seed);
      }
      assert(marked >= 70, '持续加速应在大多数种子中形成真实封堵、近距或失败，而非仅口头提示');
    });

    test('14 100 个全程不制动种子不能靠固定策略稳定高分', function () {
      let poor = 0;
      for (let seed = 1; seed <= 100; seed += 1) {
        const sim = run(seed, noBrake);
        const result = Scene.Scoring.summarize(sim, sim.status === 'timeout');
        if (sim.status !== 'complete' || result.total < 85 || result.safety < 40) poor += 1;
      }
      assert(poor >= 45, '不制动固定策略不应在近距及二次减速事件中普遍安全高分');
    });

    test('14 合理并线见前兆就重刹会损失平稳和效率', function () {
      for (let seed = 1; seed <= 50; seed += 1) {
        const id = eventIdFor(seed, 'normal-merge');
        const sim = runEvent(seed, id, cuePanicBrake, 1800, true);
        const event = sim.events[id];
        assert(event.unnecessaryBrakeRecorded || sim.scoring.unnecessaryBrakes > 0 || sim.scoring.hardBrakes > 0,
          '合理并线无必要重刹必须被记录：' + seed);
        assert(Scene.Scoring.smoothScore(sim.scoring) < 10 || sim.scoring.efficiencyIntegral < sim.scoring.efficiencyTime,
          '过度反应不得同时保持满平稳与满效率');
      }
    });

    test('14 并线后未稳定就加速贴回会丢失空间恢复评价', function () {
      let recorded = 0;
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = eventIdFor(seed, 'close-merge');
        const sim = runEvent(seed, id, earlyCloseController, 3000, true);
        const event = sim.events[id];
        if (event.earlyThrottleAfterMerge || sim.status === 'frozen') {
          recorded += 1;
          if (event.resolved) assert(event.observation < 10 || event.failed,
            '实际提前贴回不得获得完整观察分：' + seed);
        }
      }
      assert(recorded >= 80, '贴回策略应普遍形成可解释的提前加速记录或冲突：' + recorded + '/100');
    });

    test('14 输入感知预测区分当前加速与充分制动的可避免边界', function () {
      const sim = new Scene.Simulation('avoidable-cut-in', { eventId: eventIdFor('avoidable-cut-in', 'close-merge') });
      const event = sim.currentEvent;
      sim.start();
      event.localTime = event.merger.mergeStartTime + event.merger.mergeDuration + 0.5;
      event.fullyInLaneAt = event.localTime;
      event.merger.x = 0;
      event.merger.yaw = 0;
      event.merger.s = sim.player.s + 13;
      event.merger.v = 6;
      event.merger.targetSpeed = 6;
      sim.player.v = 16;
      sim.speed = sim.player.v * 3.6;
      event.originalLead.s = sim.player.s + 100;
      const current = Scene.predictMergeConflict(sim, { throttle: true });
      assert(current && current.time > 0, '当前加速外推应发现未来接触');
      const avoidance = Scene.predictMergeConflict(sim, { brake: true },
        { fullBrake: true, horizon: Scene.Constants.AVOIDANCE_HORIZON });
      assert(!avoidance, '充分制动能避免接触时不得宣称不可避');
      sim.step({ throttle: true }, STEP);
      assert(sim.status === 'driving', '可避免冲突不得提前定格');
    });

    test('14 动态空间必须持续稳定，一帧距离达标不等于恢复', function () {
      const sim = new Scene.Simulation('space-dwell', { eventId: eventIdFor('space-dwell', 'close-merge') });
      sim.start();
      const event = sim.currentEvent;
      event.localTime = event.merger.mergeStartTime + event.merger.mergeDuration;
      event.fullyInLaneAt = event.localTime;
      event.merger.x = 0;
      event.merger.s = sim.player.s + 45;
      event.merger.v = sim.player.v;
      sim.lastInput = {};
      const first = Scene.assessSpace(sim, event);
      assert(first.gap > first.requiredGap && event.gapRecoveredAt == null,
        '单帧大间距不能直接写入恢复时间');
      assert(first.state !== 'stable' || event.stableDwell >= Scene.Constants.STABLE_DWELL,
        'STABLE 必须来自持续确认');
    });

    test('14 必要让速退出效率分子分母，安全后过度低速恢复计时', function () {
      for (let seed = 1; seed <= 40; seed += 1) {
        const sim = runClose(seed);
        const result = Scene.Scoring.summarize(sim, false);
        assert(sim.scoring.yieldExemptTime > 0, '近距事件的合理让速必须存在效率豁免：' + seed);
        assert(result.efficiencyRaw >= 17, '必要让速不应遭受不成比例效率处罚：' + seed + '/' + result.efficiencyRaw);
      }
      const sim = new Scene.Simulation('over-yield-clock', { eventId: eventIdFor('over-yield-clock', 'close-merge') });
      sim.start();
      let recoveredAt = null;
      let efficiencyAtRecovery = null;
      for (let frame = 0; frame < 2400 && sim.status === 'driving'; frame += 1) {
        const event = sim.currentEvent;
        if (event && event.gapRecoveredAt != null && recoveredAt == null) {
          recoveredAt = sim.elapsed;
          efficiencyAtRecovery = sim.scoring.efficiencyTime;
        }
        const input = recoveredAt == null ? Scene.defensiveInput(sim) : { brake: sim.speed > 1 };
        sim.step(input, STEP);
        if (recoveredAt != null && sim.elapsed - recoveredAt > 4) break;
      }
      assert(recoveredAt != null && sim.scoring.efficiencyTime > efficiencyAtRecovery + 1,
        '空间恢复后继续无故低速必须恢复效率计时');
    });

    test('14 不动会超时且总分封顶 69', function () {
      for (let seed = 1; seed <= 12; seed += 1) {
        const sim = run(seed, function () { return {}; });
        assert(sim.status === 'timeout', '长期不响应车流应超时：' + seed);
        assert(Scene.Scoring.summarize(sim, true).total <= 69, '超时总分不得超过 69');
      }
    });

    test('14 当前事件重试恢复同一快照并保留首次失败 59 封顶', function () {
      const sim = freezeWithThrottle('retry-cut-in');
      const id = sim.freezeInfo.eventId;
      const planBefore = JSON.stringify(sim.plan);
      const failedScoring = JSON.stringify(sim.scoring);
      sim.retryEvent();
      assert(sim.status === 'driving' && sim.eventIndex === id && sim.currentEvent.failed &&
        sim.currentEvent.attempts === 1, '重试必须定位当前事件并保留失败');
      assert(JSON.stringify(sim.plan) === planBefore && sim.currentEvent.localTime === 0 &&
        sim.player.s === sim.currentEvent.approachStartS, '重试必须恢复相同接近段与交通计划');
      assert(JSON.stringify(sim.scoring) !== failedScoring || sim.currentEvent.failed,
        '评分快照与永久失败标记不得互相覆盖');
      const formalBefore = snapshot(sim);
      sim.startDemo();
      const reference = new Scene.Simulation(sim.seed, { eventId: id });
      reference.start();
      for (let frame = 0; frame < 180 && sim.status === 'demonstrating'; frame += 1) {
        sim.stepDemo(STEP);
        if (sim.demo) {
          reference.step(Scene.defensiveInput(reference), STEP);
          assert(snapshot(sim.demo) === snapshot(reference), '示范必须与独立同种子真实 Simulation 逐帧一致');
        }
      }
      const result = Scene.Scoring.summarize(sim, false);
      assert(sim.events[id].failed && result.total <= 59, '示范和重试均不得清除首次失败封顶');
      assert(sim.status === 'demonstrating' || sim.status === 'driving', '示范结束应返回当前事件驾驶');
      if (sim.status === 'driving') {
        assert(snapshot(sim) === formalBefore, '示范结束后必须精确恢复重试时的正式模拟');
      } else {
        const formalDuring = JSON.parse(snapshot(sim));
        formalDuring.status = 'driving';
        assert(JSON.stringify(formalDuring) === formalBefore, '示范期间不得推进正式模拟');
      }
    });

    test('14 30 / 60 / 120Hz 下最终物理、记录和评分一致', function () {
      for (let seed = 1; seed <= 12; seed += 1) {
        const at30 = run(seed, Scene.defensiveInput, 30);
        const at60 = run(seed, Scene.defensiveInput, 60);
        const at120 = run(seed, Scene.defensiveInput, 120);
        assert(snapshot(at30) === snapshot(at60) && snapshot(at60) === snapshot(at120),
          '渲染采样频率不得改变固定步长结果：' + seed);
      }
    });

    test('14 暂停推进被禁止，恢复后时间轴连续', function () {
      const sim = new Scene.Simulation('pause-cut-in');
      sim.start();
      for (let frame = 0; frame < 60; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      sim.status = 'paused';
      const before = snapshot(sim);
      sim.step({ throttle: true }, STEP);
      assert(snapshot(sim) === before, '暂停不得推进车辆、轨迹、评分或计时');
      sim.status = 'driving';
      sim.step(Scene.defensiveInput(sim), STEP);
      assert(sim.elapsed > JSON.parse(before).elapsed, '恢复后必须沿原时间轴继续');
    });

    test('14 Renderer 可画正常、定格和真实示范，正常 HUD 不泄露未来计划', function () {
      const sim = new Scene.Simulation('render-cut-in');
      sim.start();
      Scene.Renderer.render(mockContext(), sim);
      const coach = Scene.ui.coach(sim, sim.speed);
      assert(coach.text.indexOf('merge-and-brake') < 0 && coach.text.indexOf('normal-merge') < 0 &&
        coach.text.indexOf('close-merge') < 0, '正常 HUD 不得泄露事件模板');
      assert(sim.currentEvent.originalLead.brakePlan.startTime == null || !sim.currentEvent.originalLead.braking,
        '开局不得把未来制动计划当成当前线索');
      const failed = freezeWithThrottle('render-frozen-cut-in');
      Scene.Renderer.render(mockContext(), failed);
      failed.startDemo();
      for (let frame = 0; frame < 30; frame += 1) failed.stepDemo(STEP);
      if (failed.status === 'demonstrating') Scene.Renderer.render(mockContext(), failed);
    });

    test('14 中英文键完整且语言切换不改变模拟', function () {
      [
        'scene.cutIn.hud.progress', 'scene.cutIn.hud.cruise', 'scene.cutIn.hud.cueLeft',
        'scene.cutIn.hud.cueRight', 'scene.cutIn.hud.compressed', 'scene.cutIn.hud.leadBrake',
        'scene.cutIn.hud.stable', 'scene.cutIn.hud.overYield', 'scene.cutIn.canvas.stable',
        'scene.cutIn.failure.side', 'scene.cutIn.failure.rear', 'scene.cutIn.failure.block',
        'scene.cutIn.demo.observe', 'scene.cutIn.demo.yield', 'scene.cutIn.demo.recover',
        'scene.cutIn.result.summary.a', 'scene.cutIn.result.advice.default'
      ].forEach(function (key) { assert(translationExists(key), '缺少中英文文案：' + key); });
      const sim = new Scene.Simulation('language-cut-in');
      sim.start();
      const before = snapshot(sim);
      Game.I18N.setLanguage('en');
      Scene.ui.progress(sim);
      Scene.ui.coach(sim, sim.speed);
      Game.I18N.setLanguage('zh-CN');
      assert(snapshot(sim) === before, '语言切换不得改变种子、车辆、踏板或评分');
      ['cruise', 'cue', 'braking', 'stable'].forEach(function (phase) {
        sim.currentEvent.cueVisible = phase === 'cue';
        sim.currentEvent.merger.braking = phase === 'braking';
        sim.currentEvent.originalLead.braking = false;
        sim.currentEvent.gapRecoveredAt = phase === 'stable' ? 1 : null;
        sim.currentEvent.gapState = phase === 'stable' ? 'stable' : 'unstable';
        const state = Scene.ui.coach(sim, sim.speed);
        assert(state.text !== state.status && state.text.length > 0 && state.status.length > 0,
          '驾驶提示必须可双语显示：' + phase);
        assert(state.text.indexOf('scene.cutIn.') !== 0 && state.status.indexOf('scene.cutIn.') !== 0,
          'UI 返回了未翻译键：' + phase + ' / ' + state.text + ' / ' + state.status);
      });
    });

    test('14 目录注册 EP14、正确页面和可玩状态', function () {
      const entry = Game.CATALOG.find(function (item) { return item.id === 'sudden-cut-in'; });
      assert(entry && entry.episode === '14' && entry.href === 'sudden-cut-in.html' && entry.status === 'playable',
        '目录必须注册 EP14 sudden-cut-in.html');
      assert(Scene.id === 'sudden-cut-in' && Scene.ui && Scene.defensiveInput && Scene.Simulation && Scene.Scoring,
        '场景包公开接口不完整');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.SuddenCutInTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
