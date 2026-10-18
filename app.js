/* The UI may reveal simulator truth. The learner's boundary lives in engine.js. */
(function () {
  'use strict';
  const root = document.getElementById('collision-app');
  const $ = id => root.querySelector('#' + id);
  const C = window.CollisionLab;
  if (!C) { $('error').hidden = false; $('error').textContent = 'The simulation engine did not load. Keep engine.js beside this page.'; return; }
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : '—';
  const errorText = n => Number.isFinite(n) ? fmt(n * 100, 1) + ' cm' : 'Not enough evidence';
  const fresh = () => C.createStudent();
  let student = fresh(), episode = null, evaluation = null, busy = false, playing = false;
  let playTime = 0, lastTick = 0, animation = 0, dataSeed = 800000, logs = [];
  let lastSearch = null, trainingHistory = [];
  let obstacles = [], editing = false, obstacleId = 0, dragTarget = null;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const usedSeeds = new Set();
  function nextSeed() { do { dataSeed = (dataSeed + 1) >>> 0; } while (usedSeeds.has(dataSeed)); usedSeeds.add(dataSeed); return dataSeed; }
  const canvas = $('world'), camera = $('camera');
  const worldCtx = canvas.getContext('2d'), cameraCtx = camera.getContext('2d');
  const pixelCanvas = document.createElement('canvas');
  const pixelCtx = pixelCanvas.getContext('2d');
  const configInputs = Array.from(root.querySelectorAll('[data-config]'));
  const actionIds = ['run', 'challenge', 'train', 'evaluate', 'reset', 'export', 'add-obstacle', 'clear-obstacles', 'preset', 'edit-mode'];
  const units = { bounceRandomness: '', cameraNoise: ' / 255', blackoutMs: ' ms', roughnessDeg: '°', drag: ' /s', exposureMs: ' ms', quadraticDrag: ' /m', fieldStrength: ' m/s²', fieldRadius: ' m' };

  function setConfig(config) {
    configInputs.forEach(input => { const key = input.dataset.config; if (config[key] !== undefined) { if (input.type === 'checkbox') input.checked = !!config[key]; else input.value = config[key]; } });
    obstacles = (config.obstacles || []).map(o => ({ ...o }));
    values(); obstacleRows();
  }
  function values() {
    configInputs.forEach(input => {
      const out = $(input.id + '-value');
      if (out) out.textContent = input.id === 'dropRate' ? Math.round(Number(input.value) * 100) + '%' : fmt(Number(input.value), ['blackoutMs','exposureMs'].includes(input.id) ? 0 : 2) + (units[input.id] || '');
    });
  }
  function config(validate = true) {
    const result = { ...C.DEFAULT_CONFIG };
    configInputs.forEach(input => {
      if (validate && !input.checkValidity()) throw new Error('Check the ' + input.dataset.config + ' setting.');
      result[input.dataset.config] = input.type === 'checkbox' ? input.checked : input.tagName === 'SELECT' ? input.value : Number(input.value);
    });
    result.obstacles = obstacles.map(o => ({ ...o }));
    return result;
  }
  function sceneChanged() {
    stop(); editing = true; values(); invalidateEvaluation();
    $('play').disabled = true; $('finish').disabled = true; $('timeline').disabled = true;
    $('error').hidden = true; $('dirty').textContent = 'Preview · run to apply';
    status('Scene changed.'); render();
  }
  function obstacleRows() {
    const rows = obstacles.map((o, index) => {
      const row = document.createElement('div'); row.className = 'obstacle-row';
      for (const [key, label, min, max] of [['x', 'X · m', .03, 1.57], ['y', 'Y · m', .03, 1.17], ['radius', 'Radius · m', .025, .3]]) {
        const field = document.createElement('label'); field.textContent = label;
        const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = 'any'; input.value = o[key]; input.disabled = busy;
        input.addEventListener('input', () => { if (busy) return; obstacles[index][key] = Number(input.value); sceneChanged(); });
        field.appendChild(input); row.appendChild(field);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.disabled = busy; remove.setAttribute('aria-label', 'Remove bumper ' + (index + 1));
      remove.addEventListener('click', () => { obstacles.splice(index, 1); obstacleRows(); sceneChanged(); }); row.appendChild(remove); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'obstacle-empty'; empty.textContent = 'No bumpers'; rows.push(empty); }
    $('obstacle-list').replaceChildren(...rows);
  }
  function addObstacle(x, y) {
    if (obstacles.length >= 12) { status('Maximum 12 bumpers.'); return; }
    const radius = .11, cfg = config(false);
    if (x === undefined) {
      const candidates = [[1.08,.58],[.92,.28],[1.3,.9],[.55,.92],[.52,.25],[1.34,.28],[.8,.9],[.75,.55]];
      const slot = candidates.find(([a,b]) => Math.hypot(a-cfg.startX,b-cfg.startY) > radius + C.WORLD.radius + cfg.launchJitter + .01 && obstacles.every(o => Math.hypot(a-o.x,b-o.y) > radius + o.radius + .02));
      if (!slot) { status('Choose Add bumper and click an open space.'); return; } [x,y] = slot;
    }
    obstacles.push({ id: 'bumper-' + (++obstacleId), x: clamp(x,radius,C.WORLD.wallX-radius), y: clamp(y,radius,C.WORLD.height-radius), radius });
    obstacleRows(); sceneChanged();
  }
  function log(message) {
    logs.unshift(message); logs = logs.slice(0, 10);
    $('log').replaceChildren(...logs.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
  }
  function status(message, value = null) {
    $('work-status').textContent = message;
    $('progress').hidden = value === null;
    if (value !== null) $('progress').value = Math.max(0, Math.min(1, value));
  }
  function stop() { playing = false; cancelAnimationFrame(animation); $('play').textContent = 'Play'; }
  function setBusy(value) {
    busy = value; if (value) stop();
    actionIds.forEach(id => { $(id).disabled = value; });
    configInputs.forEach(input => { input.disabled = value; });
    $('play').disabled = value || editing; $('finish').disabled = value || editing; $('timeline').disabled = value || editing;
    obstacleRows();
  }
  async function work(fn) {
    if (busy) return;
    setBusy(true); $('error').hidden = true;
    try { await pause(); await fn(); }
    catch (err) { $('error').textContent = err.message || String(err); $('error').hidden = false; status('Stopped. Adjust the settings or try again.'); }
    finally { setBusy(false); }
  }
  function showEpisode(result, atEnd = false) {
    stop(); editing = false; episode = result; usedSeeds.add(episode.config.seed); playTime = atEnd ? episode.duration : 0;
    $('timeline').value = Math.round(playTime / episode.duration * 1000);
    $('dirty').textContent = 'Seed ' + episode.config.seed;
    showStudent(); render();
  }
  function showStudent() {
    $('student-e').textContent = fmt(student.restitution, 3);
    $('student-drag').textContent = fmt(student.drag, 3) + ' /s';
    $('student-n').textContent = student.episodes || 0;
    $('bytes').textContent = episode ? fmt(episode.metrics.bytes / 1024, 1) + ' KiB / trial' : '—';
    $('fit-time').textContent = episode ? fmt(episode.metrics.fitMs, 2) + ' ms' : '—';
    $('model-scope').textContent = episode?.modelScope?.nonlinear ? 'Added forces are unknown to the predictor.' : 'Pixels + known geometry';
  }
  function sizeCanvas(element) {
    const rect = element.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (element.width !== width || element.height !== height) { element.width = width; element.height = height; }
    const ctx = element.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }
  function interpolate(path, t) {
    if (!path || !path.length) return null;
    if (t < path[0].t) return null;
    for (let i = 1; i < path.length; i++) if (path[i].t >= t) {
      const a = path[i - 1], b = path[i], k = (t - a.t) / Math.max(1e-9, b.t - a.t);
      return { x: a.x + k * (b.x - a.x), y: a.y + k * (b.y - a.y) };
    }
    return path[path.length - 1];
  }
  function drawWorld() {
    const { ctx, w, h } = sizeCanvas(canvas), W = C.WORLD;
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 38, r: 20, t: 26, b: 34 };
    const sx = (w - pad.l - pad.r) / W.width, sy = (h - pad.t - pad.b) / W.height;
    const px = x => pad.l + x * sx, py = y => h - pad.b - y * sy;
    ctx.font = '11px ui-monospace, monospace'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 1; ctx.strokeStyle = '#dedede'; ctx.fillStyle = '#595959';
    for (let x = 0; x <= W.width + 0.001; x += 0.5) {
      ctx.beginPath(); ctx.moveTo(px(x), pad.t); ctx.lineTo(px(x), h - pad.b); ctx.stroke();
      if (w > 380 || Math.round(x * 2) % 2 === 0) { ctx.textAlign = 'center'; ctx.fillText(fmt(x, 1), px(x), h - 17); }
    }
    ctx.textAlign = 'right'; ctx.fillText('m', w - 4, h - 17);
    for (let y = 0; y <= W.height + 0.001; y += 0.5) { ctx.beginPath(); ctx.moveTo(pad.l, py(y)); ctx.lineTo(w - pad.r, py(y)); ctx.stroke(); ctx.fillText(fmt(y, 1), pad.l - 8, py(y)); }
    ctx.strokeStyle = '#303030'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(px(W.wallX), pad.t); ctx.lineTo(px(W.wallX), h - pad.b); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillStyle = '#595959'; ctx.fillText('WALL', px(W.wallX) - 6, 12);
    ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b); ctx.clip();
    const scene = editing || !episode ? config(false) : episode.config;
    if (scene.arenaWalls) { ctx.strokeStyle = '#303030'; ctx.lineWidth = 2; ctx.strokeRect(px(0), py(W.height), W.wallX * sx, W.height * sy); }
    if (scene.fieldStrength > 0 && Number.isFinite(scene.fieldX) && Number.isFinite(scene.fieldY)) {
      ctx.fillStyle = '#1e1e1e0b'; ctx.strokeStyle = '#a0a0a0'; ctx.lineWidth = 1; ctx.setLineDash([3,5]);
      ctx.beginPath(); ctx.ellipse(px(scene.fieldX),py(scene.fieldY),scene.fieldRadius*sx,scene.fieldRadius*sy,0,0,Math.PI*2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      const fc = { x:px(scene.fieldX), y:py(scene.fieldY) }; ctx.beginPath(); ctx.moveTo(fc.x-5,fc.y); ctx.lineTo(fc.x+5,fc.y); ctx.moveTo(fc.x,fc.y-5); ctx.lineTo(fc.x,fc.y+5); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#595959'; ctx.fillText(scene.fieldMode,fc.x,fc.y-12);
    }
    for (const [i,o] of (scene.obstacles || []).entries()) {
      if (![o.x,o.y,o.radius].every(Number.isFinite) || o.radius<=0) continue;
      ctx.fillStyle = '#b5b5b5'; ctx.strokeStyle = '#595959'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(px(o.x),py(o.y),o.radius*sx,o.radius*sy,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#303030'; ctx.fillText(String(i+1),px(o.x),py(o.y));
    }
    if (editing || !episode || playTime===0) {
      const x=scene.startX, y=scene.startY, angle=scene.headingDeg*Math.PI/180, length=.1+scene.speed*.12;
      if ([x,y,angle,length].every(Number.isFinite)) {
        if (scene.launchJitter > 0) { ctx.setLineDash([2,3]); ctx.strokeStyle='#797979'; ctx.beginPath(); ctx.ellipse(px(x),py(y),scene.launchJitter*sx,scene.launchJitter*sy,0,0,Math.PI*2); ctx.stroke(); ctx.setLineDash([]); }
        ctx.fillStyle='#1e1e1e'; ctx.beginPath(); ctx.ellipse(px(x),py(y),W.radius*sx,W.radius*sy,0,0,Math.PI*2); ctx.fill();
        const ex=px(x+Math.cos(angle)*length), ey=py(y+Math.sin(angle)*length), ax=ex-px(x), ay=ey-py(y), az=Math.atan2(ay,ax);
        ctx.strokeStyle='#303030'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(px(x),py(y)); ctx.lineTo(ex,ey); ctx.moveTo(ex-8*Math.cos(az-.45),ey-8*Math.sin(az-.45)); ctx.lineTo(ex,ey); ctx.lineTo(ex-8*Math.cos(az+.45),ey-8*Math.sin(az+.45)); ctx.stroke();
      }
    }
    if (episode && !editing) {
      const drawPath = (path, dash, color, width, through = Infinity) => {
        const points = (path || []).filter(p => p.t <= through);
        if (points.length < 2) return;
        ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width;
        points.forEach((p, i) => i ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y))); ctx.stroke(); ctx.setLineDash([]);
      };
      if (playTime >= episode.freezeTime && episode.band && episode.band.length) {
        ctx.fillStyle = '#1e1e1e10'; ctx.beginPath();
        episode.band.forEach((p, i) => i ? ctx.lineTo(px(p.highX), py(p.highY)) : ctx.moveTo(px(p.highX), py(p.highY)));
        episode.band.slice().reverse().forEach(p => ctx.lineTo(px(p.lowX), py(p.lowY))); ctx.closePath(); ctx.fill();
      }
      if (playTime >= episode.freezeTime) drawPath(episode.forecast, [7, 5], '#1e1e1e', 1.6);
      if (Number.isFinite(episode.correctionTime) && playTime >= episode.correctionTime) drawPath(episode.correctedForecast, [2, 4], '#595959', 2);
      if ($('reveal').checked) {
        drawPath(episode.truth, [], '#1e1e1e', 2.5, playTime);
        const actual = C.sampleTruth(episode.truth, playTime);
        if (actual) { ctx.fillStyle = '#1e1e1e'; ctx.beginPath(); ctx.ellipse(px(actual.x), py(actual.y), W.radius * sx, W.radius * sy, 0, 0, Math.PI * 2); ctx.fill(); }
        for (const hit of episode.impacts || (episode.impact ? [episode.impact] : [])) if (playTime >= hit.t) { ctx.strokeStyle = '#595959'; ctx.lineWidth = 1; const x = px(hit.x), y = py(hit.y); ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke(); }
      }
      const seen = episode.observations.filter(p => p.t <= playTime);
      ctx.fillStyle = '#797979'; seen.forEach(p => { ctx.fillRect(px(p.x) - 1.5, py(p.y) - 1.5, 3, 3); });
      const last = seen[seen.length - 1];
      if (last) { ctx.strokeStyle = '#303030'; ctx.lineWidth = 1.5; ctx.strokeRect(px(last.x) - 8, py(last.y) - 8, 16, 16); }
      if (playTime >= episode.freezeTime) {
        const prediction = interpolate(Number.isFinite(episode.correctionTime) && playTime >= episode.correctionTime ? episode.correctedForecast : episode.forecast, playTime);
        if (prediction) { ctx.strokeStyle = '#595959'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.ellipse(px(prediction.x), py(prediction.y), W.radius * sx, W.radius * sy, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      }
    }
    ctx.restore();
  }
  function drawCamera() {
    const { ctx, w, h } = sizeCanvas(camera);
    ctx.fillStyle = '#262626'; ctx.fillRect(0, 0, w, h);
    if (editing) { ctx.fillStyle='#d4d4d4'; ctx.font='13px Arial'; ctx.textAlign='center'; ctx.fillText('Run scene',w/2,h/2); $('camera-status').textContent='Preview'; $('camera-time').textContent='—'; return; }
    if (!episode) return;
    const eligible = episode.frames.filter(f => f.t <= playTime);
    const latest = eligible[eligible.length - 1];
    const received = eligible.filter(f => !f.dropped && f.pixels && f.pixels.length);
    const frame = received[received.length - 1];
    const cam = C.CAMERA || { width: 96, height: 64 };
    if (frame) {
      const cw = frame.width || cam.width, ch = frame.height || cam.height;
      pixelCanvas.width = cw; pixelCanvas.height = ch;
      const img = pixelCtx.createImageData(cw, ch);
      for (let i = 0; i < cw * ch; i++) { const value = frame.pixels[i]; img.data[i * 4] = value; img.data[i * 4 + 1] = value; img.data[i * 4 + 2] = value; img.data[i * 4 + 3] = 255; }
      pixelCtx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const scale = Math.min(w / cw, h / ch), iw = cw * scale, ih = ch * scale;
      ctx.drawImage(pixelCanvas, (w - iw) / 2, (h - ih) / 2, iw, ih);
    }
    const missing = latest && latest.dropped;
    if (!frame || missing) { ctx.fillStyle = '#202020a8'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#f4f4f4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '13px ui-monospace, monospace'; ctx.fillText(frame ? 'NO NEW FRAME' : 'WAITING FOR FRAME', w / 2, h / 2); }
    $('camera-status').textContent = missing ? (latest.reason || 'Frame lost') : frame ? 'Received' : 'Waiting';
    $('camera-time').textContent = frame ? 't = ' + fmt(frame.t) + ' s' : '—';
  }
  function render() {
    drawWorld(); drawCamera(); if (!episode) return;
    if (editing) { $('frozen-error').textContent='—'; $('corrected-error').textContent='—'; $('frame-count').textContent='—'; $('event-strip').textContent='Preview · run to capture new frames.'; return; }
    $('time-value').textContent = fmt(playTime) + ' s';
    const complete = playTime >= episode.duration - 0.002;
    $('frozen-error').textContent = complete ? (Number.isFinite(episode.metrics.frozenError) ? errorText(episode.metrics.frozenError) : 'No fit') : 'Hidden';
    $('corrected-error').textContent = complete ? (Number.isFinite(episode.metrics.correctedError) ? errorText(episode.metrics.correctedError) : 'No fit') : 'Hidden';
    $('correction-detail').textContent = complete && Number.isFinite(episode.metrics.frozenErrorOnCorrectedHorizon) ? 'First, same window: ' + errorText(episode.metrics.frozenErrorOnCorrectedHorizon) : 'Remaining-future RMSE';
    $('frozen-detail').textContent = complete ? 'RMSE from ' + fmt(episode.metrics.scoreStartTime) + ' s' : 'Position RMSE';
    const frames = episode.frames.filter(f => f.t <= playTime);
    $('frame-count').textContent = frames.filter(f => !f.dropped).length + ' / ' + episode.metrics.requestedFrames;
    $('frame-detail').textContent = episode.config.sampling === 'burst' ? 'Contact burst' : 'Uniform';
    let message;
    if (complete) message = episode.forecast.length ? 'Outcome · ' + (episode.impacts?.length || 0) + ' contacts. Original prediction unchanged.' : 'Outcome · insufficient early frames; no first prediction.';
    else if (playTime < episode.freezeTime) message = 'Observing launch…';
    else if (!episode.forecast.length) message = 'Insufficient early frames.';
    else if (Number.isFinite(episode.correctionTime) && playTime >= episode.correctionTime) message = 'Prediction updated from new frames.';
    else message = 'Prediction fixed at ' + fmt(episode.freezeTime) + ' s.' + (episode.impact && !episode.preImpactForecast ? ' Contact already occurred.' : '');
    if ($('event-strip').textContent !== message) $('event-strip').textContent = message;
  }
  function tick(now) {
    if (!playing || !episode) return;
    playTime = Math.min(episode.duration, playTime + (now - lastTick) / 1000 * 0.65); lastTick = now;
    $('timeline').value = Math.round(playTime / episode.duration * 1000); render();
    if (playTime >= episode.duration) stop(); else animation = requestAnimationFrame(tick);
  }
  function play() {
    if (!episode || editing) return; if (playing) { stop(); return; }
    if (playTime >= episode.duration - 0.002) playTime = 0;
    playing = true; lastTick = performance.now(); $('play').textContent = 'Pause'; animation = requestAnimationFrame(tick);
  }
  function invalidateEvaluation() { evaluation = null; $('evaluation').hidden = true; }
  function pointFromEvent(event) {
    const rect=canvas.getBoundingClientRect();
    return { x:clamp((event.clientX-(rect.left||0)-38)/(rect.width-58)*C.WORLD.width,.06,1.54), y:clamp((rect.height-34-(event.clientY-(rect.top||0)))/(rect.height-60)*C.WORLD.height,.06,1.14) };
  }
  function applyPoint(point, target) {
    if (target==='launch') { $('startX').value=fmt(point.x,3); $('startY').value=fmt(point.y,3); }
    else if (target==='field') { $('fieldX').value=fmt(point.x,3); $('fieldY').value=fmt(point.y,3); }
    else if (Number.isInteger(target) && obstacles[target]) { const o=obstacles[target]; o.x=Number(fmt(clamp(point.x,o.radius,C.WORLD.wallX-o.radius),3)); o.y=Number(fmt(clamp(point.y,o.radius,C.WORLD.height-o.radius),3)); obstacleRows(); }
    sceneChanged();
  }
  canvas.addEventListener('pointerdown', event => {
    if (busy) return; const point=pointFromEvent(event), mode=$('edit-mode').value;
    if (mode==='add') { addObstacle(point.x,point.y); return; }
    if (mode==='remove' || mode==='move') {
      const index=obstacles.findIndex(o=>Math.hypot(o.x-point.x,o.y-point.y)<=o.radius+.05);
      if (index<0) { status('Select a bumper.'); return; }
      if (mode==='remove') { obstacles.splice(index,1); obstacleRows(); sceneChanged(); return; }
      dragTarget=index;
    } else dragTarget=mode;
    canvas.setPointerCapture?.(event.pointerId); applyPoint(point,dragTarget);
  });
  canvas.addEventListener('pointermove',event=>{if(!busy && dragTarget!==null) applyPoint(pointFromEvent(event),dragTarget);});
  canvas.addEventListener('pointerup',()=>{dragTarget=null;});
  canvas.addEventListener('pointercancel',()=>{dragTarget=null;});
  $('edit-mode').addEventListener('change',()=>{status('Click or drag in the scene.');});
  $('add-obstacle').addEventListener('click',()=>addObstacle());
  $('clear-obstacles').addEventListener('click',()=>{obstacles=[];obstacleRows();sceneChanged();});
  $('preset').addEventListener('change',()=>{
    const name=$('preset').value;
    const preset={...C.DEFAULT_CONFIG,obstacles:[]};
    if(name==='bumpers') Object.assign(preset,{startX:.23,startY:.35,speed:1.65,headingDeg:20,arenaWalls:true,obstacles:[{id:'course-1',x:1.03,y:.65,radius:.14},{id:'course-2',x:.58,y:.95,radius:.12},{id:'course-3',x:1.28,y:.25,radius:.12}]});
    if(name==='vortex') Object.assign(preset,{startX:.22,startY:.3,speed:1.5,headingDeg:24,arenaWalls:true,quadraticDrag:.15,fieldStrength:3.2,fieldMode:'vortex',fieldX:.98,fieldY:.62,fieldRadius:.34,obstacles:[{id:'vortex-1',x:1.3,y:.85,radius:.12},{id:'vortex-2',x:.65,y:.93,radius:.11}]});
    setConfig(preset);sceneChanged();
  });
  $('play').addEventListener('click', play);
  $('timeline').addEventListener('input', () => { if (!episode || editing) return; stop(); playTime = Number($('timeline').value) / 1000 * episode.duration; render(); });
  $('finish').addEventListener('click', () => { if (!episode || editing) return; stop(); playTime = episode.duration; $('timeline').value = 1000; $('reveal').checked = true; render(); });
  $('reveal').addEventListener('change', render);
  configInputs.forEach(input => input.addEventListener('input', sceneChanged));
  $('run').addEventListener('click', () => work(async () => {
    const cfg = config(); status('Rendering camera observations…');
    showEpisode(C.runEpisode(cfg, student, { learn: false }));
    log('Seed ' + cfg.seed + ': ' + (episode.forecast.length ? 'forecast fixed at ' + fmt(episode.freezeTime) + ' s.' : 'insufficient early frames.') + ' ' + (episode.impacts?.length || 0) + ' contacts.');
    status('Scene ready.');
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) play();
  }));
  $('challenge').addEventListener('click', () => work(async () => {
    const cfg = config(); status('Searching…', 0);
    const result = await C.searchAdversary(cfg, student, { candidates: 24, onProgress: (...args) => {
      const p = args[0];
      const i = typeof p === 'object' ? (p.iteration || p.completed || 0) : Number(p);
      const total = typeof p === 'object' ? (p.total || 24) : (Number(args[1]) || 24);
      status('Searching ' + Math.min(i, total) + ' / ' + total, i / total);
    } });
    lastSearch = result;
    usedSeeds.add(cfg.seed); result.history.forEach(row => { if (Number.isFinite(row.seed)) usedSeeds.add(row.seed); });
    if (!Number.isFinite(result.score)) { log('No eligible scene found.'); status('No fair candidate. Try more frames or less loss.'); return; }
    setConfig(result.config); invalidateEvaluation();
    showEpisode(C.runEpisode(result.config, student, { learn: false }));
    log('Adversary selection score: ' + errorText(result.baselineScore) + ' → ' + errorText(result.score) + '. This is search evidence, not an unseen-test result.');
    status(result.score > result.baselineScore ? 'Harder scene selected.' : 'Current scene retained.');
  }));
  $('train').addEventListener('click', () => work(async () => {
    const cfg = config(), count = 12, before = { ...student }; let last;
    for (let i = 0; i < count; i++) {
      status('Training ' + (i + 1) + ' / ' + count, i / count); await pause();
      last = C.runEpisode({ ...cfg, seed: nextSeed() }, student, { learn: true });
      student = last.studentAfter;
      trainingHistory.push({ seed: dataSeed, frozenError: last.metrics.frozenError, student: { ...student } });
    }
    invalidateEvaluation(); showEpisode(last, true); $('reveal').checked = true; render();
    const updates = student.episodes - before.episodes;
    log('Attempted 12 fresh trials; ' + updates + ' supplied enough evidence to learn. Restitution: ' + fmt(before.restitution, 3) + ' → ' + fmt(student.restitution, 3) + '. Test before claiming improvement.');
    status(updates ? updates + ' / 12 model updates.' : 'No parameter updates: this scene exceeds the fitting model.');
    if (last.learningAbstention) log(last.learningAbstention);
  }));
  function mean(values) { const valid = values.filter(Number.isFinite); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; }
  function quantile(values, p) { const a = values.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null; }
  $('evaluate').addEventListener('click', () => work(async () => {
    const cfg = config(), count = 16; dataSeed += 100000;
    const testSeeds = Array.from({ length: count }, nextSeed), testBase = testSeeds[0];
    const rows = [
      { name: 'Initial model · uniform', student: fresh(), sampling: 'uniform', errors: [], corrected: [] },
      { name: 'Learned model · uniform', student: { ...student }, sampling: 'uniform', errors: [], corrected: [] },
      { name: 'Initial model · burst', student: fresh(), sampling: 'burst', errors: [], corrected: [] },
      { name: 'Learned model · burst', student: { ...student }, sampling: 'burst', errors: [], corrected: [] }
    ];
    for (let i = 0; i < count; i++) {
      status('Testing ' + (i + 1) + ' / ' + count, i / count); await pause();
      for (const row of rows) { const result = C.runEpisode({ ...cfg, seed: testSeeds[i], sampling: row.sampling }, row.student, { learn: false }); row.errors.push(result.metrics.frozenError); row.corrected.push(result.metrics.correctedError); }
    }
    evaluation = { config: cfg, seedStart: testBase, seeds: testSeeds, count, rows: rows.map(row => ({ name: row.name, mean: mean(row.errors), p90: quantile(row.errors, .9), corrected: mean(row.corrected), valid: row.errors.filter(Number.isFinite).length, correctedValid: row.corrected.filter(Number.isFinite).length, errors: row.errors })) };
    $('eval-body').replaceChildren(...evaluation.rows.map(row => { const tr = document.createElement('tr'); [row.name, errorText(row.mean), errorText(row.p90), errorText(row.corrected) + ' (' + row.correctedValid + '/' + count + ')'].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td); }); return tr; }));
    const base = evaluation.rows[0].mean, trained = evaluation.rows[1].mean;
    const change = Number.isFinite(base) && Number.isFinite(trained) && base > 0 ? (base - trained) / base * 100 : null;
    $('eval-count').textContent = count + ' new realizations / schedule';
    $('eval-summary').textContent = (change === null ? 'Insufficient evidence.' : 'Training: ' + fmt(Math.abs(change),1) + '% ' + (change>=0?'lower':'higher') + ' uniform-sampling error.') + ' Same new seeds; no fitting. Updated RMSE uses a shorter future window; parentheses count valid trials.';
    $('evaluation').hidden = false;
    log('Unseen evaluation: initial uniform ' + errorText(base) + '; learned uniform ' + errorText(trained) + ' across ' + count + ' trials.');
    status('Test complete.');
  }));
  $('reset').addEventListener('click', () => work(async () => { student = fresh(); trainingHistory = []; invalidateEvaluation(); showEpisode(C.runEpisode(config(), student, { learn: false })); log('Small model restored to its initial prior. Scene controls kept.'); status('Learning reset.'); }));
  $('export').addEventListener('click', () => {
    const payload = { description: 'Between Frames synthetic experiment; browser timing is not hardware performance.', student, config: config(), lastSearch, evaluation, trainingHistory, episode };
    const blob = new Blob([JSON.stringify(payload, (key, value) => key === 'pixels' ? undefined : value, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'between-frames-run.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    log('Exported parameters, observations, frozen forecasts, outcomes, and evaluation. Raster buffers omitted.');
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  new ResizeObserver(render).observe(root);
  try { setConfig(C.DEFAULT_CONFIG); showEpisode(C.runEpisode(config(), student, { learn: false })); log('Ready. Edit the scene or press Play.'); }
  catch (err) { $('error').hidden = false; $('error').textContent = err.message || String(err); }
})();
