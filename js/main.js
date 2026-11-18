(function (root) {
  'use strict';

  const Game = root.BusGame;
  const C = Game.C;
  const I18N = Game.I18N;
  const t = I18N.t;
  const doc = root.document;
  I18N.init(doc);
  const scene = Game.Scenes[doc.body.dataset.scene] || Game.Scenes['bus-ghost'];
  const canvas = doc.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const input = new Game.Input(doc);
  const params = new URLSearchParams(root.location.search);
  let seed = params.has('seed') ? params.get('seed') : Game.Model.randomSeed();
  let simulation = new scene.Simulation(seed);
  let previousTime = performance.now();
  let accumulator = 0;
  let toastTimer = null;
  let toastState = null;
  let pausedFrom = 'driving';

  const elements = {};
  [
    'progress-label', 'timer-label', 'coach-bubble', 'coach-text', 'speed-value', 'speed-status',
    'toast', 'start-screen', 'pause-screen', 'failure-screen', 'failure-reason', 'demo-screen',
    'demo-step', 'demo-substep', 'result-screen', 'result-kicker', 'result-grade', 'result-title',
    'result-summary', 'result-total', 'result-safety', 'result-observation', 'result-efficiency',
    'result-smooth', 'result-advice-text', 'slow-count', 'brake-count', 'passed-count', 'live-seed',
    'smooth-meter-fill', 'smooth-caption', 'pause-button'
  ].forEach(function (id) { elements[id] = doc.getElementById(id); });

  function setText(element, value) {
    const text = String(value);
    if (element.textContent !== text) element.textContent = text;
  }

  function hideScreens() {
    ['start-screen', 'pause-screen', 'failure-screen', 'demo-screen', 'result-screen'].forEach(function (id) {
      elements[id].hidden = true;
    });
  }

  function clearToast() {
    if (toastTimer) root.clearTimeout(toastTimer);
    toastTimer = null;
    toastState = null;
    elements.toast.hidden = true;
  }

  function renderToast() {
    if (!toastState) return;
    setText(elements.toast, t(toastState.key, toastState.params));
  }

  function showToast(key, params, neutral) {
    clearToast();
    toastState = { key: key, params: params || {} };
    renderToast();
    elements.toast.classList.toggle('neutral', Boolean(neutral));
    elements.toast.hidden = false;
    toastTimer = root.setTimeout(function () {
      elements.toast.hidden = true;
      toastTimer = null;
      toastState = null;
    }, 2800);
  }

  function updatePauseControl() {
    const paused = simulation.status === 'paused';
    elements['pause-button'].textContent = paused ? '▶' : 'Ⅱ';
    elements['pause-button'].setAttribute('aria-label', t(paused ? 'game.resume' : 'game.pause'));
    elements['pause-button'].setAttribute('title', t(paused ? 'game.resume' : 'game.pauseTitle'));
  }

  function startCurrent() {
    hideScreens();
    clearToast();
    input.clear();
    simulation.start();
    elements['pause-button'].disabled = false;
    previousTime = performance.now();
    accumulator = 0;
  }

  function resetGame(nextSeed, autoStart) {
    seed = nextSeed;
    simulation = new scene.Simulation(seed);
    hideScreens();
    clearToast();
    input.clear();
    elements['pause-button'].disabled = !autoStart;
    updatePauseControl();
    elements['start-screen'].hidden = autoStart;
    elements['live-seed'].textContent = '#' + String(Game.Model.hashSeed(seed) % 10000).padStart(4, '0');
    previousTime = performance.now();
    accumulator = 0;
    if (autoStart) simulation.start();
    updateHud();
  }

  function togglePause() {
    if (simulation.status === 'driving') {
      pausedFrom = simulation.status;
      simulation.status = 'paused';
      input.clear();
      elements['pause-screen'].hidden = false;
    } else if (simulation.status === 'paused') {
      simulation.status = pausedFrom;
      elements['pause-screen'].hidden = true;
      previousTime = performance.now();
      accumulator = 0;
    }
    updatePauseControl();
  }

  function renderFailure() {
    if (!simulation.freezeInfo) return;
    setText(elements['failure-reason'], scene.ui.failureReason(simulation));
  }

  function showFailure() {
    input.clear();
    clearToast();
    renderFailure();
    elements['failure-screen'].hidden = false;
    elements['pause-button'].disabled = true;
  }

  function retryEvent() {
    hideScreens();
    simulation.retryEvent();
    elements['pause-button'].disabled = false;
    previousTime = performance.now();
    accumulator = 0;
    const toast = scene.ui.retryToast ? scene.ui.retryToast(simulation) : { key: 'toast.retry', params: {}, neutral: true };
    showToast(toast.key, toast.params, toast.neutral);
  }

  function startDemo(branch) {
    hideScreens();
    simulation.startDemo(branch);
    elements['demo-screen'].hidden = false;
    previousTime = performance.now();
    accumulator = 0;
  }

  function startRoleReplay() {
    if (typeof simulation.startPedestrianReplay !== 'function') return;
    hideScreens();
    clearToast();
    input.clear();
    simulation.justResolved = null;
    simulation.startPedestrianReplay();
    elements['demo-screen'].hidden = false;
    previousTime = performance.now();
    accumulator = 0;
  }

  function leaveDemo() {
    if (simulation.demoMode && simulation.demoMode !== 'driver' && typeof simulation.finishReplay === 'function') {
      simulation.finishReplay();
      previousTime = performance.now();
      accumulator = 0;
      handleStatus();
    } else {
      retryEvent();
    }
  }

  function renderResults() {
    const timedOut = simulation.status === 'timeout';
    const result = scene.Scoring.summarize(simulation, timedOut);
    setText(elements['result-kicker'], t(timedOut ? 'result.timeout' : 'result.complete'));
    setText(elements['result-grade'], result.grade);
    setText(elements['result-title'], t(result.titleKey));
    setText(elements['result-summary'], t(result.summaryKey));
    setText(elements['result-total'], result.total);
    setText(elements['result-safety'], result.safety + ' / 40');
    setText(elements['result-observation'], result.observation + ' / 30');
    setText(elements['result-efficiency'], result.efficiency + ' / 20');
    setText(elements['result-smooth'], result.smooth + ' / 10');
    setText(elements['result-advice-text'], t(result.adviceKey));
  }

  function showResults() {
    input.clear();
    clearToast();
    renderResults();
    elements['demo-screen'].hidden = true;
    elements['result-screen'].hidden = false;
    elements['pause-button'].disabled = true;
  }

  function onResolved(event) {
    const toast = scene.ui.eventToast(event);
    if (toast) showToast(toast.key, toast.params, toast.neutral);
  }

  function updateDemoCaption() {
    if (!simulation.demo) return;
    const caption = scene.ui.demoCaption(simulation);
    setText(elements['demo-step'], caption.step);
    setText(elements['demo-substep'], caption.substep);
  }

  function updateControls(view) {
    if (!scene.ui.controls) return;
    const controls = scene.ui.controls(view);
    input.buttons.forEach(function (button) {
      const config = controls[button.dataset.control];
      if (!config) return;
      button.hidden = Boolean(config.hidden);
      setText(button.querySelector('small'), config.label);
      setText(button.querySelector('span'), config.icon);
      button.setAttribute('aria-label', config.aria);
    });
  }

  function updateHud() {
    const view = simulation.status === 'demonstrating' && simulation.demo ? simulation.demo : simulation;
    const stats = scene.ui.liveStats(simulation);
    const smooth = scene.ui.smoothScore ? scene.ui.smoothScore(simulation) : Math.max(0, 10 - simulation.scoring.hardBrakes * 2);
    const displaySpeed = view.speed;
    updateControls(view);
    const seconds = Math.floor(simulation.elapsed);

    setText(elements['progress-label'], scene.ui.progress(simulation));
    setText(elements['timer-label'], String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'));
    setText(elements['speed-value'], Math.round(displaySpeed));
    setText(elements['slow-count'], stats[0]);
    setText(elements['brake-count'], stats[1]);
    setText(elements['passed-count'], stats[2]);
    elements['smooth-meter-fill'].style.width = smooth * 10 + '%';
    elements['smooth-meter-fill'].style.background = smooth >= 8 ? '#80e0b1' : (smooth >= 4 ? '#ffd166' : '#ff7a66');
    setText(elements['smooth-caption'], t('hud.smooth', { smooth: smooth }));

    const coachState = scene.ui.coach(simulation, displaySpeed);
    setText(elements['coach-text'], coachState.text);
    elements['coach-bubble'].className = 'coach-bubble' + (coachState.coachTone ? ' ' + coachState.coachTone : '');
    setText(elements['speed-status'], coachState.status);
    elements['speed-status'].className = 'speed-status' + (coachState.tone ? ' ' + coachState.tone : '');
    if (scene.ui.updateControls) scene.ui.updateControls(doc, simulation);
  }

  function handleStatus() {
    if (simulation.justHardBrake && !simulation.justResolved) {
      showToast('toast.hardBrake', {}, true);
    }
    if (simulation.justResolved) onResolved(simulation.justResolved);
    if (simulation.status === 'frozen' && elements['failure-screen'].hidden) showFailure();
    if ((simulation.status === 'complete' || simulation.status === 'timeout') && elements['result-screen'].hidden) {
      showResults();
    }
    if (simulation.status === 'driving' && !elements['demo-screen'].hidden) {
      elements['demo-screen'].hidden = true;
      elements['pause-button'].disabled = false;
      showToast('toast.yourTurn', {}, true);
    }
  }

  function renderLanguage() {
    updatePauseControl();
    renderToast();
    updateHud();
    if (simulation.status === 'frozen') renderFailure();
    if (simulation.status === 'complete' || simulation.status === 'timeout') renderResults();
    if (simulation.status === 'demonstrating') updateDemoCaption();
  }

  function frame(time) {
    const delta = Math.min((time - previousTime) / 1000, 0.1);
    previousTime = time;

    if (simulation.status === 'driving' || simulation.status === 'demonstrating') {
      accumulator += delta;
      while (accumulator >= C.FIXED_STEP) {
        if (simulation.status === 'driving') simulation.step(input.state, C.FIXED_STEP);
        else if (simulation.status === 'demonstrating') simulation.stepDemo(C.FIXED_STEP, input.state);
        accumulator -= C.FIXED_STEP;
        handleStatus();
        if (!['driving', 'demonstrating'].includes(simulation.status)) {
          accumulator = 0;
          break;
        }
      }
    }

    if (simulation.status === 'demonstrating') updateDemoCaption();
    updateHud();
    scene.Renderer.render(ctx, simulation);
    root.requestAnimationFrame(frame);
  }

  doc.getElementById('start-button').addEventListener('click', startCurrent);
  doc.getElementById('pause-button').addEventListener('click', togglePause);
  doc.getElementById('resume-button').addEventListener('click', togglePause);
  doc.getElementById('pause-restart-button').addEventListener('click', function () { resetGame(seed, true); });
  doc.getElementById('retry-button').addEventListener('click', retryEvent);
  doc.getElementById('demo-button').addEventListener('click', startDemo);
  const proceedDemoButton = doc.getElementById('demo-proceed-button');
  if (proceedDemoButton) proceedDemoButton.addEventListener('click', function () { startDemo('proceed'); });
  doc.getElementById('skip-demo-button').addEventListener('click', leaveDemo);
  doc.getElementById('new-game-button').addEventListener('click', function () { resetGame(Game.Model.randomSeed(), true); });
  doc.getElementById('same-game-button').addEventListener('click', function () { resetGame(seed, true); });
  ['role-replay-button', 'result-role-button'].forEach(function (id) {
    const button = doc.getElementById(id);
    if (button) button.addEventListener('click', startRoleReplay);
  });

  input.onPause = togglePause;
  input.onConfirm = function () {
    if (simulation.status === 'ready') startCurrent();
    else if (simulation.status === 'paused') togglePause();
    else if (simulation.status === 'frozen') startDemo();
  };
  input.onRestart = function () {
    if (simulation.status !== 'ready') resetGame(seed, true);
  };

  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden && simulation.status === 'driving') togglePause();
    input.clear();
    previousTime = performance.now();
  });

  I18N.onChange(renderLanguage);
  if (scene.bindControls) scene.bindControls(doc, function () { return simulation; });
  resetGame(seed, false);
  root.requestAnimationFrame(frame);

  Game.demoApp = {
    getSimulation: function () { return simulation; },
    start: startCurrent,
    retry: retryEvent,
    reset: resetGame,
    startRoleReplay: startRoleReplay,
    getLanguage: I18N.getLanguage,
    setLanguage: I18N.setLanguage
  };
})(typeof window !== 'undefined' ? window : globalThis);
