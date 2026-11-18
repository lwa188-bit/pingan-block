(function (root) {
  'use strict';

  if (typeof module !== 'undefined' && module.exports && !root.BusGame) {
    ['../js/i18n.js', '../js/catalog.js', '../js/model.js', '../js/draw.js', '../js/scoring.js', '../js/scenes/revealed-stopped-vehicle.js'].forEach(function (file) { require(file); });
  }

  const Game = root.BusGame;
  const Scene = Game.Scenes['revealed-stopped-vehicle'];
  const STEP = 1 / 60;

  function assert(condition, message) { if (!condition) throw new Error(message); }
  function inputFor(sim, controller) { return controller ? controller(sim) : Scene.defensiveInput(sim); }
  function run(seed, controller, hz, options) {
    const sim = new Scene.Simulation(seed, options);
    sim.start();
    const frame = 1 / (hz || 60);
    let accumulator = 0;
    let guard = 0;
    while (sim.status === 'driving' && guard < 10000) {
      accumulator += frame;
      while (accumulator >= STEP && sim.status === 'driving') {
        sim.step(inputFor(sim, controller), STEP);
        accumulator -= STEP;
      }
      guard += 1;
      if (hz == null) accumulator = 0;
    }
    assert(guard < 10000, '模拟不应卡死');
    return sim;
  }
  function runEvent(seed, eventId, controller) {
    const sim = new Scene.Simulation(seed, { eventId: eventId });
    sim.start();
    let guard = 0;
    while (sim.status === 'driving' && !sim.events[eventId].resolved && guard < 5000) {
      sim.step(inputFor(sim, controller), STEP);
      guard += 1;
    }
    assert(guard < 5000, '单事件不应卡死');
    return sim;
  }
  function eventId(seed, template) {
    return Scene.createPlan(seed).events.findIndex(function (event) { return event.template === template; });
  }
  function hazardId(seed) {
    const plan = Scene.createPlan(seed);
    return plan.events.findIndex(function (event) { return event.stoppedVehicle.enabled; });
  }
  function snapshot(sim) {
    return JSON.stringify({
      status: sim.status, distance: sim.distance, speed: sim.speed, elapsed: sim.elapsed,
      scoring: sim.scoring, transitionCount: sim.transitionCount,
      events: sim.events.map(function (event) {
        return {
          id: event.id, elapsed: event.elapsed, leader: event.leader, stopped: event.stopped,
          visibility: event.visibility, cueVisibleAt: event.cueVisibleAt,
          stoppedFirstVisibleAt: event.stoppedFirstVisibleAt,
          stoppedStableVisibleAt: event.stoppedStableVisibleAt,
          clearLaneConfirmedAt: event.clearLaneConfirmedAt,
          properEarlyControl: event.properEarlyControl, preparation: event.preparation,
          brakingStartAt: event.brakingStartAt, stoppedAt: event.stoppedAt,
          minimumLeaderGap: event.minimumLeaderGap, minimumStoppedGap: event.minimumStoppedGap,
          revealMargin: event.revealMargin, closeStop: event.closeStop, farStop: event.farStop,
          prematureStop: event.prematureStop, matchedAction: event.matchedAction, timelyResume: event.timelyResume,
          failed: event.failed, resolved: event.resolved, observation: event.observation
        };
      })
    });
  }
  function mockContext() {
    const noop = function () {};
    return new Proxy({ measureText: function (text) { return { width: String(text).length * 7 }; } }, {
      get: function (target, property) { return property in target ? target[property] : noop; },
      set: function (target, property, value) { target[property] = value; return true; }
    });
  }
  function makeFailure(seed, id) {
    return runEvent(seed, id, function () { return { throttle: true }; });
  }

  function runTests() {
    const results = [];
    function test(name, fn) {
      try { fn(); results.push({ name: '[16] ' + name, passed: true }); }
      catch (error) { results.push({ name: '[16] ' + name, passed: false, error: error.message }); }
    }

    test('16 三类事件完整复现，静止车从计划开始存在，畅通段不生成假车', function () {
      ['same', 0, 42, 'g16-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '同一种子应完整复现');
        assert(a.plan.events.map(function (event) { return event.template; }).sort().join(',') === 'clear-reveal,early-reveal,late-reveal', '每局三类事件各一次');
        a.plan.events.forEach(function (plan, index) {
          assert(plan.stoppedVehicle.enabled === (plan.template !== 'clear-reveal'), '静止车事实应与模板一致');
          assert(a.events[index].stopped === null || a.events[index].stopped.s === plan.stoppedVehicle.s, '静止车必须从起点就存在');
        });
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 120; frame += 1) a.step({ throttle: true }, STEP);
        Game.I18N.setLanguage('zh-CN');
        assert(JSON.stringify(a.plan) === before, '输入和语言不得改变计划');
      });
    });

    test('16 线段遮挡覆盖端点、平行、零长和近 miss', function () {
      const intersects = Scene.Geometry.segmentIntersectsAABB;
      const box = { left: -1, right: 1, bottom: 4, top: 8 };
      assert(intersects(0, 0, 0, 10, box), '中心视线应被遮挡');
      assert(intersects(-3, 4, 3, 4, box), '端点接触应计入遮挡');
      assert(!intersects(2, 0, 2, 10, box), '平行近 miss 不应遮挡');
      assert(intersects(0, 5, 0, 5, box), '遮挡体内零长线段应成立');
      assert(!intersects(0, 0, 0, 3, box), '遮挡体前结束不应相交');
    });

    test('16 转向灯先于横向移动，变道连续且不与静止车重叠', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = hazardId(seed);
        const sim = new Scene.Simulation(seed, { eventId: id });
        const event = sim.events[id];
        Scene.updateLeader(event, event.plan.leader.signalAt - 0.01);
        assert(!event.leader.signal && event.leader.x === 0, '信号前不应提前变道');
        Scene.updateLeader(event, event.plan.leader.signalAt + 0.1);
        assert(event.leader.signal && event.leader.x === 0, '转向灯应先于横向移动');
        let previousX = event.leader.x;
        for (let time = event.plan.leader.laneChangeAt; time < 18; time += 0.025) {
          Scene.updateLeader(event, time);
          assert(Math.abs(event.leader.x - previousX) < 0.12, '横向位置必须连续');
          previousX = event.leader.x;
          if (event.stopped) assert(!Scene.Geometry.rectanglesOverlap({ distance: event.leader.s }, event.stopped) || Math.abs(event.leader.x - event.stopped.x) > 2.5, '前车轨迹不应穿过静止车');
        }
      }
    });

    test('16 真实几何逐渐显露，连续确认不能靠计时器或单帧闪烁', function () {
      const id = hazardId('visibility');
      const sim = new Scene.Simulation('visibility', { eventId: id });
      const event = sim.events[id];
      const initial = Scene.Geometry.visibilityFor(sim, event);
      assert(!initial.visible, '初始关键目标应被前车真实遮挡');
      const frozenLeader = event.leader.s;
      sim.elapsed += 20;
      event.elapsed += 20;
      assert(Scene.Geometry.visibilityFor(sim, event).visibleSamples === initial.visibleSamples && event.leader.s === frozenLeader, '只增加时间不得自动显露');
      sim.start();
      let sawPartial = false;
      while (!event.stoppedStableVisibleAt && sim.status === 'driving') {
        sim.step(Scene.defensiveInput(sim), STEP);
        if (event.visibility.visible && !event.visibility.stableVisible) sawPartial = true;
        assert(event.stoppedStableVisibleAt == null || event.visibility.continuousVisibleTime >= Scene.Constants.STABLE_VISIBLE_TIME, '稳定识别必须有连续可见时间');
      }
      assert(event.stoppedFirstVisibleAt != null && event.stoppedStableVisibleAt > event.stoppedFirstVisibleAt, '开始可见与稳定识别必须分开');
      assert(sawPartial, '应存在部分显露但尚未稳定确认的过程');
    });

    test('16 200 个防御种子安全完成、观察满分且无预防性急刹', function () {
      for (let seed = 1; seed <= 200; seed += 1) {
        const sim = run(seed);
        const score = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '防御策略应完成，种子 ' + seed + '：' + sim.status);
        assert(score.total >= 85 && score.observation === 30, '防御策略应高评价，种子 ' + seed + '：' + score.total + '/' + score.observation);
        assert(score.hardBrakes === 0, '防御策略不应依赖急刹，种子 ' + seed);
        assert(sim.events.every(function (event) { return event.resolved && !event.failed; }), '所有事件应安全结算');
      }
    });

    test('16 100 个持续高速种子在真实车身重叠前定格', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = hazardId(seed);
        const sim = runEvent(seed, id, function () { return { throttle: true }; });
        assert(sim.status === 'frozen' && sim.freezeInfo, '持续高速应在危险事件定格，种子 ' + seed);
        const event = sim.events[id];
        assert(!Scene.Geometry.rectanglesOverlap(sim, event.stopped), '不得先与静止车重叠再判罚');
        assert(!Scene.Geometry.rectanglesOverlap(sim, event.leader), '不得先与前车重叠再判罚');
      }
    });

    test('16 100 个紧贴前车种子不能普遍获得观察满分', function () {
      let full = 0;
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = hazardId(seed);
        const sim = runEvent(seed, id, function (current) {
          const event = current.events[id];
          if (event.cueVisibleAt != null) return Scene.defensiveInput(current);
          const gap = Scene.Geometry.leaderGap(current, event);
          return { throttle: gap > 6 && current.speed < 58, brake: gap < 3 && current.speed > 20 };
        });
        if (sim.events[id].observation === 10) full += 1;
        assert(sim.events[id].minimumLeaderGap < 17 || !sim.events[id].preparation, '贴近策略不应获得合理准备分');
      }
      assert(full <= 5, '紧贴策略观察满分数量过多：' + full);
    });

    test('16 100 个较晚显露事件均有充分防御停车余量且必要制动不误罚', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = eventId(seed, 'late-reveal');
        const sim = runEvent(seed, id);
        const event = sim.events[id];
        assert(event.resolved && event.revealMargin >= 8, '较晚显露仍须有充分余量，种子 ' + seed + '：' + event.revealMargin);
        assert(event.observation === 10 && !event.hardBrakeRecorded, '正确防御与必要制动不应被误罚');
      }
    });

    test('16 100 个畅通对照事件确认后及时通过且无需停车', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = eventId(seed, 'clear-reveal');
        const sim = runEvent(seed, id);
        const event = sim.events[id];
        assert(event.stopped === null && event.resolved, '畅通事件从头到尾不得生成假静止车');
        assert(event.clearLaneConfirmedAt != null && event.timelyResume && event.observation === 10, '确认畅通后应及时恢复');
        assert(event.stoppedDwell === 0 && !event.farStop, '正确示范不应依赖停车');
      }
    });

    test('16 100 个显露后充分制动案例不提前失败', function () {
      for (let seed = 1; seed <= 100; seed += 1) {
        const id = hazardId(seed);
        const sim = runEvent(seed, id, function (current) {
          const event = current.events[id];
          if (event.visibility.stableVisible) return { brake: current.speed > 0 };
          return Scene.defensiveInput(current);
        });
        assert(sim.events[id].resolved && sim.status !== 'frozen', '充分制动能停车时不得提前失败，种子 ' + seed);
        assert(Scene.Geometry.stoppedGap(sim, sim.events[id]) > 0, '停车后仍应保持真实间距');
      }
    });

    test('16 见转向灯就重刹与只在显露后制动都不能获得稳定高评价', function () {
      for (let seed = 1; seed <= 30; seed += 1) {
        const panic = run(seed, function (sim) {
          const event = sim.currentEvent;
          if (!event) return {};
          if (event.clearLaneConfirmedAt != null) return { throttle: sim.speed < 48 };
          if (event.cueVisibleAt != null) return { brake: sim.speed > 0 };
          return { throttle: sim.speed < 48 };
        });
        assert(Scene.Scoring.summarize(panic, panic.status === 'timeout').total < 85, '见变道就重刹不得高分，种子 ' + seed);
        const late = run(seed, function (sim) {
          const event = sim.currentEvent;
          if (event && event.visibility.stableVisible) return { brake: sim.speed > 0 };
          return { throttle: sim.speed < 48 };
        });
        if (late.status === 'complete') assert(Scene.Scoring.summarize(late, false).observation < 30, '只看显露不得获得完整观察分');
      }
    });

    test('16 过远停车安全但行动降分，过近停车无接触不伪造碰撞', function () {
      const farId = hazardId('far-stop');
      const far = runEvent('far-stop', farId, function (sim) {
        const event = sim.events[farId];
        if (event.visibility.stableVisible) return { brake: sim.speed > 0 };
        return Scene.defensiveInput(sim);
      });
      assert(far.events[farId].resolved && far.events[farId].farStop && !far.events[farId].failed, '过远停车应安全完成');
      assert(far.events[farId].observation < 10, '过远停车不应获得完整行动分');

      const id = hazardId('close-stop');
      const sim = new Scene.Simulation('close-stop', { eventId: id });
      const event = sim.events[id];
      sim.start();
      sim.distance = event.stopped.s - event.stopped.length / 2 - Scene.Constants.PLAYER_LENGTH / 2 - 1.35;
      sim.speed = 4;
      sim.previousSpeed = 4;
      event.elapsed = event.plan.leader.laneChangeAt + event.plan.leader.laneChangeDuration + 1;
      Scene.updateLeader(event, event.elapsed);
      event.cueVisibleAt = 1;
      event.visibility.continuousVisibleTime = 0.5;
      event.visibility.stableVisible = true;
      event.stoppedStableVisibleAt = event.elapsed - 0.2;
      for (let frame = 0; frame < 180 && !event.resolved && sim.status === 'driving'; frame += 1) sim.step({ brake: true }, STEP);
      assert(event.resolved && event.closeStop && !event.failed && sim.status !== 'frozen', '过近但无接触应结算而非伪造碰撞');
      assert(Scene.Geometry.stoppedGap(sim, event) > 0 && !Scene.Scoring.eventSafe(event), '过近停车应保留真实间距并扣安全分');
    });

    test('16 必要停车效率中性，畅通确认后空等恢复计时', function () {
      const id = hazardId('efficiency');
      const sim = new Scene.Simulation('efficiency', { eventId: id });
      sim.start();
      const event = sim.events[id];
      while (!Scene.Scoring.isNecessaryPhase(sim) && sim.status === 'driving' && !event.resolved) sim.step(Scene.defensiveInput(sim), STEP);
      const before = sim.scoring.efficiencyTime;
      for (let frame = 0; frame < 20 && sim.status === 'driving' && !event.resolved; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      assert(sim.scoring.efficiencyTime === before, '真实显露后的必要减速不得计效率损失');
      const clearId = eventId('efficiency', 'clear-reveal');
      const clear = new Scene.Simulation('efficiency', { eventId: clearId });
      clear.start();
      const clearEvent = clear.events[clearId];
      while (clearEvent.clearLaneConfirmedAt == null) clear.step(Scene.defensiveInput(clear), STEP);
      const resumed = clear.scoring.efficiencyTime;
      for (let frame = 0; frame < 60; frame += 1) clear.step({ brake: true }, STEP);
      assert(clear.scoring.efficiencyTime > resumed, '畅通确认后无故停车必须恢复效率计时');
    });

    test('16 50 个不动或低速蠕行种子超时且不超过 69', function () {
      for (let seed = 1; seed <= 50; seed += 1) {
        const idle = run(seed, function () { return { brake: true }; });
        assert(idle.status === 'timeout' && Scene.Scoring.summarize(idle, true).total <= 69, '不动必须超时封顶');
        const creep = run(seed, function (sim) {
          const event = sim.currentEvent;
          let target = 12;
          if (event && event.stopped && event.visibility.visible) {
            const gap = Scene.Geometry.stoppedGap(sim, event) - 8;
            target = Math.min(12, Math.sqrt(Math.max(0, 2 * 3 * gap)) * 3.6);
          }
          return { throttle: sim.speed < target - 0.3, brake: sim.speed > target + 0.3 };
        });
        assert(creep.status === 'timeout' && Scene.Scoring.summarize(creep, true).total <= 69, '蠕行必须超时封顶，种子 ' + seed + '：' + creep.status);
      }
    });

    test('16 当前事件重试保留种子、首次失败与前文成绩且封顶 59', function () {
      const id = hazardId('retry');
      const sim = makeFailure('retry', id);
      assert(sim.status === 'frozen', '需要真实失败');
      sim.retryEvent();
      assert(sim.events[id].failed && sim.events[id].attempts === 1 && !sim.events[id].resolved, '重试必须保留失败并重置当前事件');
      assert(JSON.stringify(sim.plan) === JSON.stringify(Scene.createPlan('retry')), '重试不得重新随机');
      for (let frame = 0; frame < 7000 && sim.status === 'driving'; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      assert(sim.status === 'complete' && Scene.Scoring.summarize(sim, false).total <= 59, '重试后完成仍须封顶 59');
    });

    test('16 三类示范来自独立真实 Simulation 并逐帧一致', function () {
      ['early-reveal', 'late-reveal', 'clear-reveal'].forEach(function (template) {
        const seed = 'demo-' + template;
        const id = eventId(seed, template);
        const official = new Scene.Simulation(seed, { eventId: id });
        official.events[id].failed = true;
        official.events[id].attempts = 1;
        official.freezeInfo = { eventId: id };
        official.status = 'frozen';
        const scoring = JSON.stringify(official.scoring);
        official.startDemo();
        assert(official.demo instanceof Scene.Simulation && official.demo !== official, '示范必须是独立模拟');
        const reference = new Scene.Simulation(seed, { eventId: id });
        reference.start();
        let frames = 0;
        while (official.status === 'demonstrating' && frames < 2500) {
          assert(snapshot(official.demo) === snapshot(reference), template + ' 示范第 ' + frames + ' 帧不一致');
          official.stepDemo(STEP);
          if (official.status === 'demonstrating') reference.step(Scene.defensiveInput(reference), STEP);
          frames += 1;
        }
        assert(frames > 30 && JSON.stringify(official.scoring) === scoring && official.events[id].failed, '示范不得修改正式成绩或首次失败');
        assert(official.status === 'driving' && official.events[id].attempts === 1, '示范结束应回到当前事件重试');
      });
    });

    test('16 双视野复盘不修改正式模拟，可返回失败或结算', function () {
      const id = hazardId('replay');
      const failed = makeFailure('replay', id);
      const before = snapshot(failed);
      failed.startPedestrianReplay();
      assert(failed.demoMode === 'overview' && failed.replayPerspective === 'driver', '复盘默认使用驾驶视野');
      failed.replayPerspective = 'overview';
      for (let frame = 0; frame < 2500 && failed.status === 'demonstrating'; frame += 1) failed.stepDemo(STEP);
      assert(failed.status === 'frozen' && snapshot(failed) === before, '失败复盘结束必须原样返回');
      const complete = run('replay');
      const completeBefore = snapshot(complete);
      complete.startPedestrianReplay();
      complete.finishReplay();
      assert(complete.status === 'complete' && snapshot(complete) === completeBefore, '结算复盘不得修改正式结果');
    });

    test('16 30 / 60 / 120 Hz 的结果、可见性和评分一致', function () {
      const reference = run('fixed-step-reveal', null, 60);
      [30, 120].forEach(function (hz) {
        const current = run('fixed-step-reveal', null, hz);
        assert(snapshot(current) === snapshot(reference), hz + ' Hz 应与 60 Hz 完全一致');
      });
    });

    test('16 Renderer 可绘制遮挡、显露、停车、定格、示范与双视野复盘', function () {
      const ctx = mockContext();
      const id = hazardId('render');
      const sim = new Scene.Simulation('render', { eventId: id });
      Scene.Renderer.render(ctx, sim);
      sim.start();
      for (let frame = 0; frame < 900 && sim.status === 'driving'; frame += 1) {
        sim.step(Scene.defensiveInput(sim), STEP);
        if (frame % 90 === 0) Scene.Renderer.render(ctx, sim);
      }
      const failure = makeFailure('render-failure', hazardId('render-failure'));
      Scene.Renderer.render(ctx, failure);
      failure.startDemo();
      Scene.Renderer.render(ctx, failure);
      failure.startPedestrianReplay();
      Scene.Renderer.render(ctx, failure);
      failure.replayPerspective = 'overview';
      Scene.Renderer.render(ctx, failure);
    });

    test('16 中英文完整、切换语言不改模拟且目录保护既有编号', function () {
      const zh = Game.I18N.dictionaries.zh;
      const en = Game.I18N.dictionaries.en;
      Object.keys(zh).filter(function (key) { return key.indexOf('scene.revealedVehicle.') === 0; }).forEach(function (key) {
        assert(typeof zh[key] === 'string' && zh[key].length > 0, '缺少中文：' + key);
        assert(typeof en[key] === 'string' && en[key].length > 0, '缺少英文：' + key);
      });
      const sim = new Scene.Simulation('language-reveal');
      sim.start();
      for (let frame = 0; frame < 240; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      const before = snapshot(sim);
      Game.I18N.setLanguage('en');
      assert(snapshot(sim) === before && Scene.ui.coach(sim).text.indexOf('scene.revealedVehicle.') !== 0, '英文切换不得改模拟或留下原始键');
      Game.I18N.setLanguage('zh-CN');
      const entry = Game.CATALOG.find(function (item) { return item.id === 'revealed-stopped-vehicle'; });
      assert(entry && entry.episode === '16' && entry.status === 'playable', '目录应注册可玩 EP.16');
      assert(entry.href === 'revealed-stopped-vehicle.html' && entry.art === 'revealed-stopped-vehicle', '入口与插画应完整');
      assert(Game.CATALOG.find(function (item) { return item.episode === '03'; }).status === 'hidden', 'EP.03 必须保持下线');
      ['05', '10', '11', '12', '13', '14', '15'].forEach(function (episode) {
        const item = Game.CATALOG.find(function (candidate) { return candidate.episode === episode; });
        assert(item && item.status === 'playable', '既有 EP.' + episode + ' 不得回退');
      });
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.RevealedStoppedVehicleTests = { run: runTests };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.RevealedStoppedVehicleTests;
    if (require.main === module) {
      const report = runTests();
      report.results.forEach(function (result) { console.log((result.passed ? '✓ ' : '✗ ') + result.name + (result.error ? '\n  ' + result.error : '')); });
      console.log('\n' + report.passed + ' 项通过，' + report.failed + ' 项失败。');
      process.exitCode = report.failed ? 1 : 0;
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
