(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};

  const C = Game.C = {
    WIDTH: 360,
    HEIGHT: 640,
    PIXELS_PER_METER: 5.2,
    CAR_X: 210,
    CAR_MIN_X: 188,
    CAR_MAX_X: 224,
    CAR_Y: 482,
    CAR_WIDTH_M: 1.75,
    CAR_LENGTH_M: 4.1,
    BUS_X: 270,
    BUS_WIDTH_M: 2.55,
    BUS_LENGTH_M: 11.5,
    PEDESTRIAN_START_X: 262,
    PEDESTRIAN_TRIGGER: 14,
    PEDESTRIAN_WAIT_X: 174,
    BUS_POSITIONS: [120, 300, 480],
    FINISH_BUFFER: 12,
    MAX_SPEED: 60,
    START_SPEED: 30,
    MAX_TIME: 95,
    APPROACH_START: 55,
    RISK_START: 35,
    SLOW_CHECK: 15,
    LATE_CHECK: 10,
    REVEAL_DISTANCE: 14,
    RISK_END: 3,
    SAFE_SPEED: 20,
    RISK_MAX_SPEED: 24,
    LATERAL_SHIFT: 0.35,
    ACCELERATION: 3.1,
    BRAKE_DECELERATION: 3.8,
    EMERGENCY_BRAKE_DECELERATION: 6.8,
    NATURAL_DECELERATION: 0.35,
    STEER_SPEED: 16,
    HARD_BRAKE: 4.5,
    HARD_BRAKE_MIN_SPEED: 15,
    FIXED_STEP: 1 / 60,
    REACTION_TIME: 0.75,
    COMFORTABLE_BRAKE: 3.5
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, amount) {
    return a + (b - a) * amount;
  }

  function moveToward(value, target, amount) {
    if (value < target) return Math.min(value + amount, target);
    return Math.max(value - amount, target);
  }

  function mulberry32(seed) {
    let value = seed >>> 0;
    return function () {
      value += 0x6D2B79F5;
      let result = value;
      result = Math.imul(result ^ result >>> 15, result | 1);
      result ^= result + Math.imul(result ^ result >>> 7, result | 61);
      return ((result ^ result >>> 14) >>> 0) / 4294967296;
    };
  }

  function hashSeed(value) {
    const text = String(value == null ? '' : value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function randomSeed() {
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      return root.crypto.getRandomValues(new Uint32Array(1))[0] % 100000;
    }
    return Math.floor(Math.random() * 100000);
  }

  function createEvents(seed) {
    const random = mulberry32(hashSeed(seed));
    const occupiedCount = random() < 0.5 ? 1 : 2;
    const patterns = occupiedCount === 1
      ? [[true, false, false], [false, true, false], [false, false, true]]
      : [[true, true, false], [true, false, true], [false, true, true]];
    const pattern = patterns[Math.floor(random() * patterns.length)];

    return C.BUS_POSITIONS.map(function (position, index) {
      return {
        id: index,
        busPosition: position,
        occupied: pattern[index],
        runSpeed: 48 + random() * 6,
        coatColor: ['#f4d35e', '#ee6c72', '#7fd1ed'][Math.floor(random() * 3)],
        skinColor: random() > 0.5 ? '#efb489' : '#c88760',
        recorded30: false,
        recorded15: false,
        speedAt30: null,
        speedAt15: null,
        minSpeedInRisk: Infinity,
        maxSpeedAfter30: 0,
        maxLateralShift: 0,
        earlySlow: false,
        lateSlow: false,
        resolved: false,
        attempts: 0,
        failed: false,
        pedestrian: {
          active: false,
          x: C.PEDESTRIAN_START_X,
          visible: false,
          waiting: false,
          hiddenAgain: false
        }
      };
    });
  }

  function stoppingDistance(speedKmh) {
    const speed = speedKmh / 3.6;
    return speed * C.REACTION_TIME + speed * speed / (2 * C.COMFORTABLE_BRAKE);
  }

  Game.Model = {
    clamp: clamp,
    lerp: lerp,
    moveToward: moveToward,
    mulberry32: mulberry32,
    hashSeed: hashSeed,
    randomSeed: randomSeed,
    createEvents: createEvents,
    stoppingDistance: stoppingDistance
  };
})(typeof window !== 'undefined' ? window : globalThis);
