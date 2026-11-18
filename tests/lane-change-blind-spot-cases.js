(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['lane-change-blind-spot'];
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

  function brakeOnly() {
    return { brake: true };
  }

  function requestTargetLane(sim) {
    const event = sim.currentEvent;
    return {
      left: Boolean(event && event.side === 'left'),
      right: Boolean(event && event.side === 'right'),
      throttle: false,
      brake: false,
      lookLeft: false,
      lookRight: false
    };
  }

  function lookThenChange(holdSeconds, waitSeconds) {
    return function (sim) {
      const input = { left: false, right: false, throttle: false, brake: false, lookLeft: false, lookRight: false };
      const event = sim.currentEvent;
      if (!event || event.resolved) return input;
      if (event.elapsed < holdSeconds) {
        if (event.side === 'left') input.lookLeft = true;
        else input.lookRight = true;
      } else if (event.elapsed >= holdSeconds + waitSeconds) {
        if (event.side === 'left') input.left = true;
        else input.right = true;
      }
      return input;
    };
  }

  function freezeWithImmediateChange(seed) {
    const id = eventIdFor(seed, 'blind-spot-car');
    const sim = runEvent(seed, id, requestTargetLane, 3000);
    assert(sim.status === 'frozen' && sim.freezeInfo, '盲区有车时立即变道应在接触前定格：' + seed);
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

  function mockDoc() {
    return {
      querySelector: function () { return null; },
      getElementById: function () { return null; }
    };
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
        results.push({ name: '[18] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[18] ' + name, passed: false, error: error.message });
      }
      if (options.onResult) options.onResult(results[results.length - 1]);
    }

    test('18 每局包含安全变道、盲区有车、后方快车各一次，同种子完全复现且输入和语言不改计划', function () {
      [0, 1, 41, 'lane-change-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子必须生成相同计划');
        assert(a.events.map(function (event) { return event.template; }).sort().join(',') ===
          'blind-spot-car,clear-change,fast-closing', '每局必须包含三类事件');
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 90; frame += 1) a.step(fullThrottle(), STEP);
        assert(JSON.stringify(a.plan) === before, '踏板和语言不得改写 NPC 计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('18 封闭线、施工路段、目标车道先导车与两类来车都来自固定计划', function () {
      const sides = { left: 0, right: 0 };
      const subtypes = Object.create(null);
      for (let seed = 1; seed <= 40; seed += 1) {
        planFor(seed).events.forEach(function (event) {
          sides[event.side] += 1;
          assert(event.laneWidth === Scene.Constants.LANE_WIDTH, '车道宽度必须来自常量');
          assert(event.closureLineS === 185 && event.segmentEndS === 250,
            '封闭线与路段长度必须固定');
          assert(event.targetTraffic.leadAhead.present &&
            event.targetTraffic.leadAhead.initialCenterS >= 95 &&
            event.targetTraffic.leadAhead.initialCenterS <= 130,
          '目标车道前方必须先有一辆按巡航速度行驶的先导车');
          const conflict = event.targetTraffic.conflict;
          if (event.template === 'clear-change') {
            assert(conflict.kind === 'none', '安全变道事件不得安排目标车道冲突车');
          } else if (event.template === 'blind-spot-car') {
            assert(conflict.kind === 'blind' && conflict.initialCenterS <= -7.5 &&
              conflict.initialCenterS >= -9, '盲区来车必须从后方 7.5 至 9 米处跟随');
            assert(conflict.initialSpeed === event.player.initialSpeed,
              '盲区来车先与玩家同速，再加速通过');
          } else {
            assert(conflict.kind === 'fast' && conflict.subType,
              '后方快车事件必须声明 near / far 子类型');
            subtypes[conflict.subType] = (subtypes[conflict.subType] || 0) + 1;
            if (conflict.subType === 'fast-near') {
              assert(conflict.initialCenterS <= -16 && conflict.initialCenterS >= -22,
                '近距快车必须从 16 至 22 米后方接近');
            } else {
              assert(conflict.initialCenterS <= -28 && conflict.initialCenterS >= -34,
                '远距快车必须从 28 至 34 米后方接近');
            }
          }
        });
      }
      assert(sides.left >= 15 && sides.right >= 15, '计划必须覆盖左右两侧目标车道');
      assert(subtypes['fast-near'] > 0 && subtypes['fast-far'] > 0, '两类后方快车都必须出现');
    });

    test('18 盲区来车在后视镜之外、只能靠回头观察看到', function () {
      for (let seed = 1; seed <= 20; seed += 1) {
        const id = eventIdFor(seed, 'blind-spot-car');
        const sim = new Scene.Simulation(seed, { plan: planFor(seed), eventId: id });
        sim.start();
        const plan = planFor(seed).events[id];
        const car = {
          s: plan.targetTraffic.conflict.initialCenterS,
          x: Scene.Constants.LANE_WIDTH * (plan.side === 'left' ? -1 : 1),
          length: Scene.Constants.CONFLICT_LENGTH
        };
        assert(!Scene.Geometry.mirrorCovers(sim, car), '盲区来车不得被后视镜覆盖：' + seed);
        assert(Scene.Geometry.shoulderCovers(sim, car), '盲区来车必须落在回头观察范围：' + seed);
        const far = { s: -40, x: car.x, length: car.length };
        assert(Scene.Geometry.mirrorCovers(sim, far), '后视镜必须覆盖更远处来车');
      }
    });

    test('18 观察必须按后视镜到回头两段持续停留，短按不算且观察会过期', function () {
      const obs = new Scene.ObservationController({});
      let now = 0;
      for (let frame = 0; frame < 96; frame += 1) {
        now += STEP;
        obs.update(STEP, { lookRight: true }, 'right', now);
      }
      obs.update(STEP, {}, 'right', now + STEP);
      assert(obs.isComplete('right', now + 2 * STEP), '持续回头 1.6 秒必须完成两段观察');
      assert(obs.mirrorDwellMax.right >= Scene.Constants.MIRROR_VALID_DWELL &&
        obs.shoulderDwellMax.right >= Scene.Constants.SHOULDER_VALID_DWELL,
      '两段观察都必须达到有效停留时长');

      const short = new Scene.ObservationController({});
      let shortNow = 0;
      for (let frame = 0; frame < 30; frame += 1) {
        shortNow += STEP;
        short.update(STEP, { lookLeft: true }, 'left', shortNow);
      }
      short.update(STEP, {}, 'left', shortNow + STEP);
      assert(!short.isComplete('left', shortNow), '短按不得视为完成观察');
      assert(short.shoulderEnds.left == null, '未进入回头阶段不得生成回头记录');

      const long = new Scene.ObservationController({});
      let longNow = 0;
      for (let frame = 0; frame < 180; frame += 1) {
        longNow += STEP;
        long.update(STEP, { lookLeft: true }, 'left', longNow);
      }
      assert(long.view === 'front' && long.forcedFront && long.phase === 'none',
        '观察过久必须自动回到前方并锁定本次观察');
      long.update(STEP, {}, 'left', longNow + STEP);
      assert(!long.forcedFront, '松开观察键后才能重新开始观察');

      obs.noteComplete('right', now + 2 * STEP);
      const staleAt = obs.shoulderEnds.right + Scene.Constants.OBS_VALIDITY + 0.1;
      assert(!obs.isComplete('right', staleAt), '超过 2.5 秒的观察不得继续有效');
      assert(obs.everWasComplete('right', staleAt), '历史完成记录必须保留，用于区分“看过但过期”');
    });

    test('18 横向轨迹连续、偏航平滑并在稳定后回正', function () {
      for (let seed = 1; seed <= 12; seed += 1) {
        ['clear-change', 'blind-spot-car', 'fast-closing'].forEach(function (template) {
          const id = eventIdFor(seed, template);
          const sim = new Scene.Simulation(seed, { plan: planFor(seed), eventId: id });
          sim.start();
          const sign = planFor(seed).events[id].side === 'left' ? -1 : 1;
          let previousX = sim.player.x;
          let maxStep = 0;
          let sawMoving = false;
          let steps = 0;
          while (sim.status === 'driving' && !sim.events[id].resolved && steps < 6200) {
            sim.step(Scene.defensiveInput(sim), STEP);
            steps += 1;
            if (sim.laneChange.state === 'MOVING') sawMoving = true;
            maxStep = Math.max(maxStep, Math.abs(sim.player.x - previousX));
            previousX = sim.player.x;
          }
          assert(sim.events[id].resolved, '防御策略必须完成变道：' + seed + '/' + template);
          assert(sawMoving, '必须经历平滑的横向移动阶段');
          assert(maxStep < 0.1, '每帧横向位移必须连续，不得跳变：' + maxStep);
          assert(Math.abs(sim.player.x - sign * Scene.Constants.LANE_WIDTH) < 1e-6,
            '变道完成后必须停在目标车道中心');
          assert(Math.abs(sim.player.yaw) < 1e-6, '变道完成后偏航必须回正');
        });
      }
    });

    test('18 有偏航 OBB 使用分离轴检测角部接触和净间距', function () {
      const player = { x: 0, s: 0, width: 1.8, length: 4.4, yaw: 0 };
      const rotated = { x: 1.65, s: 1.5, width: 1.8, length: 4.4, yaw: Math.PI / 4 };
      const separated = { x: 7, s: 0, width: 1.8, length: 4.4, yaw: Math.PI / 4 };
      assert(Scene.Geometry.obbIntersects(player, rotated), '旋转车身的真实角部接触必须可检测');
      assert(!Scene.Geometry.obbIntersects(player, separated), '分离 OBB 不得误判接触');
      assert(Scene.Geometry.obbClearance(player, separated) > 3.9 &&
        Scene.Geometry.obbClearance(player, separated) < 4,
      '净间距必须来自真实多边形');
    });

    test('18 60 个防御种子安全完成、观察与安全满分且无急刹', function () {
      for (let seed = 1; seed <= 60; seed += 1) {
        const sim = run(seed, Scene.defensiveInput);
        const result = Scene.Scoring.summarize(sim, false);
        assert(sim.status === 'complete', '防御种子 ' + seed + ' 应完成：' + sim.status + '/' + sim.eventIndex);
        assert(result.observation === 30 && result.safety === 40 && result.total >= 85,
          '防御种子 ' + seed + ' 得分异常：' + result.total + '/' + result.observation);
        assert(result.hardBrakes === 0 && sim.scoring.dithering === 0 && sim.scoring.lateAborts === 0,
          '正确防御不得依赖急刹或反复变道请求');
        sim.events.forEach(function (event) {
          assert(event.resolved && event.safe && !event.failed && event.observationScore === 10,
            '防御种子 ' + seed + ' 的每个事件都必须安全且观察满分');
          assert(event.commit && event.commit.mirrorOk && event.commit.shoulderOk &&
            event.commit.safeDecision && event.commit.observationFresh,
          '每次变道决策都必须基于当时有效的后视镜与回头观察');
        });
      }
      [1, 2, 3, 42].forEach(function (seed) {
        const report = Scene.validatePlan(planFor(seed));
        assert(report.ok, '可解性校验必须通过：' + seed + '/' + JSON.stringify(report.failures));
      });
    });

    test('18 盲区内有车时不观察直接变道会为后方来车急刹而失败', function () {
      for (let seed = 1; seed <= 40; seed += 1) {
        const id = eventIdFor(seed, 'blind-spot-car');
        const sim = runEvent(seed, id, requestTargetLane, 3000);
        const event = sim.events[id];
        assert(sim.status === 'frozen' && sim.freezeInfo,
          '盲目变道必须在接触前定格：' + seed);
        assert(sim.freezeInfo.reason === 'follower' || sim.freezeInfo.reason === 'side',
          '失败原因必须是后方来车急刹或侧面接触：' + sim.freezeInfo.reason);
        assert(event.failed && !event.safe && event.observationScore === 0,
          '未观察的盲目变道不得获得安全或观察评价');
        assert(event.commit && event.commit.blindSpotOccupied && !event.commit.observationFresh,
          '决策快照必须记录盲区被占用且观察未完成');
        assert(Scene.ui.failureReason(sim).length > 0, '失败原因必须能显示为文案');
      }
    });

    test('18 完成观察但过期后再变道拿不到完整观察分', function () {
      for (let seed = 1; seed <= 10; seed += 1) {
        const id = eventIdFor(seed, 'clear-change');
        const sim = runEvent(seed, id, lookThenChange(1.5, 3.2), 3000);
        const event = sim.events[id];
        assert(event.resolved && !event.failed, '安全变道事件中过期观察仍可完成，但不能得分：' + seed);
        assert(event.commit && !event.commit.observationFresh && !event.commit.mirrorOk &&
          !event.commit.shoulderOk, '过期观察不得被记为有效');
        assert(event.observationScore < 10, '过期观察不得获得满分');
        assert(sim.observation.everComplete[planFor(seed).events[id].side],
          '系统仍应保留“曾经完成观察”的记录');
      }
    });

    test('18 一直不变道会在施工封闭线前示意并定格失败', function () {
      for (let seed = 1; seed <= 12; seed += 1) {
        const sim = run(seed, function () { return {}; }, null, null, 3000);
        assert(sim.status === 'frozen' && sim.freezeInfo, '不变道必须被封闭线挡住：' + seed);
        assert(sim.freezeInfo.reason === 'closure', '失败原因必须是施工封闭线：' + seed);
        assert(sim.currentEvent.failed && !sim.currentEvent.safe, '封闭线失败必须写入事件记录');
        assert(sim.freezeInfo.closure <= 1, '定格必须发生在封闭线内');
        assert(Scene.ui.failureReason(sim).indexOf('scene.laneChange.') !== 0,
          '失败原因必须是已翻译文案');
      }
    });

    test('18 长期不动会超时且总分封顶 69', function () {
      for (let seed = 1; seed <= 3; seed += 1) {
        const sim = run(seed, brakeOnly);
        assert(sim.status === 'timeout', '长期停在原地应超时：' + seed);
        const result = Scene.Scoring.summarize(sim, true);
        assert(result.total <= 69 && result.timedOut, '超时总分不得超过 69');
      }
    });

    test('18 当前事件重试恢复同一快照并保留首次失败 59 封顶，示范与独立模拟一致', function () {
      const sim = freezeWithImmediateChange(1);
      const id = sim.freezeInfo.eventId;
      const planBefore = JSON.stringify(sim.plan);
      const scoringBefore = JSON.stringify(sim.scoring);

      sim.startDemo();
      assert(sim.status === 'demonstrating', '定格后必须能进入正确示范');
      const reference = new Scene.Simulation(sim.seed, { plan: sim.plan, eventId: id });
      reference.start();
      let frames = 0;
      while (sim.status === 'demonstrating' && frames < 1200) {
        sim.stepDemo(STEP);
        frames += 1;
        if (sim.demo) {
          reference.step(Scene.defensiveInput(reference), STEP);
          assert(snapshot(sim.demo) === snapshot(reference), '示范必须与独立同种子真实 Simulation 逐帧一致');
        }
      }
      assert(frames < 1200 && frames > 0, '示范必须播放完整事件');
      assert(JSON.stringify(sim.scoring) === scoringBefore, '示范期间不得推进正式模拟的评分');
      assert(sim.status === 'driving' && sim.eventIndex === id && sim.currentEvent.failed &&
        sim.currentEvent.attempts === 1, '示范结束必须定位当前事件并保留失败');
      assert(JSON.stringify(sim.plan) === planBefore && sim.currentEvent.elapsed === 0 &&
        sim.player.s === 0, '重试必须从同事件起点开始并复用相同交通计划');
      const result = Scene.Scoring.summarize(sim, false);
      assert(result.total <= 59, '示范和重试均不得清除首次失败封顶');
    });

    test('18 30 / 60 / 120Hz 下最终物理、记录和评分一致', function () {
      for (let seed = 1; seed <= 8; seed += 1) {
        const at30 = run(seed, Scene.defensiveInput, 30);
        const at60 = run(seed, Scene.defensiveInput, 60);
        const at120 = run(seed, Scene.defensiveInput, 120);
        assert(snapshot(at30) === snapshot(at60) && snapshot(at60) === snapshot(at120),
          '渲染采样频率不得改变固定步长结果：' + seed);
      }
    });

    test('18 暂停推进被禁止，恢复后时间轴连续', function () {
      const sim = new Scene.Simulation('pause-lane-change');
      sim.start();
      for (let frame = 0; frame < 90; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      sim.status = 'paused';
      const before = snapshot(sim);
      sim.step({ throttle: true, brake: true }, STEP);
      assert(snapshot(sim) === before, '暂停不得推进车辆、观察、评分或计时');
      sim.status = 'driving';
      sim.step(Scene.defensiveInput(sim), STEP);
      assert(sim.elapsed > JSON.parse(before).elapsed, '恢复后必须沿原时间轴继续');
    });

    test('18 Renderer 可画正常、定格和示范，正常 HUD 不泄露未来计划', function () {
      const sim = new Scene.Simulation('render-lane-change');
      sim.start();
      Scene.Renderer.render(mockContext(), sim);
      sim.observation.view = 'mirror';
      Scene.Renderer.render(mockContext(), sim);
      sim.observation.view = 'shoulder';
      Scene.Renderer.render(mockContext(), sim);
      const coach = Scene.ui.coach(sim, sim.speed);
      assert(coach.text.indexOf('clear-change') < 0 && coach.text.indexOf('blind-spot-car') < 0 &&
        coach.text.indexOf('fast-closing') < 0, '正常 HUD 不得泄露事件模板');

      const failed = freezeWithImmediateChange(2);
      Scene.Renderer.render(mockContext(), failed);
      assert(Scene.ui.failureReason(failed).length > 0, '定格后必须能显示失败原因');
      assert(Scene.ui.eventToast(failed.currentEvent).key.indexOf('scene.laneChange.toast.') === 0,
        '事件提示必须使用翻译键');
      failed.startDemo();
      for (let frame = 0; frame < 30; frame += 1) failed.stepDemo(STEP);
      if (failed.status === 'demonstrating') Scene.Renderer.render(mockContext(), failed);
      const caption = Scene.ui.demoCaption(failed);
      assert(caption.step.length > 0 && caption.step.indexOf('scene.laneChange.') !== 0,
        '示范字幕必须是已翻译文案');

      Scene.ui.updateControls(mockDoc(), sim);
      const controls = Scene.ui.controls();
      ['lookLeft', 'lookRight', 'left', 'right', 'throttle', 'brake'].forEach(function (key) {
        assert(controls[key] && controls[key].label && controls[key].aria,
          '驾驶控制必须包含 ' + key);
      });
      assert(controls.lookLeft.icon === 'Q' && controls.lookRight.icon === 'E',
        '观察键必须显示 Q / E');
    });

    test('18 中英文键完整且语言切换不改变模拟', function () {
      [
        'scene.laneChange.hud.progress', 'scene.laneChange.hud.cruise', 'scene.laneChange.hud.mirror',
        'scene.laneChange.hud.shoulder', 'scene.laneChange.hud.stale', 'scene.laneChange.hud.changing',
        'scene.laneChange.hud.clear', 'scene.laneChange.status.mirror',
        'scene.laneChange.view.targetLeft', 'scene.laneChange.view.targetRight',
        'scene.laneChange.canvas.blindZone', 'scene.laneChange.failure.side',
        'scene.laneChange.failure.rear', 'scene.laneChange.failure.closure',
        'scene.laneChange.failure.follower', 'scene.laneChange.demo.blindSpot',
        'scene.laneChange.demo.fastNear', 'scene.laneChange.demo.fastFar',
        'scene.laneChange.result.summary.a', 'scene.laneChange.result.advice.default',
        'scene.laneChange.controls.lookLeft', 'scene.laneChange.controls.lookRight'
      ].forEach(function (key) { assert(translationExists(key), '缺少中英文文案：' + key); });

      const sim = new Scene.Simulation('language-lane-change');
      sim.start();
      const before = snapshot(sim);
      Game.I18N.setLanguage('en');
      const progress = Scene.ui.progress(sim);
      assert(progress.length > 0 && progress.indexOf('scene.laneChange.') !== 0, '进度文案必须已翻译');
      for (let frame = 0; frame < 120; frame += 1) {
        sim.step(Scene.defensiveInput(sim), STEP);
        const coach = Scene.ui.coach(sim, sim.speed);
        assert(coach.text.length > 0 && coach.status.length > 0 &&
          coach.text.indexOf('scene.laneChange.') !== 0 &&
          coach.status.indexOf('scene.laneChange.') !== 0,
        '驾驶提示必须可双语显示且不返回原始键');
      }
      Game.I18N.setLanguage('zh-CN');
      assert(sim.plan.seed === planFor('language-lane-change').seed, '语言切换不得改变计划');
      assert(snapshot(sim) !== before, '切换语言时模拟应继续推进，而不是被重置');
      const after = snapshot(sim);
      sim.step(Scene.defensiveInput(sim), STEP);
      assert(snapshot(sim) !== after, '语言切换后模拟必须继续响应输入');
    });

    test('18 目录注册 EP18、正确页面和可玩状态', function () {
      const entry = Game.CATALOG.find(function (item) { return item.id === 'lane-change-blind-spot'; });
      assert(entry && entry.episode === '18' && entry.href === 'lane-change-blind-spot.html' &&
        entry.status === 'playable', '目录必须注册 EP18 lane-change-blind-spot.html');
      assert(entry.art === 'lane-change-blind-spot', '目录必须引用本场景的首页插图');
      assert(Scene.id === 'lane-change-blind-spot' && Scene.ui && Scene.defensiveInput &&
        Scene.Simulation && Scene.Scoring && Scene.Renderer && Scene.createPlan && Scene.validatePlan,
      '场景包公开接口不完整');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.LaneChangeTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
