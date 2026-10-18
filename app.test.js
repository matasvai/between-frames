'use strict';
// Application state/interaction checks with a small DOM double. No browser rendering is performed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const engine = require('./engine.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function harness() {
  const elements = new Map(), configInputs = [];
  const context = new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }, { get: (o, p) => p in o ? o[p] : () => {} });
  class Element {
    constructor(tag, attrs = '') {
      this.tagName = tag.toUpperCase(); this.handlers = {}; this.children = []; this.hidden = /\bhidden\b/.test(attrs);
      this.value = ''; this.checked = /\bchecked\b/.test(attrs); this.disabled = false; this.textContent = ''; this.dataset = {};
      for (const [, key, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) { this[key] = value; if (key === 'data-config') this.dataset.config = value; }
    }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    async trigger(name, props = {}) { return this.handlers[name]?.({ target: this, ...props }); }
    replaceChildren(...items) { this.children = items; }
    appendChild(item) { this.children.push(item); }
    setAttribute(name,value) { this[name]=value; }
    getContext() { return context; }
    getBoundingClientRect() { return { width: 640, height: 310, left: 0, top: 0 }; }
    checkValidity() { if (this.tagName === 'SELECT') return this.id==='sampling' ? ['uniform','burst'].includes(this.value) : this.id==='fieldMode' ? ['vortex','attract','repel'].includes(this.value) : true; if(this.type==='checkbox') return true; const v = Number(this.value); return Number.isFinite(v) && (this.min === undefined || v >= Number(this.min)) && (this.max === undefined || v <= Number(this.max)); }
    click() { return this.trigger('click'); }
  }
  for (const [, tag, attrs] of html.matchAll(/<([\w-]+)\b([^>]*\bid="[^"]+"[^>]*)>/g)) { const el = new Element(tag, attrs); assert.ok(!elements.has(el.id), 'unique element id ' + el.id); elements.set(el.id, el); if (el.dataset.config) configInputs.push(el); }
  const root = elements.get('collision-app');
  root.querySelector = selector => elements.get(selector.slice(1)) || null;
  root.querySelectorAll = selector => { assert.equal(selector, '[data-config]'); return configInputs; };
  const document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag), addEventListener() {}, hidden: false };
  let exported = null;
  const sandbox = { window: { CollisionLab: engine, devicePixelRatio: 1 }, document, ResizeObserver: class { observe() {} }, performance, console,
    setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Blob,
    URL: { createObjectURL(blob) { exported = blob; return 'blob:test'; }, revokeObjectURL() {} } };
  vm.runInNewContext(source, sandbox, { filename: 'app.js' });
  return { get: id => elements.get(id), exported: () => exported, inputs: configInputs };
}
test('initial camera settings retain engine values and prediction scores stay hidden', () => {
  const h = harness(); assert.equal(h.get('error').hidden, true, h.get('error').textContent); assert.equal(Number(h.get('cameraNoise').value), engine.DEFAULT_CONFIG.cameraNoise);
  assert.equal(h.get('frozen-error').textContent, 'Hidden'); assert.equal(h.get('student-n').textContent, 0);
  for (const input of h.inputs) assert.ok(input.checkValidity(), input.id + ' default is within controls');
});
test('replay reveals actual scores only at completion and supports returning to prefix', async () => {
  const h = harness(); await h.get('finish').click(); assert.match(h.get('frozen-error').textContent, /cm$/); assert.equal(h.get('reveal').checked, true);
  assert.match(h.get('correction-detail').textContent, /same window/);
  h.get('timeline').value = 0; await h.get('timeline').trigger('input'); assert.equal(h.get('frozen-error').textContent, 'Hidden');
});
test('adversary settings remain valid and can be used by train, held-out test and reset', async () => {
  const h = harness(); await h.get('challenge').click(); assert.equal(h.get('error').hidden, true, h.get('error').textContent);
  for (const input of h.inputs) assert.ok(input.checkValidity(), input.id + ' adversarial value valid');
  await h.get('train').click(); assert.equal(h.get('error').hidden, true, h.get('error').textContent);
  const learnedTrials = Number(h.get('student-n').textContent); assert.ok(learnedTrials > 0 && learnedTrials <= 12);
  await h.get('evaluate').click(); assert.equal(h.get('error').hidden, true, h.get('error').textContent);
  assert.equal(h.get('evaluation').hidden, false); assert.equal(h.get('eval-body').children.length, 4);
  assert.equal(Number(h.get('student-n').textContent), learnedTrials, 'evaluation never updates weights');
  await h.get('export').click(); const data = JSON.parse(await h.exported().text());
  assert.equal(data.evaluation.count, 16); assert.ok(data.episode.frames.every(f => !('pixels' in f)));
  assert.ok(data.evaluation.seedStart > Math.max(...data.trainingHistory.map(r => r.seed)));
  const searchSeeds = new Set(data.lastSearch.history.map(r => r.seed));
  assert.ok(data.evaluation.seeds.every(seed => !searchSeeds.has(seed)));
  await h.get('reset').click(); assert.equal(h.get('student-n').textContent, 0); assert.equal(h.get('evaluation').hidden, true);
});
test('invalid input fails visibly and restores the controls', async () => {
  const h = harness(); h.get('seed').value = -1; await h.get('run').click();
  assert.equal(h.get('error').hidden, false); assert.match(h.get('error').textContent, /seed/); assert.equal(h.get('run').disabled, false);
});
test('insufficient early frames cause an explicit abstention, not a fabricated forecast', async () => {
  const h = harness(); h.get('seed').value = 0; h.get('dropRate').value = .4; h.get('frameBudget').value = 16;
  await h.get('run').click(); assert.equal(h.get('error').hidden, true, h.get('error').textContent);
  h.get('timeline').value=250; await h.get('timeline').trigger('input');
  assert.match(h.get('event-strip').textContent, /Insufficient early/);
  await h.get('finish').click(); assert.equal(h.get('frozen-error').textContent, 'No fit'); assert.match(h.get('event-strip').textContent, /insufficient early/);
});
test('scene presets create physical geometry and nonlinear worlds without runtime errors', async () => {
  const h=harness();
  for(const name of ['bumpers','vortex','wall']) {
    h.get('preset').value=name; await h.get('preset').trigger('change');
    assert.match(h.get('event-strip').textContent,/Preview/);
    assert.equal(h.get('play').disabled,true,'old replay disabled while editing a new scene');
    await h.get('run').click(); assert.equal(h.get('error').hidden,true,h.get('error').textContent);
    assert.equal(h.get('play').disabled,false);
    await h.get('finish').click(); await h.get('export').click();
    const data=JSON.parse(await h.exported().text());
    assert.equal(data.config.obstacles.length,name==='wall'?0:name==='bumpers'?3:2);
    if(name!=='wall') assert.ok(data.episode.impacts.length>0);
    if(name==='vortex') assert.equal(data.episode.modelScope.nonlinear,true);
  }
});
test('canvas and numeric controls change starting data and add or remove real obstacles',async()=>{
  const h=harness(); h.get('edit-mode').value='launch';
  await h.get('world').trigger('pointerdown',{clientX:120,clientY:170,pointerId:1});
  await h.get('world').trigger('pointerup');
  assert.notEqual(Number(h.get('startX').value),engine.DEFAULT_CONFIG.startX);
  h.get('speed').value=.7; h.get('headingDeg').value=30; await h.get('speed').trigger('input');
  await h.get('add-obstacle').click(); await h.get('run').click(); assert.equal(h.get('error').hidden,true,h.get('error').textContent);
  await h.get('export').click(); let data=JSON.parse(await h.exported().text());
  assert.equal(data.config.obstacles.length,1); assert.ok(Math.abs(data.episode.initial.vx-.7*Math.cos(Math.PI/6))<1e-9);
  await h.get('clear-obstacles').click(); await h.get('run').click(); await h.get('export').click(); data=JSON.parse(await h.exported().text()); assert.equal(data.config.obstacles.length,0);
});
test('overlapping launch and obstacle report an actionable error',async()=>{
  const h=harness(); await h.get('add-obstacle').click(); h.get('startX').value=1.08; h.get('startY').value=.58;
  await h.get('run').click(); assert.equal(h.get('error').hidden,false); assert.match(h.get('error').textContent,/overlap/);
});
test('stationary no-contact scenes complete without null-impact rendering failures',async()=>{
  const h=harness(); h.get('speed').value=0; await h.get('run').click(); await h.get('finish').click();
  assert.equal(h.get('error').hidden,true,h.get('error').textContent); assert.match(h.get('event-strip').textContent,/0 contacts/);
});
test('nonlinear adversary results remain editable and unsupported fitting is explicit',async()=>{
  const h=harness(); h.get('preset').value='vortex'; await h.get('preset').trigger('change');
  await h.get('challenge').click(); assert.equal(h.get('error').hidden,true,h.get('error').textContent);
  for(const input of h.inputs) assert.ok(input.checkValidity(),input.id+' nonlinear adversary range');
  await h.get('train').click(); assert.equal(h.get('error').hidden,true,h.get('error').textContent);
  assert.equal(Number(h.get('student-n').textContent),0); assert.match(h.get('work-status').textContent,/exceeds the fitting model/);
});
