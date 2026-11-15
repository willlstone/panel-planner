import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer, DenoiseMaterial } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { loadState, saveState, resetState } from './state.js';
import { Materials } from './materials.js';
import { buildRoom, wallFrames, IN, WALL_NAMES } from './room.js';
import { Geo } from './geo.js';
import { Lighting } from './lighting.js';
import { UI, inches } from './ui.js';

const MAX_SAMPLES = 800;        // path tracing stops refining here
const SETTLE_MS = 160;          // wait this long after the last edit before re-tracing
const ACCENT = '#2f5d50';

const $ = (id) => document.getElementById(id);
const fail = (msg) => { const e = $('error'); e.hidden = false; e.textContent = msg; };
window.addEventListener('error', (e) => fail(`Something went wrong:\n${e.message}`));
window.addEventListener('unhandledrejection', (e) => fail(`Something went wrong:\n${e.reason?.message || e.reason}`));

const S = loadState();
const canvas = $('view'), stage = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
controls.zoomSpeed = 0.7;

// Scanned textures arrive after the first frame; rebuild when each one lands.
let started = false;
const mats = new Materials(() => { if (started) rebuild(); });
const lighting = new Lighting(scene);

// The path tracer accumulates one noisy sample per frame into a clean image. While it has too few
// samples to show, it calls back for a rasterised preview, which is what you see while dragging.
const pt = new WebGLPathTracer(renderer);
pt.bounces = 6;
pt.filterGlossyFactor = 0.5;
pt.renderScale = 0.8;
pt.tiles.set(1, 1);
pt.textureSize.set(2048, 2048);
pt.minSamples = 4;
pt.renderDelay = 0;
pt.fadeDuration = 350;
pt.dynamicLowRes = false;
pt.rasterizeSceneCallback = (sc, cam) => lighting.renderPreview(renderer, sc, cam);

// Edge-preserving denoise on the way to the screen. It works hard on the first noisy samples and
// eases off as the image converges, so fine moulding detail is not smeared in the final picture.
const denoise = new FullScreenQuad(new DenoiseMaterial({
  map: null, blending: THREE.CustomBlending, premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha,
}));
pt.renderToCanvasCallback = (target, r, quad) => {
  const k = Math.min(1, pt.samples / MAX_SAMPLES);
  denoise.material.sigma = 5 - 3 * k;
  denoise.material.threshold = 0.07 - 0.045 * k;
  denoise.material.kSigma = 1;
  denoise.material.opacity = quad.material.opacity;
  denoise.material.map = target.texture;
  const auto = r.autoClear; r.autoClear = false;
  denoise.render(r);
  r.autoClear = auto;
};

let room = null, stats = null, frames = wallFrames(S);
let traceDirty = true, lastEdit = 0, traceReady = false, photoreal = true;

// Two ways of looking at the room:
//  'room'   - the layout view: zoomed out, ceiling off, near walls hidden, fast preview rendering.
//             Click a wall to select it (the room turns to face it); drag doors and windows along walls.
//  'design' - standing inside the room, path traced.
let mode = S.ui.tab === 'design' ? 'design' : 'room';
let insideCam = null;      // where the inside camera was, to come back to
let tween = null;          // camera move in progress in the layout view
let drag = null, press = null, dragDirty = false;

const overlay = new THREE.Group();   // selection highlights, layout view only
const layoutBg = new THREE.Color('#e9e6df');
const tintMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
const barMat = new THREE.MeshBasicMaterial({ color: ACCENT, toneMapped: false, side: THREE.DoubleSide });
const opMat = new THREE.MeshBasicMaterial({ color: '#e2a03a', transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });

function rebuild() {
  mats.apply(S);
  const built = buildRoom(S, mats);
  if (room) { scene.remove(room); room.traverse((o) => o.geometry?.dispose()); }
  room = built.group; stats = built.stats; frames = wallFrames(S);
  scene.add(room);
  lighting.update(S, stats);
  // Direct sun only comes in through the window, so the shell must cast shadows in that scene.
  room.traverse((o) => { if (o.isMesh && (o.name.startsWith('wall') || o.name === 'ceil')) o.castShadow = lighting.sunny; });
  renderer.toneMappingExposure = S.light.exposure;
  ui.setStats(stats);
  saveState(S);
  applyMode();
  traceDirty = true; lastEdit = performance.now();
}

// ----- layout view -----

// Show or hide what each mode needs. Called after every rebuild and on every mode change.
function applyMode() {
  const layout = mode === 'room';
  stage.classList.toggle('layout', layout);
  if (room) {
    room.traverse((o) => { if (o.isMesh) o.visible = !(layout && (o.name === 'ceil' || o.name.startsWith('stub'))); });
    if (!layout) for (const c of room.children) c.visible = true;
  }
  scene.background = layout ? layoutBg : lighting.sky;
  controls.enablePan = !layout;
  controls.minPolarAngle = layout ? 0.15 : 0;
  controls.maxPolarAngle = layout ? 1.45 : Math.PI;
  if (layout) { scene.add(overlay); updateOverlay(); } else scene.remove(overlay);
}

// Tint the selected wall, put a bar along its foot, and mark the selected opening.
function updateOverlay() {
  for (const c of [...overlay.children]) { overlay.remove(c); c.geometry.dispose(); }
  const f = frames[S.ui.wall];
  if (!f) return;
  const add = (mat, fn) => { const g = new Geo(); g.setMatrix(f.m); fn(g); if (!g.empty) overlay.add(new THREE.Mesh(g.build(IN), mat)); };
  add(tintMat, (g) => g.rect(0, 0, f.len, f.h, 0.25));
  add(barMat, (g) => g.rect(0, 0, f.len, 1.6, 1.6));
  const op = stats?.walls[S.ui.wall]?.ops[S.ui.opening];
  if (op) add(opMat, (g) => g.rect(op.x0, op.y0, op.x1, op.y1, 0.6));
}

// Hide the walls whose backs face the camera, and keep the wall tags over their walls.
const tags = WALL_NAMES.map((n, i) => {
  const b = document.createElement('button');
  b.textContent = `Wall ${n}`;
  b.onclick = () => selectWall(i);
  $('labels').append(b);
  return b;
});
const _v = new THREE.Vector3();
function updateLayoutFrame() {
  if (!room) return;
  const rect = canvas.getBoundingClientRect();
  frames.forEach((f, i) => {
    const mid = _v.copy(f.o).addScaledVector(f.t, f.len / 2).multiplyScalar(IN);
    const facing = f.n.dot(camera.position.clone().sub(mid)) > 0;
    const g = room.getObjectByName(`wall${i}`);
    if (g) g.visible = facing;
    mid.project(camera);
    const tag = tags[i];
    tag.style.left = `${(mid.x * 0.5 + 0.5) * rect.width}px`;
    tag.style.top = `${(-mid.y * 0.5 + 0.5) * rect.height + (facing ? -14 : 16)}px`;
    tag.classList.toggle('on', i === S.ui.wall);
  });
}

// Swing the layout camera round so wall i is the far wall, facing us.
function orbitTo(i, animate = true) {
  const W = S.room.w * IN, L = S.room.l * IN, H = S.room.h * IN;
  const centre = new THREE.Vector3(W / 2, H * 0.3, L / 2);
  camera.fov = 32; camera.updateProjectionMatrix();
  const half = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
  const d1 = 0.5 * Math.hypot(W, L, H) / Math.sin(half) * 1.02;
  const az1 = [0, -Math.PI / 2, Math.PI, Math.PI / 2][i], el1 = 0.58;
  const off = camera.position.clone().sub(centre);
  let az0 = Math.atan2(off.x, off.z), el0 = Math.asin(Math.max(-1, Math.min(1, off.y / (off.length() || 1)))), d0 = off.length();
  if (!animate) { az0 = az1; el0 = el1; d0 = d1; }
  let da = az1 - az0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  tween = { t0: performance.now(), dur: animate ? 650 : 0, centre, az0, da, el0, el1, d0, d1 };
  controls.enabled = false;
}
function stepTween(now) {
  const tw = tween, k = tw.dur ? Math.min(1, (now - tw.t0) / tw.dur) : 1;
  const e = k * k * (3 - 2 * k);
  const az = tw.az0 + tw.da * e, el = tw.el0 + (tw.el1 - tw.el0) * e, d = tw.d0 + (tw.d1 - tw.d0) * e;
  camera.position.set(tw.centre.x + Math.sin(az) * Math.cos(el) * d, tw.centre.y + Math.sin(el) * d, tw.centre.z + Math.cos(az) * Math.cos(el) * d);
  controls.target.copy(tw.centre);
  camera.lookAt(tw.centre);
  if (k >= 1) { tween = null; controls.enabled = true; controls.update(); }
}

function selectWall(i, opening = 0, turn = true) {
  S.ui.wall = i; S.ui.opening = opening;
  saveState(S);
  ui.render();
  if (mode === 'room') { updateOverlay(); if (turn) orbitTo(i); } else setView(`wall${i}`);
}

function setMode(next) {
  if (mode === 'design') insideCam = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov };
  mode = next; S.ui.tab = next; saveState(S);
  applyMode();
  if (mode === 'room') orbitTo(S.ui.wall, false);
  else {
    tween = null; controls.enabled = true;
    if (insideCam) {
      camera.position.copy(insideCam.pos); controls.target.copy(insideCam.target); camera.fov = insideCam.fov;
      camera.updateProjectionMatrix(); controls.update(); syncLens();
    } else setView(`wall${S.ui.wall}`);
    traceDirty = true; lastEdit = 0;
  }
}

// ----- picking and dragging in the layout view -----
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function castRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return { o: ray.ray.origin.clone().divideScalar(IN), d: ray.ray.direction.clone() };   // inches
}
// Where a ray meets wall i, in that wall's own coordinates (x along it, y up). Null if it misses.
function hitWall(r, i, anyFacing) {
  const f = frames[i], denom = r.d.dot(f.n);
  if (anyFacing ? Math.abs(denom) < 1e-6 : denom >= -1e-6) return null;
  const t = f.o.clone().sub(r.o).dot(f.n) / denom;
  if (t <= 0) return null;
  const p = r.o.clone().addScaledVector(r.d, t);
  return { wall: i, t, x: p.clone().sub(f.o).dot(f.t), y: p.y };
}
function pick(e) {
  const r = castRay(e);
  let best = null;
  for (let i = 0; i < 4; i++) {
    const h = hitWall(r, i, false);
    if (h && h.x >= 0 && h.x <= frames[i].len && h.y >= 0 && h.y <= frames[i].h && (!best || h.t < best.t)) best = h;
  }
  if (best) best.op = (stats.walls[best.wall].ops || []).findIndex((o) => best.x >= o.x0 && best.x <= o.x1 && best.y >= o.y0 && best.y <= o.y1);
  return best;
}

// Capture phase, so a drag on a door or window is ours before the orbit controls see it.
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'room' || e.button !== 0 || tween) return;
  const hit = pick(e);
  press = { x: e.clientX, y: e.clientY, hit };
  if (hit && hit.op >= 0) {
    e.stopImmediatePropagation();
    canvas.setPointerCapture(e.pointerId);
    const op = S.walls[hit.wall].openings[hit.op], shown = stats.walls[hit.wall].ops[hit.op];
    op.x = shown.x0;                                  // start from where it is actually drawn
    drag = { wall: hit.wall, op: hit.op, grab: hit.x - shown.x0, w: shown.x1 - shown.x0 };
    if (S.ui.wall !== hit.wall || S.ui.opening !== hit.op) { S.ui.wall = hit.wall; S.ui.opening = hit.op; ui.render(); updateOverlay(); }
  }
}, true);
canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'room') return;
  if (drag) {
    const h = hitWall(castRay(e), drag.wall, true);
    if (!h) return;
    const len = frames[drag.wall].len;
    const x = Math.max(0, Math.min(len - drag.w, Math.round((h.x - drag.grab) * 2) / 2));
    const op = S.walls[drag.wall].openings[drag.op];
    if (op.x !== x) { op.x = x; dragDirty = true; }
    return;
  }
  if (e.buttons) return;
  const hit = pick(e);
  canvas.classList.toggle('over-op', !!hit && hit.op >= 0);
  canvas.classList.toggle('over-wall', !!hit && hit.op < 0);
});
canvas.addEventListener('pointerup', (e) => {
  if (mode !== 'room') return;
  if (drag) {
    canvas.releasePointerCapture(e.pointerId);
    drag = null; press = null;
    ui.render();
    return;
  }
  // A click (not an orbit drag) on a wall selects it and turns the room to face it.
  if (press && press.hit && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) selectWall(press.hit.wall);
  press = null;
});

// ----- inside camera views -----
function setView(name) {
  if (mode === 'room') { if (name.startsWith('wall')) { S.ui.wall = +name.slice(4); updateOverlay(); orbitTo(S.ui.wall); } return; }
  const W = S.room.w * IN, L = S.room.l * IN, H = S.room.h * IN;
  const walls = [
    { c: [W / 2, 0], n: [0, 1], len: W }, { c: [W, L / 2], n: [-1, 0], len: L },
    { c: [W / 2, L], n: [0, -1], len: W }, { c: [0, L / 2], n: [1, 0], len: L },
  ];
  camera.fov = 50;
  if (name.startsWith('wall')) {
    // Stand back against the opposite wall and widen the lens (within reason) until the wall fits.
    const i = +name.slice(4), wl = walls[i];
    const dist = (i % 2 ? W : L) - 0.2;
    const need = 2 * Math.atan(Math.max(H / 2 / dist, wl.len / 2 / dist / camera.aspect) * 1.03) * 180 / Math.PI;
    camera.fov = Math.max(35, Math.min(78, need));
    const y = H * 0.5;
    controls.target.set(wl.c[0], y, wl.c[1]);
    camera.position.set(wl.c[0] + wl.n[0] * dist, y, wl.c[1] + wl.n[1] * dist);
  } else if (name === 'corner') {
    controls.target.set(W * 0.3, H * 0.45, L * 0.1);
    camera.position.set(W * 0.12, H * 0.55, L * 0.93);
  } else if (name === 'detail') {
    controls.target.set(W * 0.25, S.split.height * IN, L);
    camera.position.set(W * 0.5, S.split.height * IN + 0.25, L - Math.min(L * 0.5, 1.5));
  }
  camera.updateProjectionMatrix();
  controls.update();
  pt.updateCamera();
  syncLens();
}

const VIEWS = [...WALL_NAMES.map((n, i) => [`wall${i}`, `Wall ${n}`]), ['corner', 'Corner'], ['detail', 'Close-up']];
for (const [id, label] of VIEWS) {
  const b = document.createElement('button'); b.textContent = label;
  if (!id.startsWith('wall')) b.className = 'design-only';
  b.onclick = () => (id.startsWith('wall') ? selectWall(+id.slice(4)) : setView(id));
  $('views').append(b);
}

const ui = new UI($('controls'), S, {
  onChange: rebuild,
  onView: setView,
  onReset: () => { resetState(S); },
  onTab: setMode,
  onSelect: () => { if (mode === 'room') updateOverlay(); },
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (traceReady) pt.updateCamera();
}
new ResizeObserver(resize).observe(canvas);

// Inside the room the walls are solid to light, so the camera has to stay within them.
controls.addEventListener('change', () => {
  if (mode !== 'design') return;
  const m = 0.12, p = camera.position;
  p.set(Math.max(m, Math.min(S.room.w * IN - m, p.x)), Math.max(m, Math.min(S.room.h * IN - m, p.y)), Math.max(m, Math.min(S.room.l * IN - m, p.z)));
  if (traceReady) pt.updateCamera();
});
// Lens control. Shown as a focal length on a full-frame camera (24 mm sensor height), because that is
// how people think about wide versus zoomed-in shots; the camera itself works in field of view.
const fovToMm = (fov) => 12 / Math.tan(fov * Math.PI / 360);
const mmToFov = (mm) => 2 * Math.atan(12 / mm) * 180 / Math.PI;
function syncLens() {
  const mm = Math.round(fovToMm(camera.fov));
  $('lens').value = mm; $('lensVal').textContent = `${mm}mm`;
}
$('lens').oninput = (e) => {
  camera.fov = mmToFov(+e.target.value);
  camera.updateProjectionMatrix();
  $('lensVal').textContent = `${e.target.value}mm`;
  if (traceReady) pt.updateCamera();
};
$('ptToggle').onchange =(e) => { photoreal = e.target.checked; traceDirty = true; lastEdit = 0; };
$('saveBtn').onclick = () => canvas.toBlob((blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'panel-design.png'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}, 'image/png');

function status(text, done) { $('statusText').textContent = text; $('statusDot').classList.toggle('done', !!done); }

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  if (mode === 'room') {
    if (dragDirty) { dragDirty = false; rebuild(); }
    if (tween) stepTween(now);
    updateLayoutFrame();
    lighting.renderPreview(renderer, scene, camera);
    if (drag) {
      const op = stats.walls[drag.wall].ops[drag.op], len = frames[drag.wall].len;
      status(`${inches(op.x0)} from the left corner · ${inches(len - op.x1)} from the right`);
    } else status('Room layout · click a wall to edit it, drag a door or window to move it', true);
    return;
  }
  if (!photoreal) { lighting.renderPreview(renderer, scene, camera); status('Preview (fast)', true); return; }
  if (traceDirty) {
    if (now - lastEdit < SETTLE_MS) { lighting.renderPreview(renderer, scene, camera); status('Preview…'); return; }
    pt.setScene(scene, camera);
    traceDirty = false; traceReady = true;
  }
  if (pt.samples < MAX_SAMPLES) {
    pt.renderSample();
    status(pt.samples < 1 ? 'Preparing render…' : `Rendering ${Math.floor(pt.samples)} / ${MAX_SAMPLES}`);
  } else status('Render complete', true);
}

resize();
rebuild();
started = true;
if (mode === 'room') orbitTo(S.ui.wall, false); else setView(`wall${S.ui.wall}`);
// handy for debugging from the console
window.planner = { S, ui, scene, camera, renderer, pt, rebuild, setView, setMode, selectWall, get stats() { return stats; }, get mode() { return mode; } };
frame();
