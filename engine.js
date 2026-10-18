(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CollisionLab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const WORLD = Object.freeze({ width: 1.8, height: 1.2, wallX: 1.6, radius: 0.055 });
  const CAMERA = Object.freeze({ width: 96, height: 64 });
  const DEFAULT_CONFIG = Object.freeze({ seed: 42, restitution: 0.76, bounceRandomness: 0.08,
    roughnessDeg: 4, drag: 0.14, cameraNoise: 8, dropRate: 0.04, blackoutMs: 170,
    exposureMs: 14, frameBudget: 28, sampling: 'uniform', startX: .26, startY: .59,
    speed: 1.35, headingDeg: 0, launchJitter: 0, obstacles: [], quadraticDrag: 0,
    fieldStrength: 0, fieldX: .95, fieldY: .6, fieldRadius: .3, fieldMode: 'attract', arenaWalls: false });
  const DURATION = 2.5, FREEZE_TIME = 0.46, HIT_X = WORLD.wallX - WORLD.radius;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const copy = o => JSON.parse(JSON.stringify(o));
  function rng(seed) {
    let s = seed >>> 0;
    return function () { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function gaussian(random) {
    let spare = null;
    return () => { if (spare !== null) { const x = spare; spare = null; return x; }
      const u = Math.max(1e-12, random()), a = 2 * Math.PI * random(), r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(a); return r * Math.cos(a); };
  }
  function normalizedConfig(config) {
    const c = Object.assign({}, DEFAULT_CONFIG, config);
    c.seed = Number(c.seed) >>> 0;
    for (const [key, lo, hi] of [['restitution', .2, .96], ['bounceRandomness', 0, .3],
      ['roughnessDeg', 0, 16], ['drag', 0, .5], ['cameraNoise', 0, 24],
      ['dropRate', 0, .4], ['blackoutMs', 0, 550], ['exposureMs', 0, 70],
      ['speed', 0, 4], ['headingDeg', -180, 180], ['launchJitter', 0, .15],
      ['quadraticDrag', 0, 2], ['fieldStrength', 0, 8], ['fieldRadius', .05, .8],
      ['fieldX', 0, WORLD.width], ['fieldY', 0, WORLD.height]])
      c[key] = clamp(Number(c[key]) || 0, lo, hi);
    c.startX = Number(c.startX); c.startY = Number(c.startY);
    c.arenaWalls = !!c.arenaWalls;
    c.fieldMode = ['attract', 'repel', 'vortex'].includes(c.fieldMode) ? c.fieldMode : 'attract';
    c.obstacles = (Array.isArray(c.obstacles) ? c.obstacles : []).map((o, i) => ({
      id: String(o.id || 'obstacle-' + (i + 1)), x: Number(o.x), y: Number(o.y), radius: Number(o.radius) }));
    c.frameBudget = Math.round(clamp(Number(c.frameBudget) || 28, 16, 64));
    c.sampling = c.sampling === 'burst' ? 'burst' : 'uniform';
    return c;
  }
  function validateConfig(config) {
    const c = normalizedConfig(config), r = WORLD.radius, j = c.launchJitter;
    if (!Number.isFinite(c.startX) || !Number.isFinite(c.startY)) throw new Error('Starting X and Y must be finite numbers.');
    if (c.startX - j < r || c.startX + j > HIT_X || c.startY - j < r || c.startY + j > WORLD.height - r)
      throw new Error('Move the start inside the visible arena and away from its edges, or reduce launch jitter.');
    if (c.obstacles.length > 12) throw new Error('Use at most 12 circular obstacles.');
    for (let i = 0; i < c.obstacles.length; i++) {
      const o = c.obstacles[i];
      if (![o.x, o.y, o.radius].every(Number.isFinite) || o.radius < .025 || o.radius > .3)
        throw new Error('Obstacle ' + (i + 1) + ' needs finite coordinates and radius between 0.025 and 0.30 m.');
      if (o.x - o.radius < 0 || o.x + o.radius > WORLD.wallX || o.y - o.radius < 0 || o.y + o.radius > WORLD.height)
        throw new Error('Move obstacle ' + (i + 1) + ' fully inside the arena, to the left of the fixed wall.');
      if (Math.hypot(c.startX - o.x, c.startY - o.y) < r + o.radius + j + .003)
        throw new Error('The starting disk or its jitter range overlaps obstacle ' + (i + 1) + '. Move the start or obstacle.');
      for (let k = 0; k < i; k++) if (Math.hypot(o.x - c.obstacles[k].x, o.y - c.obstacles[k].y) < o.radius + c.obstacles[k].radius + .001)
        throw new Error('Obstacles ' + (k + 1) + ' and ' + (i + 1) + ' overlap. Move them apart.');
    }
    return c;
  }
  function publicCalibration(source = {}) {
    // Whitelist only public geometry. Launch, forces, seed, material and truth are deliberately excluded.
    return { arenaWalls: !!source.arenaWalls, obstacles: (source.obstacles || []).map((o, i) => ({
      id: String(o.id || 'obstacle-' + (i + 1)), x: Number(o.x), y: Number(o.y), radius: Number(o.radius) })) };
  }
  function createStudent() {
    return { restitution: .58, drag: .06, tangentRetention: .96, episodes: 0,
      bounceStd: .13, roughnessStd: .07, restitutionM2: 0, restitutionMean: 0,
      dragWeight: 0, lastFit: null };
  }
  function drift(state, dt, drag) {
    const decay = Math.exp(-drag * dt), g = drag < 1e-8 ? dt : -Math.expm1(-drag * dt) / drag;
    return { x: state.x + state.vx * g, y: state.y + state.vy * g,
      vx: state.vx * decay, vy: state.vy * decay };
  }
  function timeToWall(state, drag) {
    if (!(state.vx > 0)) return Infinity;
    const distance = HIT_X - state.x;
    if (distance < 0) return Infinity;
    if (drag < 1e-8) return distance / state.vx;
    const q = distance * drag / state.vx;
    return q >= 1 ? Infinity : -Math.log1p(-q) / drag;
  }
  function firstContact(state, end, geometry) {
    const dx = end.x - state.x, dy = end.y - state.y;
    let best = null;
    const consider = (u, nx, ny, id, type) => {
      if (u >= -1e-9 && u <= 1 + 1e-9 && dx * nx + dy * ny < -1e-12 && (!best || u < best.u))
        best = { u: clamp(u, 0, 1), nx, ny, id, type };
    };
    if (dx > 0) consider((HIT_X - state.x) / dx, -1, 0, 'right-wall', 'wall');
    if (geometry.arenaWalls) {
      if (dx < 0) consider((WORLD.radius - state.x) / dx, 1, 0, 'left-wall', 'wall');
      if (dy < 0) consider((WORLD.radius - state.y) / dy, 0, 1, 'bottom-wall', 'wall');
      if (dy > 0) consider((WORLD.height - WORLD.radius - state.y) / dy, 0, -1, 'top-wall', 'wall');
    }
    const aa = dx * dx + dy * dy;
    if (aa > 1e-20) for (const o of geometry.obstacles) {
      const ox = state.x - o.x, oy = state.y - o.y, radius = WORLD.radius + o.radius;
      const bb = 2 * (ox * dx + oy * dy), cc = ox * ox + oy * oy - radius * radius;
      const disc = bb * bb - 4 * aa * cc;
      if (disc < 0) continue;
      const u = (-bb - Math.sqrt(disc)) / (2 * aa), px = ox + u * dx, py = oy + u * dy;
      const length = Math.hypot(px, py) || 1;
      consider(u, px / length, py / length, o.id, 'obstacle');
    }
    return best;
  }
  function reflect(incoming, contact, restitution, angle = 0, tangentRetention = .96) {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const nx = contact.nx * ca - contact.ny * sa, ny = contact.nx * sa + contact.ny * ca;
    const tx = -ny, ty = nx, vn = incoming.vx * nx + incoming.vy * ny;
    const vt = incoming.vx * tx + incoming.vy * ty;
    let vx = -restitution * vn * nx + tangentRetention * vt * tx;
    let vy = -restitution * vn * ny + tangentRetention * vt * ty;
    // A rough micro-normal cannot send a disk back into the geometric surface.
    // Removing any inward component is an additional dissipative projection.
    const inward = vx * contact.nx + vy * contact.ny;
    if (inward < 0) { vx -= inward * contact.nx; vy -= inward * contact.ny; }
    return { x: incoming.x + contact.nx * 1e-8, y: incoming.y + contact.ny * 1e-8, vx, vy };
  }
  function advanceLinear(state, dt, drag, geometry, response, time) {
    let current = { ...state }, remaining = dt, elapsed = 0; const impacts = [];
    for (let count = 0; count < 10 && remaining > 1e-10; count++) {
      const end = drift(current, remaining, drag), hit = firstContact(current, end, geometry);
      if (!hit) { current = end; elapsed += remaining; remaining = 0; break; }
      const travel = drag < 1e-8 ? remaining * hit.u : -Math.log1p(-hit.u * -Math.expm1(-drag * remaining)) / drag;
      const incoming = drift(current, travel, drag), responseParams = response();
      const outgoing = reflect(incoming, hit, responseParams.restitution, responseParams.angle, responseParams.tangentRetention);
      const energy = incoming.vx ** 2 + incoming.vy ** 2;
      impacts.push({ t: time + elapsed + travel, x: incoming.x, y: incoming.y, id: hit.id,
        type: hit.type, normal: { x: hit.nx, y: hit.ny }, incoming: { ...incoming }, outgoing: { ...outgoing },
        realizedRestitution: responseParams.restitution, normalAngle: responseParams.angle,
        energyRatio: energy > 1e-20 ? (outgoing.vx ** 2 + outgoing.vy ** 2) / energy : 0 });
      current = outgoing; elapsed += travel; remaining -= travel;
    }
    // Extremely narrow multi-contact configurations can jam. Stop without penetrating geometry.
    if (remaining > 1e-10) { current.vx = 0; current.vy = 0; }
    return { state: current, impacts };
  }
  function fieldAcceleration(state, c) {
    if (!c.fieldStrength) return { x: 0, y: 0 };
    const dx = c.fieldX - state.x, dy = c.fieldY - state.y, r2 = dx * dx + dy * dy;
    const scale = c.fieldStrength * Math.exp(-.5 * r2 / (c.fieldRadius ** 2)) / Math.sqrt(r2 + (.2 * c.fieldRadius) ** 2);
    if (c.fieldMode === 'vortex') return { x: scale * dy, y: -scale * dx };
    const sign = c.fieldMode === 'repel' ? -1 : 1;
    return { x: sign * scale * dx, y: sign * scale * dy };
  }
  function createTrajectory(initial, startTime, endTime, geometry, parameters, response, step = .005) {
    let state = { ...initial }, time = startTime;
    const truth = [{ t: time, ...state }], impacts = [];
    while (time < endTime - 1e-10) {
      const dt = Math.min(step, endTime - time), field = fieldAcceleration(state, parameters);
      state.vx += field.x * dt / 2; state.vy += field.y * dt / 2;
      // Frozen-speed drag coefficient is a small-step approximation to -q |v| v.
      const drag = parameters.drag + (parameters.quadraticDrag || 0) * Math.hypot(state.vx, state.vy);
      const move = advanceLinear(state, dt, drag, geometry, response, time);
      state = move.state;
      const nextField = fieldAcceleration(state, parameters);
      state.vx += nextField.x * dt / 2; state.vy += nextField.y * dt / 2;
      for (const event of move.impacts) {
        impacts.push(event);
        truth.push({ t: Math.max(time, event.t - 1e-9), ...event.incoming });
        truth.push({ t: event.t, ...event.outgoing });
      }
      time += dt; truth.push({ t: time, ...state });
    }
    truth.sort((a, b) => a.t - b.t);
    return { truth, impacts, impact: impacts[0] || null, at: t => sampleTruth(truth, t) };
  }
  function makeWorld(c) {
    const random = rng(c.seed), normal = gaussian(random), phase = random() * 2 * Math.PI;
    const jitter = Math.sqrt(random()) * c.launchJitter, heading = c.headingDeg * Math.PI / 180;
    const initial = { x: c.startX + jitter * Math.cos(phase), y: c.startY + jitter * Math.sin(phase),
      vx: c.speed * Math.cos(heading), vy: c.speed * Math.sin(heading) };
    const response = () => ({ restitution: clamp(c.restitution + c.bounceRandomness * normal(), .15, .98),
      angle: clamp(normal(), -2, 2) * c.roughnessDeg * Math.PI / 180, tangentRetention: .96 });
    const world = createTrajectory(initial, 0, DURATION, publicCalibration(c), c, response,
      c.quadraticDrag || c.fieldStrength ? .002 : .005);
    return { ...world, initial };
  }
  function sampleTruth(truth, t) {
    if (t <= truth[0].t) return Object.assign({}, truth[0], { t });
    if (t >= truth[truth.length - 1].t) return Object.assign({}, truth[truth.length - 1], { t });
    let lo = 0, hi = truth.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (truth[m].t <= t) lo = m; else hi = m; }
    const a = truth[lo], b = truth[hi], u = (t - a.t) / (b.t - a.t);
    return { t, x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y),
      vx: a.vx + u * (b.vx - a.vx), vy: a.vy + u * (b.vy - a.vy) };
  }
  function renderPixels(at, t, c, noiseSeed) {
    const { width: w, height: h } = CAMERA, values = new Float32Array(w * h); values.fill(12);
    // Static geometry is dark; only the moving disk is intentionally above the detector threshold.
    for (const o of c.obstacles || []) {
      const cx = o.x / WORLD.width * w - .5, cy = (1 - o.y / WORLD.height) * h - .5;
      const radius = o.radius / WORLD.width * w;
      for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(h - 1, Math.ceil(cy + radius)); y++)
        for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(w - 1, Math.ceil(cx + radius)); x++)
          if (Math.hypot(x - cx, y - cy) <= radius) values[y * w + x] = 24;
    }
    const exposure = c.exposureMs / 1000, samples = exposure > 0 ? 7 : 1;
    const r = WORLD.radius * w / WORLD.width;
    for (let k = 0; k < samples; k++) {
      // Packets are timestamped at shutter close; trailing integration introduces centroid lag.
      const sampleT = Math.max(0, t - exposure + exposure * (k + .5) / samples);
      const p = at(sampleT), cx = p.x / WORLD.width * w - .5, cy = (1 - p.y / WORLD.height) * h - .5;
      for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(h - 1, Math.ceil(cy + r + 1)); y++)
        for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(w - 1, Math.ceil(cx + r + 1)); x++)
          values[y * w + x] += 208 / samples * clamp(r + .5 - Math.hypot(x - cx, y - cy), 0, 1);
    }
    const pixels = new Uint8Array(w * h), normal = gaussian(rng(noiseSeed));
    for (let i = 0; i < pixels.length; i++) pixels[i] = clamp(Math.round(values[i] + c.cameraNoise * normal()), 0, 255);
    return pixels;
  }
  function detect(pixels) {
    if (!pixels || pixels.length !== CAMERA.width * CAMERA.height) return null;
    // Thresholded intensity centroid; no simulator state or object coordinates enter here.
    let mass = 0, sx = 0, sy = 0, count = 0;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] > 75) {
      const weight = pixels[i] - 75; mass += weight; sx += (i % CAMERA.width + .5) * weight;
      sy += (Math.floor(i / CAMERA.width) + .5) * weight; count++;
    }
    if (count < 7 || mass < 600) return null;
    return { x: sx / mass / CAMERA.width * WORLD.width, y: (1 - sy / mass / CAMERA.height) * WORLD.height };
  }
  function capture(world, t, c) {
    const salt = Math.round(t * 1e7), random = rng((c.seed ^ salt ^ 0x7263A18D) >>> 0);
    const blackout = world.impacts.some(impact => Math.abs(t - impact.t) < c.blackoutMs / 2000);
    const dropped = blackout || random() < c.dropRate;
    const pixels = dropped ? null : renderPixels(world.at, t, c, (c.seed ^ salt ^ 0x15735309) >>> 0);
    return { t, pixels, detected: detect(pixels), dropped, reason: blackout ? 'Impact blackout' : dropped ? 'Packet loss' : '' };
  }
  function observationsFrom(frames) {
    return frames.map(f => { const p = detect(f.pixels); return p ? { t: f.t, x: p.x, y: p.y } : null; }).filter(Boolean);
  }
  function fitSegment(obs, drag) {
    if (obs.length < 2) return null;
    const t0 = obs[0].t;
    let sg = 0, sgg = 0, sx = 0, sy = 0, sgx = 0, sgy = 0;
    for (const p of obs) { const dt = p.t - t0, g = drag < 1e-8 ? dt : -Math.expm1(-drag * dt) / drag;
      sg += g; sgg += g * g; sx += p.x; sy += p.y; sgx += g * p.x; sgy += g * p.y; }
    const n = obs.length, denom = n * sgg - sg * sg;
    if (denom < 1e-10) return null;
    const vx = (n * sgx - sg * sx) / denom, vy = (n * sgy - sg * sy) / denom;
    const state = { x: (sx - vx * sg) / n, y: (sy - vy * sg) / n, vx, vy };
    let sse = 0;
    for (const p of obs) { const q = drift(state, p.t - t0, drag); sse += (p.x - q.x) ** 2 + (p.y - q.y) ** 2; }
    return { t0, state, sse, drag, at: t => drift(state, t - t0, drag) };
  }
  function bestDrag(segments) {
    let best = { drag: .06, loss: Infinity };
    for (let i = 0; i <= 120; i++) {
      const drag = i * .005; let loss = 0;
      for (const obs of segments) { const fit = fitSegment(obs, drag); if (!fit) { loss = Infinity; break; } loss += fit.sse; }
      if (loss < best.loss) best = { drag, loss };
    }
    return best;
  }
  function findImpactSplit(obs, drag) {
    if (obs.length < 8) return null;
    let best = null;
    for (let split = 4; split <= obs.length - 4; split++) {
      const preObs = obs.slice(0, split), postObs = obs.slice(split);
      const pre = fitSegment(preObs, drag), post = fitSegment(postObs, drag);
      if (!pre || !post || pre.state.vx <= .1 || post.state.vx >= -.04) continue;
      const forward = timeToWall(pre.state, drag), impactT = pre.t0 + forward;
      if (!Number.isFinite(impactT) || impactT < preObs[preObs.length - 1].t - .065 || impactT > postObs[0].t + .065) continue;
      const pp = pre.at(impactT), pq = post.at(impactT);
      const contactResidual = (pq.x - HIT_X) ** 2 + (pq.y - pp.y) ** 2;
      const loss = pre.sse + post.sse + 2 * contactResidual;
      if (!best || loss < best.loss) best = { pre, post, preObs, postObs, split, impactT, loss };
    }
    return best;
  }
  function projectEstimateOutsideGeometry(state, geometry) {
    const s = { ...state };
    s.x = Math.min(HIT_X - 1e-7, s.x);
    if (geometry.arenaWalls) { s.x = Math.max(WORLD.radius + 1e-7, s.x);
      s.y = clamp(s.y, WORLD.radius + 1e-7, WORLD.height - WORLD.radius - 1e-7); }
    for (const o of geometry.obstacles) {
      const dx = s.x - o.x, dy = s.y - o.y, distance = Math.hypot(dx, dy), needed = o.radius + WORLD.radius;
      if (distance < needed) { const nx = distance > 1e-9 ? dx / distance : -1, ny = distance > 1e-9 ? dy / distance : 0;
        s.x = o.x + nx * (needed + 1e-7); s.y = o.y + ny * (needed + 1e-7); }
    }
    return s;
  }
  function modelRollout(state, time, student, geometry) {
    const initial = projectEstimateOutsideGeometry(state, geometry);
    return createTrajectory(initial, time, DURATION, geometry,
      { drag: student.drag, quadraticDrag: 0, fieldStrength: 0 },
      () => ({ restitution: student.restitution, angle: 0, tangentRetention: student.tangentRetention }), .02);
  }
  function predictFromPrefix(observations, student, calibration = {}) {
    const geometry = publicCalibration(calibration);
    let fit = fitSegment(observations, student.drag);
    if (!fit || observations.length < 3) return { forecast: [], band: [], estimatedImpactTime: null, fit: null };
    // An early observed contact invalidates a single launch fit. Use the most recent motion instead.
    if (Math.sqrt(fit.sse / observations.length) > .012) fit = fitSegment(observations.slice(-3), student.drag);
    const state = fit.at(FREEZE_TIME), rollout = modelRollout(state, FREEZE_TIME, student, geometry);
    const impactT = rollout.impact ? rollout.impact.t : null, speed = Math.hypot(state.vx, state.vy);
    const forecast = [], band = [];
    for (let i = 0; i <= 125; i++) {
      const t = i * DURATION / 125;
      if (t < FREEZE_TIME) continue;
      const p = rollout.at(t); forecast.push(p);
      const elapsed = impactT === null ? 0 : Math.max(0, t - impactT);
      const sx = .008 + speed * student.bounceStd * elapsed;
      const sy = .008 + speed * student.roughnessStd * 2 * elapsed;
      band.push({ t, lowX: p.x - 2 * sx, highX: p.x + 2 * sx, lowY: p.y - 2 * sy, highY: p.y + 2 * sy });
    }
    return { forecast, band, estimatedImpactTime: impactT, fit, predictedImpacts: rollout.impacts };
  }
  function makeSchedule(remaining, sampling, estimatedImpactTime) {
    const start = .54, end = DURATION - .04;
    if (sampling !== 'burst' || !Number.isFinite(estimatedImpactTime))
      return Array.from({ length: remaining }, (_, i) => start + (end - start) * i / (remaining - 1));
    // Inverse-CDF allocation: a fixed baseline density plus a contact-centred triangular burst.
    // The density depends only on the frozen prefix prediction, never the actual impact.
    const n = 1200, cumulative = [0], ts = [start];
    for (let i = 1; i <= n; i++) { const t = start + (end - start) * i / n;
      const density = 1 + 5 * Math.max(0, 1 - Math.abs(t - estimatedImpactTime) / .4);
      cumulative.push(cumulative[i - 1] + density); ts.push(t); }
    const total = cumulative[n];
    return Array.from({ length: remaining }, (_, i) => {
      const target = total * i / (remaining - 1); let lo = 0, hi = n;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cumulative[m] < target) lo = m; else hi = m; }
      const u = (target - cumulative[lo]) / (cumulative[hi] - cumulative[lo]); return ts[lo] + u * (ts[hi] - ts[lo]);
    });
  }
  function errorAtTruth(path, world, fromTime) {
    const points = path.filter(p => p.t >= fromTime);
    if (!points.length) return null;
    return Math.sqrt(points.reduce((s, p) => { const q = world.at(p.t); return s + (p.x - q.x) ** 2 + (p.y - q.y) ** 2; }, 0) / points.length);
  }
  function inferObservedEpisode(observations, student) {
    let split = findImpactSplit(observations, student.drag);
    if (!split) return null;
    const fittedDrag = bestDrag([split.preObs, split.postObs]).drag;
    split = findImpactSplit(observations, fittedDrag) || split;
    const incoming = split.pre.at(split.impactT), outgoing = split.post.at(split.impactT);
    if (Math.sqrt(split.loss / observations.length) > .006) return null;
    return { drag: fittedDrag, restitution: clamp(-outgoing.vx / incoming.vx, .05, 1),
      lateralRatio: outgoing.vy / Math.max(.1, incoming.vx), split,
      residual: Math.sqrt(split.loss / observations.length), observations: observations.length };
  }
  function updateStudent(student, inferred) {
    const s = copy(student);
    if (!inferred) return s;
    const n = s.episodes + 1, rate = 1 / n, e = inferred.restitution;
    const previousMean = s.restitutionMean || 0, mean = previousMean + (e - previousMean) * rate;
    s.restitutionM2 = (s.restitutionM2 || 0) + (e - previousMean) * (e - mean);
    s.restitutionMean = mean; s.restitution = mean; s.drag += (inferred.drag - s.drag) * rate;
    s.bounceStd = n > 2 ? Math.max(.035, Math.sqrt(s.restitutionM2 / (n - 1))) : .13;
    s.roughnessStd = Math.sqrt(((s.roughnessStd || .07) ** 2 * (n - 1) + (inferred.lateralRatio / 2) ** 2) / n);
    s.roughnessStd = Math.max(.015, s.roughnessStd); s.episodes = n;
    s.lastFit = { restitution: e, drag: inferred.drag, residual: inferred.residual, observations: inferred.observations };
    return s;
  }
  function inferCameraFrames(frames, student = createStudent(), calibration = {}) {
    const before = Object.assign(createStudent(), copy(student)), geometry = publicCalibration(calibration);
    const observations = observationsFrom(frames);
    const frozen = predictFromPrefix(observations.filter(p => p.t <= FREEZE_TIME), before, geometry);
    const supportsFit = geometry.obstacles.length === 0 && !geometry.arenaWalls;
    let correctedForecast = [], correctionTime = null, detectedImpactTime = null, correctionReason = null;
    const clock = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now(), started = clock();
    for (let n = 8; n <= observations.length; n++) {
      const prefixOnly = observations.slice(0, n), currentTime = prefixOnly[n - 1].t;
      if (currentTime < FREEZE_TIME + .16) continue;
      const inferred = supportsFit ? inferObservedEpisode(prefixOnly, before) : null;
      let state, rolloutStudent = before;
      if (inferred) {
        detectedImpactTime = inferred.split.impactT;
        state = inferred.split.post.at(currentTime);
        rolloutStudent = { ...before, drag: inferred.drag };
        correctionReason = 'Single-wall rebound fitted from observed trajectories';
      } else {
        if (supportsFit && frozen.estimatedImpactTime !== null && currentTime < frozen.estimatedImpactTime + .2) continue;
        const recent = prefixOnly.slice(-4), fit = fitSegment(recent, before.drag);
        if (!fit || recent[3].t - recent[0].t < .09 || Math.sqrt(fit.sse / recent.length) > .016) continue;
        state = fit.at(currentTime);
        const predicted = frozen.forecast.length ? sampleTruth(frozen.forecast, currentTime) : null;
        if (predicted && Math.hypot(state.x - predicted.x, state.y - predicted.y) < .035) continue;
        correctionReason = 'Recent stable camera motion disagrees with the frozen rollout; velocity update only';
      }
      correctionTime = currentTime;
      const rollout = modelRollout(state, correctionTime, rolloutStudent, geometry);
      for (let i = 0; i <= 125; i++) { const t = i * DURATION / 125;
        if (t > correctionTime + .015) correctedForecast.push(rollout.at(t)); }
      break;
    }
    // The learner cannot identify force coefficients it has never represented. A poor fit abstains;
    // a good single-wall fit is still an effective linear model, not proof of the true force law.
    const inferred = supportsFit ? inferObservedEpisode(observations, before) : null;
    const learningAbstention = inferred ? null : supportsFit
      ? 'No adequate isolated-wall linear fit from these observations.'
      : 'Parameter fitting is restricted to isolated-wall scenes; obstacle/arena scenes use motion updates only.';
    const fitMs = clock() - started;
    return { observations, frozen, correctedForecast, correctionTime, detectedImpactTime, inferred, fitMs,
      correctionReason, learningAbstention };
  }
  function runEpisode(config, student = createStudent(), options = {}) {
    const c = validateConfig(config), before = Object.assign(createStudent(), copy(student));
    const geometry = publicCalibration(c), world = makeWorld(c), prefixTimes = [0, .085, .17, .255, .34, .425];
    const prefix = prefixTimes.map(t => capture(world, t, c));
    const prefixObs = observationsFrom(prefix), frozen = predictFromPrefix(prefixObs, before, geometry);
    const schedule = makeSchedule(c.frameBudget - prefix.length, c.sampling, frozen.estimatedImpactTime);
    const frames = prefix.concat(schedule.map(t => capture(world, t, c))), observations = observationsFrom(frames);
    const inference = inferCameraFrames(frames, before, geometry);
    const { correctedForecast, correctionTime, detectedImpactTime, inferred, fitMs, correctionReason, learningAbstention } = inference;
    const after = options.learn ? updateStudent(before, inferred) : copy(before);
    const postTime = Math.max(FREEZE_TIME + .03, world.impact ? world.impact.t + .03 : FREEZE_TIME + .03);
    const received = frames.filter(f => !f.dropped).length;
    const fairImpact = world.impacts.find(event => observations.filter(p => p.t < event.t - .02).length >= 4 &&
      observations.filter(p => p.t > event.t + .02).length >= 4);
    const referenceTime = fairImpact ? fairImpact.t : world.impact ? world.impact.t : FREEZE_TIME;
    const preDetections = observations.filter(p => p.t < referenceTime - .02).length;
    const postDetections = observations.filter(p => p.t > referenceTime + .02).length;
    const preImpactForecast = !!world.impact && FREEZE_TIME < world.impact.t && frozen.forecast.length > 0;
    const events = [{ t: FREEZE_TIME, text: frozen.forecast.length ? 'Forecast frozen from available camera prefix' : 'Insufficient camera prefix for a forecast' },
      ...world.impacts.map(event => ({ t: event.t, text: 'Contact with ' + event.id + ' (simulator truth; hidden from student)' }))];
    if (correctionTime !== null) events.push({ t: correctionTime, text: correctionReason + '; separate forecast frozen' });
    if (options.learn && inferred) events.push({ t: DURATION, text: 'Adequate observed single-wall fit updates effective parameters for the next trial' });
    events.sort((a, b) => a.t - b.t);
    return { config: c, truth: world.truth, initial: world.initial, impacts: world.impacts,
      frames, observations, forecast: frozen.forecast, correctedForecast, band: frozen.band, impact: world.impact,
      studentBefore: before, studentAfter: after, duration: DURATION, freezeTime: FREEZE_TIME, correctionTime,
      estimatedImpactTime: frozen.estimatedImpactTime, predictedImpacts: frozen.predictedImpacts || [],
      detectedImpactTime, eventLog: events, preImpactForecast, correctionReason, learningAbstention,
      modelScope: { nonlinear: c.quadraticDrag > 0 || c.fieldStrength > 0,
        multipleSurfaces: c.obstacles.length > 0 || c.arenaWalls,
        simulator: '2D disk, static circles and walls, dissipative contacts, optional quadratic drag and bounded localized field.',
        predictor: 'Known public geometry, camera-estimated state, learned effective restitution and linear drag. No access to force coefficients or launch state.',
        learning: 'Effective parameters only for an adequate isolated-wall fit; complex geometry uses velocity updates. Nonlinear coefficients are never learned.' },
      learned: inferred ? { restitution: inferred.restitution, drag: inferred.drag,
        residual: inferred.residual, observations: inferred.observations } : null,
      metrics: { frozenError: errorAtTruth(frozen.forecast, world, postTime), scoreStartTime: postTime,
        correctedError: errorAtTruth(correctedForecast, world, (correctionTime || DURATION) + .015),
        frozenErrorOnCorrectedHorizon: correctionTime === null ? null : errorAtTruth(frozen.forecast, world, correctionTime + .015),
        requestedFrames: frames.length, receivedFrames: received, detectedFrames: observations.length,
        bytes: received * CAMERA.width * CAMERA.height, fitMs, preDetections, postDetections,
        validForSearch: preDetections >= 4 && postDetections >= 4 && prefixObs.length >= 4 && frozen.forecast.length > 0,
        impactObserved: world.impacts.some(event => frames.some(f => !f.dropped && Math.abs(f.t - event.t) < .025)),
        bandLabel: 'Heuristic spread; not calibrated coverage or nonlinear-model error bound', timingLabel: 'Host JavaScript time, not device latency' } };
  }
  async function searchAdversary(config, student, options = {}) {
    const base = validateConfig(config), random = rng(base.seed ^ 0x6576812), count = options.candidates || 24;
    const baseline = runEpisode(base, student), baselineScore = baseline.metrics.frozenError;
    let bestConfig = copy(base), bestScore = baseline.metrics.validForSearch ? baselineScore : -Infinity;
    const history = [], rejected = [];
    for (let i = 0; i < count; i++) {
      // A bounded evolutionary curriculum, not a learned generator. Restitution and drag stay fixed
      // so the adversary cannot win simply by changing the material after the student trains.
      const parent = i < 5 ? base : bestConfig;
      const mutation = (key, step, max) => clamp(parent[key] + (2 * random() - 1) * step, 0, max);
      const candidate = Object.assign({}, base, { seed: Math.floor(random() * 0xFFFFFFFF),
        bounceRandomness: mutation('bounceRandomness', .12, .3), roughnessDeg: mutation('roughnessDeg', 7, 16),
        cameraNoise: mutation('cameraNoise', 11, 24), dropRate: mutation('dropRate', .14, .4),
        blackoutMs: mutation('blackoutMs', 170, 550), exposureMs: mutation('exposureMs', 25, 70),
        quadraticDrag: base.quadraticDrag > 0 ? mutation('quadraticDrag', .4, 2) : 0,
        fieldStrength: base.fieldStrength > 0 ? mutation('fieldStrength', 1.5, 8) : 0 });
      const episode = runEpisode(candidate, student);
      const valid = episode.metrics.validForSearch;
      const score = episode.metrics.frozenError;
      if (valid && score > bestScore) { bestScore = score; bestConfig = candidate; }
      if (!valid) rejected.push(i + 1);
      history.push({ iteration: i + 1, seed: candidate.seed, score: Number.isFinite(bestScore) ? bestScore : null,
        candidateScore: valid ? score : null, valid });
      if (options.onProgress) options.onProgress({ iteration: i + 1, total: count, score: bestScore, valid });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { config: normalizedConfig(bestConfig), score: Number.isFinite(bestScore) ? bestScore : null,
      baselineScore, history, rejected, candidates: count,
      method: 'Bounded evolutionary search; starting conditions and geometry held fixed, enabled nonlinear terms may vary' };
  }
  function trainStudent(config, student, count = 12, seed = 1000) {
    let state = copy(student), records = [];
    for (let i = 0; i < count; i++) { const episode = runEpisode(Object.assign({}, config, { seed: seed + i }), state, { learn: true });
      state = episode.studentAfter; records.push({ episode: i + 1, error: episode.metrics.frozenError, learned: !!episode.learned }); }
    return { student: state, records };
  }
  return { WORLD, CAMERA, DEFAULT_CONFIG, createStudent, runEpisode, sampleTruth, detect,
    searchAdversary, trainStudent, inferCameraFrames, renderPixels, rng, normalizedConfig, validateConfig, publicCalibration };
});
