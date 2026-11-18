(function (root) {
  'use strict';

  const Game = root.BusGame;
  const Scene = Game.Scenes['large-vehicle-blind-zones'];
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

  function run(seed, controller, hz, maxFrames) {
    const sim = new Scene.Simulation(seed, { plan: planFor(seed) });
    sim.start();
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

  function runEvent(seed, eventId, controller, maxSteps) {
    const sim = new Scene.Simulation(seed, { plan: planFor(seed), eventId: eventId });
    sim.start();
    const policy = controller || Scene.defensiveInput;
    let steps = 0;
    const limit = maxSteps || 6200;
    while (sim.status === 'driving' && !sim.events[eventId].resolved && steps < limit) {
      sim.step(policy(sim), STEP);
      steps += 1;
    }
    assert(steps < limit, '事件模拟不应卡死：' + seed + '/' + eventId);
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

  function holdSpeed() {
    return function (sim) {
      return {
        throttle: sim.player.v < 12.5,
        brake: sim.player.v > 12.55
      };
    };
  }

  function freezeSideMerge(seed) {
    const id = eventIdFor(seed, 'side-blind-merge');
    const sim = runEvent(seed, id, holdSpeed(), 3000);
    assert(sim.status === 'frozen' && sim.freezeInfo, '保持车速并行应在接触前定格：' + seed);
    assert(sim.freezeInfo.reason === 'sideSqueeze', '侧方并行失败原因应为侧向挤压：' + seed);
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
      getElementById: function () { return null; },
      addEventListener: function () {}
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
        results.push({ name: '[19] ' + name, passed: true });
      } catch (error) {
        results.push({ name: '[19] ' + name, passed: false, error: error.message });
      }
      if (options.onResult) options.onResult(results[results.length - 1]);
    }

    test('19 每局包含侧方并线、车头盲区并入和车尾倒车各一次，同种子复现且输入与语言不改计划', function () {
      [0, 1, 41, 'truck-plan'].forEach(function (seed) {
        const a = new Scene.Simulation(seed);
        const b = new Scene.Simulation(seed);
        assert(JSON.stringify(a.plan) === JSON.stringify(b.plan), '相同种子必须生成相同计划');
        assert(a.events.map(function (event) { return event.template; }).sort().join(',') ===
          'front-blind-cut-in,rear-blind-reversing,side-blind-merge', '每局必须包含三类事件');
        const before = JSON.stringify(a.plan);
        a.start();
        Game.I18N.setLanguage('en');
        for (let frame = 0; frame < 120; frame += 1) a.step(fullThrottle(), STEP);
        assert(JSON.stringify(a.plan) === before, '踏板和语言不得改写大车计划');
        Game.I18N.setLanguage('zh-CN');
      });
    });

    test('19 三类事件参数、左右侧方覆盖与施工/装卸位来自固定计划', function () {
      const sides = { left: 0, right: 0 };
      for (let seed = 1; seed <= 40; seed += 1) {
        planFor(seed).events.forEach(function (event) {
          assert(event.route && event.player && event.player.initialSpeed > 0, '计划必须包含路线与初速');
          if (event.template === 'side-blind-merge') {
            sides[event.mergeSide] += 1;
            assert(event.truck.startX === -event.truck.targetX, '大车必须从对向车道连续并入本车道');
            assert(Math.abs(Math.abs(event.truck.targetX) - Scene.Constants.LANE_WIDTH / 2) < 1e-9,
              '目标横向位置必须是车道中心');
            assert(event.truck.signalAt === 0.5 && event.truck.lateralStart === 2.5,
              '侧方并线必须先打灯，再连续横向移动');
            assert(event.player.initialSpeed >= Scene.Constants.A_PLAYER_SPEED - 1e-9,
              '侧方事件初速必须来自计划');
          } else if (event.template === 'front-blind-cut-in') {
            assert(event.closure.lineS === 180 && event.closure.warningS === 8 &&
              event.closure.arrowS === 55, '施工封闭线、警告牌与导向牌位置必须固定');
            assert(event.truck.s >= 12 && event.truck.s <= 13.5, '大车必须在前方右侧固定位置');
            assert(event.queue && event.queue.s >= 120 && event.queue.s <= 128,
              '右侧排队车必须来自固定计划');
          } else {
            assert(event.truck.reverseDistance === 7 && event.truck.reverseSpeed === 1,
              '倒车距离与速度必须来自常量');
            assert(event.truck.bayX > event.truck.x, '装卸位必须让大车向右转出车道');
            assert(event.passSide === 'left', '超车侧必须是左侧');
          }
        });
      }
      assert(sides.left >= 15 && sides.right >= 15, '侧方事件必须覆盖左右两侧');
    });

    test('19 反向可见性：车头、车尾和侧方盲区真实不可见，远处才恢复视野', function () {
      const truck = { x: 0, s: 50, yaw: 0, length: Scene.Constants.TRUCK_LENGTH, width: Scene.Constants.TRUCK_WIDTH };
      const player = function (x, s, yaw) {
        return {
          x: x,
          s: s,
          yaw: yaw || 0,
          length: Scene.Constants.PLAYER_LENGTH,
          width: Scene.Constants.PLAYER_WIDTH
        };
      };
      const front = Scene.Visibility.driverVisibility(truck, player(0, 60));
      assert(front.zone === 'front', '车头近距离必须归入车头盲区');
      assert(front.visibleFraction < 0.5, '车头近处大部分采样点应不可见：' + front.visibleFraction);

      const side = Scene.Visibility.driverVisibility(truck, player(3.5, 50));
      assert(side.zone === 'right', '右侧并行必须归入右侧盲区');
      assert(!side.visible && !side.mirrorVisible, '紧贴车身右侧时后视镜不应提供完整视野');

      const rear = Scene.Visibility.driverVisibility(truck, player(0, 38));
      assert(rear.zone === 'rear', '车尾近处必须归入车尾盲区');
      assert(!rear.visible, '紧贴车尾时驾驶员不应看见完整车辆');

      const ahead = Scene.Visibility.driverVisibility(truck, player(0, 82));
      assert(ahead.zone === 'clear' && ahead.visible, '拉开足够前距后必须恢复可见');

      const rearSide = Scene.Visibility.driverVisibility(truck, player(3.5, 36));
      assert(rearSide.mirrorVisible && rearSide.visible,
        '侧后方较远处应落在宽角后视镜内');
    });

    test('19 有偏航 OBB 使用分离轴检测角部接触和净间距', function () {
      const player = { x: 0, s: 0, width: 1.8, length: 4.4, yaw: 0 };
      const rotated = { x: 1.65, s: 1.5, width: 1.8, length: 4.4, yaw: Math.PI / 4 };
      const separated = { x: 7, s: 0, width: 1.8, length: 4.4, yaw: Math.PI / 4 };
      assert(Scene.Geometry.obbIntersects(player, rotated), '旋转车身的真实角部接触必须可检测');
      assert(!Scene.Geometry.obbIntersects(player, separated), '分离 OBB 不得误判接触');
      assert(Scene.Geometry.obbClearance(player, separated) > 3.9 &&
        Scene.Geometry.obbClearance(player, separated) < 4,
      '净间距必须来自真实多边形');
    });

    test('19 40 个防御种子安全完成、观察与安全满分且无急刹', function () {
      for (let seed = 1; seed <= 40; seed += 1) {
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
          assert(event.visibleFraction >= 0 && event.visibleFraction <= 1,
            '可见比例必须在 0 到 1 之间');
        });
      }
      [1, 2, 3, 42].forEach(function (seed) {
        const report = Scene.validatePlan(planFor(seed));
        assert(report.ok, '可解性校验必须通过：' + seed + '/' + JSON.stringify(report.failures));
      });
    });

    test('19 侧方并线时保持车速并行会在接触前定格并丢失观察分', function () {
      for (let seed = 1; seed <= 20; seed += 1) {
        const sim = freezeSideMerge(seed);
        const event = sim.currentEvent;
        assert(event.failed && !event.safe && event.observationScore === 0,
          '侧方并行冲突不得获得安全或观察评价');
        assert(sim.freezeInfo.zone === 'left' || sim.freezeInfo.zone === 'right',
          '定格时必须记录侧方盲区');
        assert(Scene.ui.failureReason(sim).length > 0 &&
          Scene.ui.failureReason(sim).indexOf('scene.largeVehicle.') !== 0,
        '失败原因必须是已翻译文案');
      }
    });

    test('19 车头盲区并入事件全油门会冲过施工封闭线', function () {
      for (let seed = 1; seed <= 15; seed += 1) {
        const id = eventIdFor(seed, 'front-blind-cut-in');
        const sim = runEvent(seed, id, fullThrottle, 3000);
        assert(sim.status === 'frozen' && sim.freezeInfo, '冲过封闭线必须定格：' + seed);
        assert(sim.freezeInfo.reason === 'frontClosure', '失败原因必须是施工封闭线：' + seed);
        assert(sim.freezeInfo.closure <= 0.01, '定格必须发生在封闭线处');
        assert(sim.currentEvent.failed && sim.currentEvent.observationScore === 0,
          '未观察并入不得获得观察分');
      }
    });

    test('19 车尾倒车事件全油门会进入车尾盲区并失败', function () {
      for (let seed = 1; seed <= 15; seed += 1) {
        const id = eventIdFor(seed, 'rear-blind-reversing');
        const sim = runEvent(seed, id, fullThrottle, 2500);
        assert(sim.status === 'frozen' && sim.freezeInfo, '抢行进入倒车扫掠范围必须定格：' + seed);
        assert(sim.freezeInfo.reason === 'rearBackover', '失败原因必须是车尾倒车盲区：' + seed);
        assert(sim.currentEvent.failed && !sim.currentEvent.safe,
          '倒车盲区冲突必须写入事件记录');
      }
    });

    test('19 长期只制动不动会超时且总分封顶 69', function () {
      for (let seed = 1; seed <= 3; seed += 1) {
        const sim = run(seed, brakeOnly);
        assert(sim.status === 'timeout', '长期停在原地应超时：' + seed);
        const result = Scene.Scoring.summarize(sim, true);
        assert(result.total <= 69 && result.timedOut, '超时总分不得超过 69');
      }
    });

    test('19 当前事件重试保留首次失败 59 封顶，示范与独立模拟逐帧一致', function () {
      const sim = freezeSideMerge(1);
      const id = sim.freezeInfo.eventId;
      const planBefore = JSON.stringify(sim.plan);
      const scoringBefore = JSON.stringify(sim.scoring);

      sim.startDemo();
      assert(sim.status === 'demonstrating', '定格后必须能进入正确示范');
      const reference = new Scene.Simulation(sim.seed, { plan: sim.plan, eventId: id });
      reference.start();
      let frames = 0;
      while (sim.status === 'demonstrating' && frames < 1400) {
        sim.stepDemo(STEP);
        frames += 1;
        if (sim.demo) {
          reference.step(Scene.defensiveInput(reference), STEP);
          assert(snapshot(sim.demo) === snapshot(reference),
            '示范必须与独立同种子真实 Simulation 逐帧一致');
        }
      }
      assert(frames < 1400 && frames > 0, '示范必须播放完整事件');
      assert(JSON.stringify(sim.scoring) === scoringBefore, '示范期间不得推进正式模拟的评分');
      assert(sim.status === 'driving' && sim.eventIndex === id && sim.currentEvent.failed &&
        sim.currentEvent.attempts === 1, '示范结束必须定位当前事件并保留失败');
      assert(JSON.stringify(sim.plan) === planBefore && sim.currentEvent.elapsed === 0 &&
        sim.player.s === 0, '重试必须从同事件起点开始并复用相同交通计划');
      const result = Scene.Scoring.summarize(sim, false);
      assert(result.total <= 59, '示范和重试均不得清除首次失败封顶');
    });

    test('19 30 / 60 / 120Hz 下最终物理、记录和评分一致', function () {
      for (let seed = 1; seed <= 6; seed += 1) {
        const at30 = run(seed, Scene.defensiveInput, 30);
        const at60 = run(seed, Scene.defensiveInput, 60);
        const at120 = run(seed, Scene.defensiveInput, 120);
        assert(snapshot(at30) === snapshot(at60) && snapshot(at60) === snapshot(at120),
          '渲染采样频率不得改变固定步长结果：' + seed);
      }
    });

    test('19 变道请求连续、平滑，完成后停在目标车道中心并保留偏航回正', function () {
      for (let seed = 1; seed <= 10; seed += 1) {
        const id = eventIdFor(seed, 'front-blind-cut-in');
        const sim = new Scene.Simulation(seed, { plan: planFor(seed), eventId: id });
        sim.start();
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
        assert(sim.events[id].resolved, '防御策略必须完成并入：' + seed);
        assert(sawMoving, '必须经历平滑的横向移动阶段');
        assert(maxStep < 0.1, '每帧横向位移必须连续，不得跳变：' + maxStep);
        assert(Math.abs(sim.player.x - Scene.Constants.LANE_WIDTH / 2) < 1e-6,
          '并入完成后必须停在右车道中心');
        assert(Math.abs(sim.player.yaw) < 1e-6, '并入完成后偏航必须回正');
        assert(sim.assessment.fullyIn, '完成并入后必须被识别为完全进入目标车道');
      }
    });

    test('19 暂停推进被禁止，恢复后时间轴连续', function () {
      const sim = new Scene.Simulation('pause-truck-blind-zones');
      sim.start();
      for (let frame = 0; frame < 90; frame += 1) sim.step(Scene.defensiveInput(sim), STEP);
      sim.status = 'paused';
      const before = snapshot(sim);
      sim.step({ throttle: true, brake: true }, STEP);
      assert(snapshot(sim) === before, '暂停不得推进车辆、可见性、评分或计时');
      sim.status = 'driving';
      sim.step(Scene.defensiveInput(sim), STEP);
      assert(sim.elapsed > JSON.parse(before).elapsed, '恢复后必须沿原时间轴继续');
    });

    test('19 Renderer 可画正常、定格、示范和大车视野，正常 HUD 不泄露未来计划', function () {
      const sim = new Scene.Simulation('render-truck-blind-zones');
      sim.start();
      Scene.Renderer.render(mockContext(), sim);
      const coach = Scene.ui.coach(sim, sim.speed);
      ['side-blind-merge', 'front-blind-cut-in', 'rear-blind-reversing'].forEach(function (template) {
        assert(coach.text.indexOf(template) < 0 && coach.status.indexOf(template) < 0,
          '正常 HUD 不得泄露事件模板');
      });

      const failed = freezeSideMerge(2);
      Scene.Renderer.render(mockContext(), failed);
      assert(Scene.ui.failureReason(failed).length > 0, '定格后必须能显示失败原因');
      assert(Scene.ui.eventToast(failed.currentEvent).key.indexOf('scene.largeVehicle.toast.') === 0,
        '事件提示必须使用翻译键');
      failed.startDemo();
      for (let frame = 0; frame < 30; frame += 1) failed.stepDemo(STEP);
      if (failed.status === 'demonstrating') {
        failed.demo.demoView = 'truck';
        Scene.Renderer.render(mockContext(), failed);
        assert(failed.demo.visibility && failed.demo.visibility.zone, '大车视野必须暴露真实盲区分类');
      }
      const caption = Scene.ui.demoCaption(failed);
      assert(caption.step.length > 0 && caption.step.indexOf('scene.largeVehicle.') !== 0,
        '示范字幕必须是已翻译文案');

      Scene.ui.updateControls(mockDoc(), sim);
      const controls = Scene.ui.controls();
      ['left', 'right', 'throttle', 'brake'].forEach(function (key) {
        assert(controls[key] && controls[key].label && controls[key].aria,
          '驾驶控制必须包含 ' + key);
      });
      assert(controls.left.icon === '◀' && controls.right.icon === '▶',
        '左右请求键必须显示方向图标');
      assert(!controls.lookLeft && !controls.lookRight, '大车盲区场景不提供观察键');
    });

    test('19 中英文键完整且语言切换不改变模拟', function () {
      [
        'scene.largeVehicle.hud.progress', 'scene.largeVehicle.hud.cruise',
        'scene.largeVehicle.hud.sideMerge', 'scene.largeVehicle.hud.frontWait',
        'scene.largeVehicle.hud.rearReverse', 'scene.largeVehicle.view.caption',
        'scene.largeVehicle.view.truckView', 'scene.largeVehicle.zone.front',
        'scene.largeVehicle.zone.rear', 'scene.largeVehicle.zone.left',
        'scene.largeVehicle.zone.right', 'scene.largeVehicle.failure.sideSqueeze',
        'scene.largeVehicle.failure.frontRearEnd', 'scene.largeVehicle.failure.frontClosure',
        'scene.largeVehicle.failure.rearBackover', 'scene.largeVehicle.failure.timeout',
        'scene.largeVehicle.demo.truckBlind', 'scene.largeVehicle.demo.side',
        'scene.largeVehicle.demo.frontMerge', 'scene.largeVehicle.demo.rearStop',
        'scene.largeVehicle.result.summary.a', 'scene.largeVehicle.result.summary.b',
        'scene.largeVehicle.result.summary.c', 'scene.largeVehicle.result.summary.timeout',
        'scene.largeVehicle.result.advice.default', 'scene.largeVehicle.controls.changeLeft',
        'scene.largeVehicle.controls.changeRight'
      ].forEach(function (key) { assert(translationExists(key), '缺少中英文文案：' + key); });

      const sim = new Scene.Simulation('language-truck-blind-zones');
      sim.start();
      const before = snapshot(sim);
      Game.I18N.setLanguage('en');
      const progress = Scene.ui.progress(sim);
      assert(progress.length > 0 && progress.indexOf('scene.largeVehicle.') !== 0, '进度文案必须已翻译');
      for (let frame = 0; frame < 150; frame += 1) {
        sim.step(Scene.defensiveInput(sim), STEP);
        const coach = Scene.ui.coach(sim, sim.speed);
        assert(coach.text.length > 0 && coach.status.length > 0 &&
          coach.text.indexOf('scene.largeVehicle.') !== 0 &&
          coach.status.indexOf('scene.largeVehicle.') !== 0,
        '驾驶提示必须可双语显示且不返回原始键');
      }
      Game.I18N.setLanguage('zh-CN');
      assert(sim.plan.seed === planFor('language-truck-blind-zones').seed, '语言切换不得改变计划');
      assert(snapshot(sim) !== before, '切换语言时模拟应继续推进，而不是被重置');
      const after = snapshot(sim);
      sim.step(Scene.defensiveInput(sim), STEP);
      assert(snapshot(sim) !== after, '语言切换后模拟必须继续响应输入');
    });

    test('19 目录保留 EP19 注册但已下线，场景包接口完整', function () {
      const entry = Game.CATALOG.find(function (item) { return item.id === 'large-vehicle-blind-zones'; });
      assert(entry && entry.episode === '19' && entry.href === 'large-vehicle-blind-zones.html' &&
        entry.status === 'hidden', '目录必须保留 EP19 注册并标记为下线');
      assert(entry.art === 'large-vehicle-blind-zones', '目录必须引用本场景的首页插图');
      assert(Scene.id === 'large-vehicle-blind-zones' && Scene.ui && Scene.defensiveInput &&
        Scene.Simulation && Scene.Scoring && Scene.Renderer && Scene.createPlan && Scene.validatePlan,
      '场景包公开接口不完整');
      assert(Scene.Visibility && Scene.Visibility.driverVisibility && Scene.Geometry,
        '场景包必须公开反向可见性与几何工具，便于专项测试');
    });

    return {
      passed: results.filter(function (result) { return result.passed; }).length,
      failed: results.filter(function (result) { return !result.passed; }).length,
      results: results
    };
  }

  root.LargeVehicleTests = { run: runTests };
})(typeof window !== 'undefined' ? window : globalThis);
