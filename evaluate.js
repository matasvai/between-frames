'use strict';
// Reproduce this toy simulator's evidence: node evaluate.js [output.json]
// Timings are host JavaScript wall time, never simulated microcontroller timings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const E = require('./engine.js');
const average = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const valid = x => Number.isFinite(x);
const training = { episodes: 20, firstSeed: 1000, lastSeed: 1019 };
const heldOut = { episodes: 40, firstSeed: 8000, lastSeed: 8039 };

function evaluateRegime(name, config) {
  const initial = E.createStudent();
  const trained = E.trainStudent(config, initial, training.episodes, training.firstSeed).student;
  const records = [];
  for (let seed = heldOut.firstSeed; seed <= heldOut.lastSeed; seed++) {
    const cold = E.runEpisode({ ...config, seed, sampling: 'uniform' }, initial);
    const uniform = E.runEpisode({ ...config, seed, sampling: 'uniform' }, trained);
    const burst = E.runEpisode({ ...config, seed, sampling: 'burst' }, trained);
    records.push({ seed, coldFrozenRMSEM: cold.metrics.frozenError,
      trainedFrozenRMSEM: uniform.metrics.frozenError,
      uniform: { correctedRMSEM: uniform.metrics.correctedError,
        frozenRMSEOnCorrectionHorizonM: uniform.metrics.frozenErrorOnCorrectedHorizon,
        correctionTimeS: uniform.correctionTime, impactTimeS: uniform.impact ? uniform.impact.t : null,
        requests: uniform.metrics.requestedFrames, received: uniform.metrics.receivedFrames },
      burst: { correctedRMSEM: burst.metrics.correctedError,
        frozenRMSEOnCorrectionHorizonM: burst.metrics.frozenErrorOnCorrectedHorizon,
        correctionTimeS: burst.correctionTime, impactTimeS: burst.impact ? burst.impact.t : null,
        requests: burst.metrics.requestedFrames, received: burst.metrics.receivedFrames } });
  }
  const paired = records.filter(r => valid(r.coldFrozenRMSEM) && valid(r.trainedFrozenRMSEM));
  const correctedPairs = records.filter(r => valid(r.uniform.correctionTimeS) && valid(r.burst.correctionTimeS));
  return { name, config, initialStudent: initial, trainedStudent: trained,
    training, heldOut, pairedForecastCount: paired.length,
    coldMeanFrozenRMSEM: average(paired.map(r => r.coldFrozenRMSEM)),
    trainedMeanFrozenRMSEM: average(paired.map(r => r.trainedFrozenRMSEM)),
    sampling: { pairedCorrectionCount: correctedPairs.length, equalRequestedBudget: config.frameBudget,
      uniformMeanCorrectionTimeS: average(correctedPairs.map(r => r.uniform.correctionTimeS)),
      burstMeanCorrectionTimeS: average(correctedPairs.map(r => r.burst.correctionTimeS)),
      uniformMeanDetectionDelayS: average(correctedPairs.map(r => r.uniform.correctionTimeS - r.uniform.impactTimeS)),
      burstMeanDetectionDelayS: average(correctedPairs.map(r => r.burst.correctionTimeS - r.burst.impactTimeS)),
      uniformMeanCorrectedRMSEM: average(correctedPairs.map(r => r.uniform.correctedRMSEM)),
      burstMeanCorrectedRMSEM: average(correctedPairs.map(r => r.burst.correctedRMSEM)),
      uniformMeanReceivedFrames: average(records.map(r => r.uniform.received)),
      burstMeanReceivedFrames: average(records.map(r => r.burst.received)),
      note: 'Equal requested frames, not equal delivered frames. Corrected forecasts begin at different times; their RMSE values are not a common-horizon head-to-head accuracy test.' },
    records };
}

function evaluateExtension(name, config, transferredStudent) {
  const records = [];
  for (let seed = 10000; seed < 10012; seed++) {
    const cold = E.runEpisode({ ...config, seed }, E.createStudent());
    const transferred = E.runEpisode({ ...config, seed }, transferredStudent);
    records.push({ seed, collisionCount: transferred.impacts.length,
      surfaces: [...new Set(transferred.impacts.map(event => event.id))],
      preImpactForecast: transferred.preImpactForecast,
      coldFrozenRMSEM: cold.metrics.frozenError, transferredFrozenRMSEM: transferred.metrics.frozenError,
      transferredCorrectedRMSEM: transferred.metrics.correctedError,
      correctionTimeS: transferred.correctionTime, learningAbstention: transferred.learningAbstention,
      allStatesFinite: transferred.truth.every(p => [p.x, p.y, p.vx, p.vy].every(Number.isFinite)),
      maximumContactEnergyRatio: transferred.impacts.length ? Math.max(...transferred.impacts.map(event => event.energyRatio)) : null });
  }
  const paired = records.filter(r => valid(r.coldFrozenRMSEM) && valid(r.transferredFrozenRMSEM));
  return { name, config, episodes: 12, firstSeed: 10000, lastSeed: 10011,
    studentSource: 'The 20-trial clean isolated-wall fit above; no training on these extension scenes.',
    pairedForecastCount: paired.length,
    coldMeanFrozenRMSEM: average(paired.map(r => r.coldFrozenRMSEM)),
    transferredMeanFrozenRMSEM: average(paired.map(r => r.transferredFrozenRMSEM)),
    meanCollisionCount: average(records.map(r => r.collisionCount)),
    preImpactForecastCount: records.filter(r => r.preImpactForecast).length,
    note: 'Small synthetic fixtures, not a benchmark of general physical reasoning. Early contacts can occur before forecast freeze. The transferred predictor knows public geometry but no nonlinear force.',
    records };
}

async function main() {
  const started = performance.now();
  const clean = { ...E.DEFAULT_CONFIG, cameraNoise: 0, dropRate: 0, exposureMs: 0,
    bounceRandomness: 0, roughnessDeg: 0, blackoutMs: 250, launchJitter: .02 };
  const cleanResult = evaluateRegime('varied clean launches with 250 ms impact blackout', clean);
  const defaultResult = evaluateRegime('default stochastic bounce and camera', { ...E.DEFAULT_CONFIG });
  const extensionBase = { ...clean, blackoutMs: 80, frameBudget: 40, launchJitter: .015 };
  const extensions = [
    evaluateExtension('calibrated circular bumper', { ...extensionBase,
      obstacles: [{ id: 'bumper', x: 1.2, y: .59, radius: .1 }] }, cleanResult.trainedStudent),
    evaluateExtension('multiple contacts in a closed arena', { ...extensionBase, startX: .25,
      startY: .3, speed: 2.7, headingDeg: 25, arenaWalls: true,
      obstacles: [{ id: 'A', x: .86, y: .62, radius: .14 }, { id: 'B', x: 1.2, y: .22, radius: .1 }] }, cleanResult.trainedStudent),
    evaluateExtension('unmodelled vortex and quadratic drag', { ...extensionBase, arenaWalls: true,
      fieldStrength: 3, fieldMode: 'vortex', fieldX: .9, fieldY: .65, fieldRadius: .35,
      quadraticDrag: .25 }, cleanResult.trainedStudent)
  ];
  const searchStart = performance.now();
  const adversary = await E.searchAdversary(E.DEFAULT_CONFIG, defaultResult.trainedStudent, { candidates: 36 });
  const searchHostMs = performance.now() - searchStart;
  const hardest = E.runEpisode(adversary.config, defaultResult.trainedStudent);
  const evidence = { generatedAt: new Date().toISOString(), engineSha256: crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, 'engine.js'))).digest('hex'),
    units: { distances: 'metres', times: 'seconds unless explicitly Ms', errors: 'position RMSE, not endpoint distance' },
    protocol: { forecast: 'Shared six-frame early request prefix, forecast frozen at 0.46 seconds.',
      correction: 'Adequate isolated-wall rebound fit, or a recent stable four-observation motion fit that disagrees with the frozen forecast; a separate forecast is frozen at that time.',
      camera: '96 by 64 grayscale raster. Shutter integrates [packet timestamp minus exposure, packet timestamp]; this induces observation lag.',
      metric: 'Frozen RMSE begins at max(freeze time + 0.03 seconds, first collision time + 0.03 seconds), or freeze time + 0.03 if no contact. Simulator truth is used only for evaluation.',
      launchVariation: 'Clean training/test launches use a 0.02 m uniform-disk position jitter. Extension fixtures use 0.015 m. Default stochastic trials retain a fixed launch and vary hidden impacts/camera noise.',
      learning: 'Effective restitution and linear drag fitted from adequate isolated-wall raster trajectories; cold prior restitution 0.58 and drag 0.06. Multiple-surface scenes abstain from parameter fitting.',
      adversary: 'Bounded search over sensor settings, impact randomness, surface roughness and seed. Starting settings and geometry are retained; enabled nonlinear force coefficients may also vary. This default evaluation has no nonlinear forces enabled.' },
    regimes: [cleanResult, defaultResult], extensions,
    adversary: { config: adversary.config, candidates: adversary.candidates,
      rejectedCount: adversary.rejected.length, eligibleCount: adversary.candidates - adversary.rejected.length,
      baselineFrozenRMSEM: adversary.baselineScore, selectedFrozenRMSEM: adversary.score,
      selectedCorrectedRMSEM: hardest.metrics.correctedError,
      selectedPreDetections: hardest.metrics.preDetections, selectedPostDetections: hardest.metrics.postDetections,
      requestedFrames: hardest.metrics.requestedFrames, receivedFrames: hardest.metrics.receivedFrames,
      correctionTimeS: hardest.correctionTime, impactTimeS: hardest.impact ? hardest.impact.t : null,
      hostSearchTimeMs: searchHostMs, history: adversary.history,
      note: 'Selected-case search result, not held-out adversarial generalization.' },
    hostRunTimeMs: performance.now() - started,
    limitations: [
      'Synthetic toy system, known camera and static geometry calibration. No hardware deployment, timing, memory-budget or energy measurements.',
      'Analytic low-dimensional student and evolutionary adversary; neither is a trained neural network.',
      'The generator explicitly draws unobserved impact randomness. Residual error here does not establish irreducibility for real collisions or arbitrary models.',
      'Uncertainty bands are heuristic and have not been calibrated or evaluated for coverage.',
      'The clean experiment demonstrates parameter learning within a known model family, not discovery of new physical laws.',
      'Small deterministic seed sets, no confidence intervals, and no claim of universal superiority for predicted burst sampling.',
      'Complex-geometry runs update motion but do not fit material parameters; the baseline has no representation for nonlinear force coefficients. A good effective linear fit is not proof of the true force law.',
      'The numerical simulator uses small-step approximations for fields and quadratic drag, with swept geometric contact checks. No solver-convergence study is claimed.',
      'Observed rebound identifies an effective velocity jump; no contact force, duration, spin or detailed impact mechanism is recovered.' ] };
  const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'evidence.json');
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ output, regimes: evidence.regimes.map(r => ({ name: r.name,
    coldMeanFrozenRMSEM: r.coldMeanFrozenRMSEM, trainedMeanFrozenRMSEM: r.trainedMeanFrozenRMSEM,
    sampling: r.sampling })), extensions: extensions.map(r => ({ name: r.name,
    coldMeanFrozenRMSEM: r.coldMeanFrozenRMSEM, transferredMeanFrozenRMSEM: r.transferredMeanFrozenRMSEM,
    meanCollisionCount: r.meanCollisionCount, preImpactForecastCount: r.preImpactForecastCount })), adversary: { baseline: adversary.baselineScore,
    selected: adversary.score, rejected: adversary.rejected.length, hostSearchTimeMs: searchHostMs } }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
