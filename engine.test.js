'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./engine.js');
const CLEAN = { ...E.DEFAULT_CONFIG, cameraNoise: 0, dropRate: 0, exposureMs: 0,
  bounceRandomness: 0, roughnessDeg: 0, blackoutMs: 250 };

test('seed fixes the world, pixels, observations and forecasts', () => {
  const a = E.runEpisode(E.DEFAULT_CONFIG), b = E.runEpisode(E.DEFAULT_CONFIG);
  assert.deepEqual(a.truth, b.truth);
  assert.deepEqual(a.frames, b.frames);
  assert.deepEqual(a.forecast, b.forecast);
  assert.equal(a.metrics.frozenError, b.metrics.frozenError);
  assert.notDeepEqual(a.truth, E.runEpisode({ ...E.DEFAULT_CONFIG, seed: 123 }).truth);
});

test('rough stochastic impacts are dissipative across the allowed range', () => {
  for (let seed = 1; seed <= 70; seed++) {
    const r = E.runEpisode({ ...E.DEFAULT_CONFIG, seed, restitution: .96,
      bounceRandomness: .3, roughnessDeg: 16, cameraNoise: 0 });
    assert.ok(r.impact.energyRatio <= 1 + 1e-12, `energy gain at seed ${seed}`);
    assert.ok(r.impact.outgoing.vx < 0, 'disk must leave the wall');
    assert.ok(r.truth.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
});

test('raster trajectories recover drag and restitution without an impact frame', () => {
  for (const [drag, restitution] of [[.05, .4], [.14, .76], [.35, .9]]) {
    const r = E.runEpisode({ ...CLEAN, drag, restitution }, E.createStudent(), { learn: true });
    assert.equal(r.metrics.impactObserved, false);
    assert.ok(r.learned, 'fit exists despite blackout');
    assert.ok(Math.abs(r.learned.drag - drag) < .025, `drag ${r.learned.drag} vs ${drag}`);
    assert.ok(Math.abs(r.learned.restitution - restitution) < .025);
    assert.ok(r.metrics.correctedError < .012, `correction ${r.metrics.correctedError}`);
    assert.equal(r.studentAfter.episodes, 1);
  }
});

test('the student decodes real grayscale rasters, with no simulator detections accepted', () => {
  const r = E.runEpisode(CLEAN), observed = r.frames.find(f => !f.dropped);
  assert.ok(observed.pixels instanceof Uint8Array);
  assert.equal(observed.pixels.length, 96 * 64);
  assert.ok(new Set(observed.pixels).size > 10, 'antialiased raster has intermediate intensities');
  const poisoned = r.frames.map(f => ({ t: f.t, pixels: f.pixels,
    detected: { x: 9999, y: 9999 }, restitution: 0, drag: 100, trueState: { x: -900 } }));
  assert.deepEqual(E.inferCameraFrames(poisoned).observations, r.observations);
  assert.deepEqual(E.inferCameraFrames(poisoned).frozen.forecast, r.forecast);
});

test('future collision parameters cannot leak into the frozen pre-impact forecast', () => {
  const a = E.runEpisode({ ...CLEAN, restitution: .25, roughnessDeg: 0 });
  const b = E.runEpisode({ ...CLEAN, restitution: .95, roughnessDeg: 14 });
  assert.notDeepEqual(a.truth, b.truth);
  assert.deepEqual(a.forecast, b.forecast);
  assert.deepEqual(a.frames.filter(f => f.t <= a.freezeTime), b.frames.filter(f => f.t <= b.freezeTime));
  const blankFuture = a.frames.map(f => f.t > a.freezeTime ? { t: f.t, pixels: null } : f);
  assert.deepEqual(E.inferCameraFrames(blankFuture).frozen.forecast, a.forecast);
  assert.equal(E.inferCameraFrames(blankFuture).inferred, null);
});

test('the corrected forecast cannot use observations after its freeze time', () => {
  const r = E.runEpisode(E.DEFAULT_CONFIG);
  assert.ok(r.correctionTime > r.impact.t);
  const truncated = r.frames.filter(f => f.t <= r.correctionTime + 1e-10);
  const replay = E.inferCameraFrames(truncated);
  assert.deepEqual(replay.correctedForecast, r.correctedForecast);
  assert.equal(replay.correctionTime, r.correctionTime);
  assert.ok(r.correctedForecast.every(p => p.t > r.correctionTime));
});

test('camera shutter integrates only states available by packet timestamp', () => {
  const sampledTimes = [], timestamp = .7, exposureMs = 70;
  const cameraState = t => { sampledTimes.push(t); return { x: .3 + t, y: .8, vx: 1, vy: 0 }; };
  const pixels = E.renderPixels(cameraState, timestamp, { ...CLEAN, exposureMs }, 100);
  assert.ok(sampledTimes.every(t => t <= timestamp && t >= timestamp - exposureMs / 1000));
  const centroid = E.detect(pixels);
  assert.ok(centroid.x < .3 + timestamp - .02, 'a trailing shutter produces a lagged centroid');
  assert.ok(Math.abs(centroid.y - .8) < .005, 'pixel y is inverted back into world y-up');
  const row = pixels.reduce((a, value, i) => value > 75 ? a + Math.floor(i / E.CAMERA.width) * value : a, 0);
  const mass = pixels.reduce((a, value) => value > 75 ? a + value : a, 0);
  assert.ok(row / mass < E.CAMERA.height / 2, 'world upper half appears in image upper half');
});

test('camera exposure, noise and loss alter pixels and evidence, not hidden state', () => {
  const a = E.runEpisode({ ...CLEAN, blackoutMs: 0 });
  const b = E.runEpisode({ ...CLEAN, blackoutMs: 500, cameraNoise: 24, dropRate: .4, exposureMs: 65 });
  assert.deepEqual(a.truth, b.truth);
  assert.notDeepEqual(a.frames[0].pixels, b.frames[0].pixels);
  assert.ok(b.metrics.receivedFrames < a.metrics.receivedFrames);
  assert.ok(b.frames.some(f => f.reason === 'Impact blackout'));
  assert.equal(b.metrics.bytes, b.metrics.receivedFrames * E.CAMERA.width * E.CAMERA.height);
});

test('uniform and predicted burst use the exact same request budget and prefix', () => {
  for (const frameBudget of [16, 28, 64]) {
    const a = E.runEpisode({ ...CLEAN, frameBudget, sampling: 'uniform' });
    const b = E.runEpisode({ ...CLEAN, frameBudget, sampling: 'burst' });
    assert.equal(a.metrics.requestedFrames, frameBudget);
    assert.equal(b.metrics.requestedFrames, frameBudget);
    assert.deepEqual(a.frames.slice(0, 6), b.frames.slice(0, 6));
    assert.deepEqual(a.forecast, b.forecast);
    assert.notDeepEqual(a.frames.slice(6).map(f => f.t), b.frames.slice(6).map(f => f.t));
  }
});

test('learned parameters improve a held-out batch and evaluation does not mutate weights', () => {
  const initial = E.createStudent(), snapshot = JSON.stringify(initial);
  const trained = E.trainStudent(CLEAN, initial, 10, 1000).student;
  assert.equal(JSON.stringify(initial), snapshot);
  assert.equal(trained.episodes, 10);
  let oldError = 0, newError = 0;
  for (let seed = 8000; seed < 8020; seed++) {
    oldError += E.runEpisode({ ...CLEAN, seed }, initial).metrics.frozenError;
    const result = E.runEpisode({ ...CLEAN, seed }, trained);
    newError += result.metrics.frozenError;
    assert.deepEqual(result.studentAfter, trained);
  }
  assert.ok(newError < oldError * .15, `held-out old ${oldError / 20}, new ${newError / 20}`);
});

test('empty camera evidence causes no training update', () => {
  const r = E.runEpisode(CLEAN);
  const replay = E.inferCameraFrames(r.frames.map(f => ({ t: f.t, pixels: null })));
  assert.equal(replay.observations.length, 0);
  assert.equal(replay.frozen.forecast.length, 0);
  assert.equal(replay.inferred, null);
});

test('bounded adversary keeps incumbent loss monotone and rejects unfair evidence loss', async () => {
  const student = E.trainStudent(CLEAN, E.createStudent(), 5, 1000).student;
  const result = await E.searchAdversary(E.DEFAULT_CONFIG, student, { candidates: 18 });
  let previous = -Infinity;
  for (const h of result.history) {
    assert.ok(h.score >= previous);
    previous = h.score;
  }
  assert.ok(result.score >= result.baselineScore);
  assert.equal(result.config.restitution, E.DEFAULT_CONFIG.restitution);
  assert.equal(result.config.drag, E.DEFAULT_CONFIG.drag);
  const hard = E.runEpisode(result.config, student);
  assert.ok(hard.metrics.preDetections >= 4 && hard.metrics.postDetections >= 4);
  assert.ok(hard.metrics.validForSearch);
});

test('launch controls set actual initial position, speed and heading; optional jitter is seeded', () => {
  const c = { ...CLEAN, startX: .4, startY: .7, speed: 1.8, headingDeg: 35, launchJitter: 0 };
  const r = E.runEpisode(c);
  assert.equal(r.initial.x, .4); assert.equal(r.initial.y, .7);
  assert.ok(Math.abs(Math.hypot(r.initial.vx, r.initial.vy) - 1.8) < 1e-12);
  assert.ok(Math.abs(Math.atan2(r.initial.vy, r.initial.vx) * 180 / Math.PI - 35) < 1e-12);
  const a = E.runEpisode({ ...c, launchJitter: .08 }), b = E.runEpisode({ ...c, launchJitter: .08 });
  assert.deepEqual(a.initial, b.initial);
  assert.notDeepEqual(a.initial, r.initial);
  assert.ok(Math.hypot(a.initial.x - c.startX, a.initial.y - c.startY) <= .08);
});

test('invalid start, jitter envelope and overlapping obstacles fail with actionable messages', () => {
  assert.throws(() => E.runEpisode({ ...CLEAN, startX: .01 }), /Move the start/);
  assert.throws(() => E.runEpisode({ ...CLEAN, startX: .1, launchJitter: .1 }), /jitter/);
  assert.throws(() => E.runEpisode({ ...CLEAN, obstacles: [{ x: .26, y: .59, radius: .1 }] }), /overlaps obstacle/);
  assert.throws(() => E.runEpisode({ ...CLEAN, obstacles: [{ x: .8, y: .6, radius: .1 }, { x: .9, y: .6, radius: .1 }] }), /overlap/);
});

test('a fast disk cannot tunnel through a small physical circle', () => {
  const obstacle = { id: 'thin', x: .8, y: .59, radius: .025 };
  const r = E.runEpisode({ ...CLEAN, blackoutMs: 0, speed: 4, obstacles: [obstacle] });
  assert.equal(r.impacts[0].id, 'thin');
  assert.ok(r.impacts[0].incoming.vx > 0 && r.impacts[0].outgoing.vx < 0);
  for (const p of r.truth) assert.ok(Math.hypot(p.x - obstacle.x, p.y - obstacle.y) >= obstacle.radius + E.WORLD.radius - 1e-6);
  assert.equal(r.preImpactForecast, false, 'early contacts must not be labelled pre-impact forecasts');
});

test('two-dimensional arena trajectories undergo multiple nonpenetrating dissipative contacts', () => {
  const obstacles = [{ id: 'A', x: .86, y: .62, radius: .14 }, { id: 'B', x: 1.2, y: .22, radius: .1 }];
  const c = { ...CLEAN, blackoutMs: 0, startX: .25, startY: .3, speed: 2.7, headingDeg: 25,
    arenaWalls: true, obstacles };
  const r = E.runEpisode(c, E.createStudent(), { learn: true });
  assert.ok(r.impacts.length >= 4);
  assert.ok(new Set(r.impacts.map(i => i.id)).size >= 3);
  for (const event of r.impacts) assert.ok(event.energyRatio <= 1 + 1e-12);
  for (const p of r.truth) {
    assert.ok(p.x >= E.WORLD.radius - 1e-6 && p.x <= E.WORLD.wallX - E.WORLD.radius + 1e-6);
    assert.ok(p.y >= E.WORLD.radius - 1e-6 && p.y <= E.WORLD.height - E.WORLD.radius + 1e-6);
    for (const o of obstacles) assert.ok(Math.hypot(p.x - o.x, p.y - o.y) >= o.radius + E.WORLD.radius - 1e-6);
  }
  assert.equal(r.studentAfter.episodes, 0, 'complex contacts must not contaminate a single-wall material fit');
  assert.match(r.learningAbstention, /restricted/);
  assert.ok(r.correctedForecast.length > 0, 'recent motion can still update prediction');
});

test('the predictor actually reflects from calibrated circles without access to hidden force or launch data', () => {
  const c = { ...CLEAN, blackoutMs: 0, obstacles: [{ id: 'bumper', x: 1.2, y: .59, radius: .1 }] };
  const student = { ...E.createStudent(), restitution: c.restitution, drag: c.drag };
  const r = E.runEpisode(c, student);
  assert.equal(r.predictedImpacts[0].id, 'bumper');
  assert.ok(r.metrics.frozenError < .015, `known-law circle error ${r.metrics.frozenError}`);
  const replay = E.inferCameraFrames(r.frames, student, E.publicCalibration(c));
  const poisoned = E.inferCameraFrames(r.frames, student, { ...c, seed: 0, restitution: .01,
    startX: 1000, speed: -10, quadraticDrag: 999, fieldStrength: 999, truth: r.truth });
  assert.deepEqual(replay.frozen.forecast, poisoned.frozen.forecast);
  assert.deepEqual(replay.frozen.forecast, r.forecast);
  const uncalibrated = E.inferCameraFrames(r.frames, student);
  assert.notDeepEqual(uncalibrated.frozen.forecast, replay.frozen.forecast);
});

test('dark obstacle pixels are real geometry but do not replace the bright moving-disk observation', () => {
  const c = { ...CLEAN, cameraNoise: 0, obstacles: [{ id: 'bumper', x: 1.2, y: .59, radius: .1 }] };
  const r = E.runEpisode(c), image = r.frames[0].pixels;
  const x = Math.floor(1.2 / E.WORLD.width * E.CAMERA.width);
  const y = Math.floor((1 - .59 / E.WORLD.height) * E.CAMERA.height);
  assert.equal(image[y * E.CAMERA.width + x], 24);
  assert.ok(Math.abs(E.detect(image).x - c.startX) < .005);
});

test('no collision, stationary starts and motion away from the wall retain finite forecasts and scores', () => {
  for (const launch of [{ speed: 0, headingDeg: 0 }, { speed: .1, headingDeg: 180 }, { speed: .15, headingDeg: 90 }]) {
    const r = E.runEpisode({ ...CLEAN, ...launch });
    assert.equal(r.impact, null); assert.deepEqual(r.impacts, []);
    assert.equal(r.preImpactForecast, false);
    assert.ok(r.forecast.length > 0);
    assert.ok(r.forecast.every(p => [p.t, p.x, p.y, p.vx, p.vy].every(Number.isFinite)));
    assert.ok(r.band.every(p => [p.lowX, p.highX, p.lowY, p.highY].every(Number.isFinite)));
    assert.ok(Number.isFinite(r.metrics.frozenError));
    assert.equal(r.frames.filter(f => f.reason === 'Impact blackout').length, 0);
  }
});

test('quadratic drag and each bounded field change motion reproducibly; zero strength reduces to the base law', () => {
  const c = { ...CLEAN, blackoutMs: 0, arenaWalls: true };
  const base = E.runEpisode(c);
  const zero = E.runEpisode({ ...c, quadraticDrag: 0, fieldStrength: 0, fieldMode: 'vortex', fieldX: .2, fieldY: .1 });
  assert.deepEqual(base.truth, zero.truth);
  const dragged = E.runEpisode({ ...c, quadraticDrag: .8 });
  assert.notDeepEqual(base.truth, dragged.truth);
  assert.ok(Math.hypot(dragged.truth.at(-1).vx, dragged.truth.at(-1).vy) < Math.hypot(base.truth.at(-1).vx, base.truth.at(-1).vy));
  for (const fieldMode of ['attract', 'repel', 'vortex']) {
    const scene = { ...c, fieldStrength: 4, fieldMode, fieldX: .9, fieldY: .65 };
    const a = E.runEpisode(scene), b = E.runEpisode(scene);
    assert.deepEqual(a.truth, b.truth);
    assert.notDeepEqual(a.truth, base.truth);
    assert.ok(a.truth.every(p => [p.x, p.y, p.vx, p.vy].every(Number.isFinite)));
    assert.ok(a.truth.every(p => Math.hypot(p.vx, p.vy) <= c.speed + 4 * a.duration + 1e-6));
    assert.equal(a.modelScope.nonlinear, true);
  }
});

test('multi-surface corrected rollout uses no camera samples after its own freeze time', () => {
  const c = { ...CLEAN, blackoutMs: 0, startX: .25, startY: .3, speed: 2.7, headingDeg: 25,
    arenaWalls: true, obstacles: [{ id: 'A', x: .86, y: .62, radius: .14 }] };
  const r = E.runEpisode(c), prefix = r.frames.filter(f => f.t <= r.correctionTime + 1e-10);
  assert.ok(r.correctionTime !== null);
  const replay = E.inferCameraFrames(prefix, E.createStudent(), E.publicCalibration(c));
  assert.deepEqual(replay.correctedForecast, r.correctedForecast);
  assert.equal(replay.correctionTime, r.correctionTime);
});

test('adversary preserves configured launch and geometry and varies only enabled nonlinear terms', async () => {
  const c = { ...E.DEFAULT_CONFIG, startX: .3, startY: .32, speed: 1.25, headingDeg: 17,
    arenaWalls: true, obstacles: [{ id: 'A', x: 1, y: .75, radius: .12 }], fieldStrength: 1 };
  const result = await E.searchAdversary(c, E.createStudent(), { candidates: 8 });
  for (const key of ['startX', 'startY', 'speed', 'headingDeg', 'arenaWalls']) assert.equal(result.config[key], c[key]);
  assert.deepEqual(result.config.obstacles, c.obstacles);
  assert.equal(result.config.quadraticDrag, 0);
  assert.ok(result.config.fieldStrength >= 0 && result.config.fieldStrength <= 8);
  if (result.score !== null) assert.ok(E.runEpisode(result.config).metrics.validForSearch);
});
