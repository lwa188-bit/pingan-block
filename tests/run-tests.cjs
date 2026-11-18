const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({ console, Uint32Array, Math, JSON });
context.window = context;

['js/i18n.js', 'js/catalog.js', 'js/model.js', 'js/draw.js', 'js/scoring.js', 'js/simulation.js', 'js/scenes/crosswalk.js', 'js/scenes/braking.js', 'js/scenes/parked-cars.js', 'js/scenes/blind-junction.js', 'js/scenes/crosswalk-turnback.js', 'js/scenes/dooring.js', 'js/scenes/truck-inner-wheel.js', 'js/scenes/reversing-blind-spot.js', 'js/scenes/nonmotor-mix.js', 'js/scenes/red-light-runner.js', 'js/scenes/unsignalized-cross-traffic.js', 'js/scenes/yellow-light-decision.js', 'js/scenes/sudden-cut-in.js', 'js/scenes/multi-car-pileup.js', 'js/scenes/revealed-stopped-vehicle.js', 'js/scenes/obscured-signal-intersection.js', 'js/scenes/lane-change-blind-spot.js', 'js/scenes/large-vehicle-blind-zones.js', 'tests/cases.js', 'tests/crosswalk-cases.js', 'tests/braking-cases.js', 'tests/parked-cars-cases.js', 'tests/blind-junction-cases.js', 'tests/crosswalk-turnback-cases.js', 'tests/dooring-cases.js', 'tests/truck-inner-wheel-cases.js', 'tests/reversing-blind-spot-cases.js', 'tests/nonmotor-mix-cases.js', 'tests/red-light-runner-cases.js', 'tests/unsignalized-cross-traffic-cases.js', 'tests/yellow-light-decision-cases.js', 'tests/sudden-cut-in-cases.js', 'tests/multi-car-pileup-cases.js', 'tests/revealed-stopped-vehicle-cases.js', 'tests/obscured-signal-intersection-cases.js', 'tests/lane-change-blind-spot-cases.js', 'tests/large-vehicle-blind-zones-cases.js'].forEach(function (file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return;
  const source = fs.readFileSync(full, 'utf8');
  vm.runInContext(source, context, { filename: file });
});

const suites = [context.BusGameTests, context.CrosswalkTests, context.BrakingTests, context.ParkedCarsTests, context.BlindJunctionTests, context.CrosswalkTurnbackTests, context.DooringTests, context.TruckInnerWheelTests, context.ReversingBlindSpotTests, context.NonmotorMixTests, context.RedLightRunnerTests, context.UnsignalizedCrossTrafficTests, context.YellowLightDecisionTests, context.SuddenCutInTests, context.MultiCarPileupTests, context.RevealedStoppedVehicleTests, context.ObscuredSignalIntersectionTests, context.LaneChangeTests, context.LargeVehicleTests].filter(Boolean);
const report = suites.reduce(function (total, suite) {
  const result = suite.run();
  return {
    passed: total.passed + result.passed,
    failed: total.failed + result.failed,
    results: total.results.concat(result.results)
  };
}, { passed: 0, failed: 0, results: [] });
report.results.forEach(function (result) {
  console.log((result.passed ? '✓' : '✗') + ' ' + result.name + (result.error ? '\n  ' + result.error : ''));
});
console.log('\n' + report.passed + ' 项通过，' + report.failed + ' 项失败。');
process.exitCode = report.failed ? 1 : 0;
