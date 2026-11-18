(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};

  class Input {
    constructor(doc) {
      this.keys = new Set();
      this.pointerControls = new Map();
      this.buttons = Array.from(doc.querySelectorAll('[data-control]'));
      this.onPause = null;
      this.onConfirm = null;
      this.onRestart = null;
      this.state = { left: false, right: false, throttle: false, brake: false, lookLeft: false, lookRight: false };
      this.bindKeyboard();
      this.bindButtons();
      root.addEventListener('blur', this.clear.bind(this));
    }

    bindKeyboard() {
      const controls = {
        ArrowLeft: 'left', KeyA: 'left',
        ArrowRight: 'right', KeyD: 'right',
        ArrowUp: 'throttle', KeyW: 'throttle',
        ArrowDown: 'brake', KeyS: 'brake', Space: 'brake',
        KeyQ: 'lookLeft', KeyE: 'lookRight'
      };
      root.addEventListener('keydown', (event) => {
        const interactive = event.target && event.target.closest &&
          event.target.closest('button, a, input, select, textarea, [role="button"]');
        if (interactive && (event.code === 'Enter' || event.code === 'Space')) return;
        const control = controls[event.code];
        if (control) {
          event.preventDefault();
          this.keys.add(control);
          this.refresh();
        }
        if (!event.repeat && (event.code === 'KeyP' || event.code === 'Escape')) {
          event.preventDefault();
          if (this.onPause) this.onPause();
        }
        if (!event.repeat && event.code === 'Enter' && this.onConfirm) this.onConfirm();
        if (!event.repeat && event.code === 'KeyR' && this.onRestart) this.onRestart();
      });
      root.addEventListener('keyup', (event) => {
        const interactive = event.target && event.target.closest &&
          event.target.closest('button, a, input, select, textarea, [role="button"]');
        if (interactive && (event.code === 'Enter' || event.code === 'Space')) return;
        const control = controls[event.code];
        if (control) {
          event.preventDefault();
          this.keys.delete(control);
          this.refresh();
        }
      });
    }

    bindButtons() {
      this.buttons.forEach((button) => {
        button.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          button.setPointerCapture(event.pointerId);
          this.pointerControls.set(event.pointerId, button.dataset.control);
          this.refresh();
        });
        const release = (event) => {
          event.preventDefault();
          this.pointerControls.delete(event.pointerId);
          this.refresh();
        };
        button.addEventListener('pointerup', release);
        button.addEventListener('pointercancel', release);
        button.addEventListener('lostpointercapture', release);
        button.addEventListener('contextmenu', function (event) { event.preventDefault(); });
      });
    }

    refresh() {
      const pointerState = { left: false, right: false, throttle: false, brake: false, lookLeft: false, lookRight: false };
      this.pointerControls.forEach(function (control) { pointerState[control] = true; });
      Object.keys(this.state).forEach((control) => {
        this.state[control] = this.keys.has(control) || pointerState[control];
      });
      this.buttons.forEach((button) => {
        const active = this.state[button.dataset.control];
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    clear() {
      this.keys.clear();
      this.pointerControls.clear();
      this.refresh();
    }
  }

  Game.Input = Input;
})(typeof window !== 'undefined' ? window : globalThis);
