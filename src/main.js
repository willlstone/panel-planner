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
const canvas = $('view'), stage = $('stage'), dimsEl = $('dims');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
// Khronos PBR Neutral keeps surface colours true (film-style ACES shifts hues and greys out pale paint).
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
controls.zoomSpeed = 0.7;
// Straight-on wall view: an orthographic camera square to one wall, so nothing is foreshortened.
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 60);

// Scanned textures arrive after the first frame; rebuild when each one lands.
let started = false;
const mats = new Materials(() => { if (started) rebuild(); });
const lighting = new Lighting(scene, () => { if (started) rebuild(); });   // rebuild when a sky photo loads

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
//             Click a wall to select it (the room turns to face it); drag doors, windows, switches and
//             outlets. `elev` swaps in the straight-on view of the selected wall, with distances drawn on it.
//  'design' - standing inside the room, path traced. Orbit, or `walk` for first-person moves.
let mode = S.ui.tab === 'design' ? 'design' : 'room';
let elev = false, elevView = null;   // elevView: { wall, cx, cy, span } in inches, wall coordinates
let insideCam = null;      // where the inside camera was, to come back to
let tween = null;          // camera move in progress in the layout view
let drag = null, press = null, dragDirty = false;
const view = () => (mode === 'room' && elev ? ortho : camera);

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
  lighting.update(S, stats, mats);
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
  const layout = mode === 'room', flat = layout && elev;
  stage.classList.toggle('layout', layout);
  stage.classList.toggle('elev', flat);
  $('elevBtn').classList.toggle('on', flat);
  $('elevBtn').textContent = flat ? '3D view' : 'Straight on';
  if (room) {
    room.traverse((o) => { if (o.isMesh) o.visible = !(layout && (o.name === 'ceil' || o.name.startsWith('stub'))) && !(flat && o.name === 'floor'); });
    for (const c of room.children) if (c.name.startsWith('wall')) c.visible = !flat || c.name === `wall${S.ui.wall}`;
  }
  scene.background = layout ? layoutBg : lighting.background;
  controls.enabled = !flat && !tween && !walk.on;
  controls.enablePan = !layout;
  controls.minPolarAngle = layout ? 0.15 : 0;
  controls.maxPolarAngle = layout ? 1.45 : Math.PI;
  if (layout) { scene.add(overlay); updateOverlay(); } else scene.remove(overlay);
}

// Tint the selected wall, put a bar along its foot, and mark the selected opening and switch/outlet.
function updateOverlay() {
  for (const c of [...overlay.children]) { overlay.remove(c); c.geometry.dispose(); }
  const f = frames[S.ui.wall];
  if (!f || !stats) return;
  const add = (mat, fn) => { const g = new Geo(); g.setMatrix(f.m); fn(g); if (!g.empty) overlay.add(new THREE.Mesh(g.build(IN), mat)); };
  if (!elev) {
    add(tintMat, (g) => g.rect(0, 0, f.len, f.h, 0.25));
    add(barMat, (g) => g.rect(0, 0, f.len, 1.6, 1.6));
  }
  const ws = stats.walls[S.ui.wall], focus = focusKind();
  const op = ws?.ops[S.ui.opening], fx = ws?.fx[S.ui.fixture];
  if (op && focus === 'op') add(opMat, (g) => g.rect(op.x0, op.y0, op.x1, op.y1, 0.6));
  if (fx && focus === 'fx') add(opMat, (g) => g.rect(fx.x0 - 0.5, fx.y0 - 0.5, fx.x1 + 0.5, fx.y1 + 0.5, 1.2));
}
// Which selection the panel and the dimensions are about: the last thing touched, a switch/outlet by default.
function focusKind() {
  const wl = S.walls[S.ui.wall];
  if (S.ui.focus === 'op' && wl.openings[S.ui.opening]) return 'op';
  if (wl.fixtures[S.ui.fixture]) return 'fx';
  return wl.openings[S.ui.opening] ? 'op' : null;
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
  if (k >= 1) { tween = null; controls.enabled = !elev; controls.update(); }
}

// ----- straight-on wall view -----
function frameElev(i) {
  const f = frames[i], a = camera.aspect || 1;
  elevView = { wall: i, cx: f.len / 2, cy: f.h / 2, span: Math.max(f.h + 26, (f.len + 26) / a) };
  elevView.max = elevView.span * 1.6;
  updateOrtho();
}
function updateOrtho() {
  if (!elevView) return;
  const f = frames[elevView.wall], hs = elevView.span / 2 * IN, ws = hs * (camera.aspect || 1);
  Object.assign(ortho, { left: -ws, right: ws, top: hs, bottom: -hs });
  ortho.updateProjectionMatrix();
  const c = f.o.clone().addScaledVector(f.t, elevView.cx); c.y = elevView.cy; c.multiplyScalar(IN);
  ortho.position.copy(c).addScaledVector(f.n, 20);
  ortho.up.set(0, 1, 0); ortho.lookAt(c); ortho.updateMatrixWorld();
}
function setElev(on) {
  elev = on;
  if (on) { tween = null; frameElev(S.ui.wall); } else orbitTo(S.ui.wall, false);
  applyMode();
}
$('elevBtn').onclick = () => setElev(!elev);

function selectWall(i, opening = 0, turn = true) {
  if (S.ui.wall !== i) S.ui.fixture = 0;
  S.ui.wall = i; S.ui.opening = opening;
  saveState(S);
  ui.render();
  if (mode === 'room') {
    if (elev) { frameElev(i); applyMode(); } else { updateOverlay(); if (turn) orbitTo(i); }
  } else setView(`wall${i}`);
}

function setMode(next) {
  if (mode === 'design') { setWalk(false); insideCam = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov }; }
  mode = next; S.ui.tab = next; saveState(S);
  applyMode();
  if (mode === 'room') { if (elev) frameElev(S.ui.wall); else orbitTo(S.ui.wall, false); }
  else {
    tween = null; controls.enabled = true;
    if (insideCam) {
      camera.position.copy(insideCam.pos); controls.target.copy(insideCam.target); camera.fov = insideCam.fov;
      camera.updateProjectionMatrix(); controls.update(); syncLens();
    } else setView(`wall${S.ui.wall}`);
    traceDirty = true; lastEdit = 0;
  }
}

// ----- picking -----
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function castRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, view());
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
const wallShown = (i) => (mode !== 'room' ? true : room?.getObjectByName(`wall${i}`)?.visible !== false);
function pick(e) {
  const r = castRay(e);
  let best = null;
  for (let i = 0; i < 4; i++) {
    if (!wallShown(i)) continue;
    const h = hitWall(r, i, false);
    if (h && h.x >= 0 && h.x <= frames[i].len && h.y >= 0 && h.y <= frames[i].h && (!best || h.t < best.t)) best = h;
  }
  if (best) {
    const ws = stats.walls[best.wall], inside = (o, m = 0) => best.x >= o.x0 - m && best.x <= o.x1 + m && best.y >= o.y0 - m && best.y <= o.y1 + m;
    best.fx = ws.fx.findIndex((o) => inside(o, 0.4));
    best.op = best.fx >= 0 ? -1 : ws.ops.findIndex((o) => inside(o));
  }
  return best;
}
// Inches per screen pixel at a point `t` inches from the camera; used to size snapping in pixels.
function inchesPerPixel(t) {
  const h = canvas.clientHeight || 1;
  if (mode === 'room' && elev) return elevView.span / h;
  return t * 2 * Math.tan(camera.fov * Math.PI / 360) / h;
}

// Pointer capture can refuse some pointers (synthetic or already-released ones); dragging works without it.
const capture = (e) => { try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ } };

// ----- dragging in the layout views (and panning / zooming the straight-on view) -----
const busy = () => mode !== 'room' || tween;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (measure.on) { press = { x: e.clientX, y: e.clientY }; return; }
  if (busy()) return;
  const hit = pick(e);
  press = { x: e.clientX, y: e.clientY, hit };
  if (hit && hit.fx >= 0) {
    e.stopImmediatePropagation();
    capture(e);
    const f = S.walls[hit.wall].fixtures[hit.fx], shown = stats.walls[hit.wall].fx[hit.fx];
    f.x = shown.cx; f.y = shown.cy;
    drag = { kind: 'fx', wall: hit.wall, i: hit.fx, gx: hit.x - shown.cx, gy: hit.y - shown.cy, hw: (shown.x1 - shown.x0) / 2, hh: (shown.y1 - shown.y0) / 2 };
    S.ui.wall = hit.wall; S.ui.fixture = hit.fx; S.ui.focus = 'fx'; ui.render(); updateOverlay();
  } else if (hit && hit.op >= 0) {
    e.stopImmediatePropagation();
    capture(e);
    const op = S.walls[hit.wall].openings[hit.op], shown = stats.walls[hit.wall].ops[hit.op];
    op.x = shown.x0;                                  // start from where it is actually drawn
    drag = { kind: 'op', wall: hit.wall, i: hit.op, grab: hit.x - shown.x0, w: shown.x1 - shown.x0 };
    S.ui.wall = hit.wall; S.ui.opening = hit.op; S.ui.focus = 'op'; ui.render(); updateOverlay();
  } else if (elev) {
    e.stopImmediatePropagation();
    capture(e);
    drag = { kind: 'pan', x: e.clientX, y: e.clientY, cx: elevView.cx, cy: elevView.cy };
  }
}, true);
canvas.addEventListener('pointermove', (e) => {
  if (measure.on) { if (!e.buttons || walk.on) measure.hover = measurePoint(e); }
  if (walk.on && e.buttons && look) { stepLook(e); return; }
  if (mode !== 'room') return;
  if (drag?.kind === 'pan') {
    const k = elevView.span / (canvas.clientHeight || 1);
    elevView.cx = drag.cx - (e.clientX - drag.x) * k; elevView.cy = drag.cy + (e.clientY - drag.y) * k;
    updateOrtho();
    return;
  }
  if (drag) {
    const h = hitWall(castRay(e), drag.wall, true);
    if (!h) return;
    const f = frames[drag.wall];
    if (drag.kind === 'fx') {
      const fx = S.walls[drag.wall].fixtures[drag.i];
      const x = Math.max(drag.hw, Math.min(f.len - drag.hw, Math.round((h.x - drag.gx) * 4) / 4));
      const y = Math.max(drag.hh, Math.min(f.h - drag.hh, Math.round((h.y - drag.gy) * 4) / 4));
      if (fx.x !== x || fx.y !== y) { fx.x = x; fx.y = y; dragDirty = true; }
    } else {
      const x = Math.max(0, Math.min(f.len - drag.w, Math.round((h.x - drag.grab) * 2) / 2));
      const op = S.walls[drag.wall].openings[drag.i];
      if (op.x !== x) { op.x = x; dragDirty = true; }
    }
    return;
  }
  if (e.buttons || measure.on || tween) return;
  const hit = pick(e);
  canvas.classList.toggle('over-fx', !!hit && hit.fx >= 0);
  canvas.classList.toggle('over-op', !!hit && hit.op >= 0);
  canvas.classList.toggle('over-wall', !!hit && hit.op < 0 && hit.fx < 0);
});
canvas.addEventListener('pointerup', (e) => {
  const click = press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5;
  if (measure.on) { if (click) measureClick(e); press = null; return; }
  if (mode !== 'room') return;
  if (drag) {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const was = drag; drag = null; press = null;
    if (was.kind !== 'pan') ui.render();
    return;
  }
  // A click (not an orbit drag) on a wall selects it and turns the room to face it.
  if (click && press.hit && !elev) selectWall(press.hit.wall);
  press = null;
});
// Wheel in the straight-on view zooms about the cursor.
canvas.addEventListener('wheel', (e) => {
  if (mode === 'room' && elev) {
    e.preventDefault(); e.stopImmediatePropagation();
    const r = canvas.getBoundingClientRect(), nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    const a = camera.aspect, before = elevView.span;
    const after = Math.max(8, Math.min(elevView.max, before * Math.exp(e.deltaY * 0.0012)));
    elevView.cx += nx * a * (before - after) / 2; elevView.cy += ny * (before - after) / 2; elevView.span = after;
    updateOrtho();
  } else if (walk.on) {
    e.preventDefault(); e.stopImmediatePropagation();
    moveWalk(-e.deltaY * 0.0015, 0, 0);
  }
}, { capture: true, passive: false });

// Arrow keys nudge the selected switch or outlet in the layout views.
window.addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Escape' && measure.on) { if (measure.a) measure.a = null; else if (measure.list.length) measure.list = []; else setMeasure(false); return; }
  if (walk.on) { keys.add(e.code); if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); return; }
  if (mode !== 'room' || !e.key.startsWith('Arrow') || focusKind() !== 'fx') return;
  const f = S.walls[S.ui.wall].fixtures[S.ui.fixture], st = e.shiftKey ? 1 : 0.25;
  if (e.key === 'ArrowLeft') f.x -= st; if (e.key === 'ArrowRight') f.x += st;
  if (e.key === 'ArrowUp') f.y += st; if (e.key === 'ArrowDown') f.y -= st;
  e.preventDefault();
  rebuild(); ui.render();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// ----- walking around inside the room -----
const walk = { on: false, yaw: 0, pitch: 0 };
const keys = new Set();
let look = null, lastT = performance.now();
function syncWalkFromCamera() {
  const d = new THREE.Vector3(); camera.getWorldDirection(d);
  walk.yaw = Math.atan2(-d.x, -d.z); walk.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
}
function applyWalk() {
  camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
  clampInside();
  if (traceReady) pt.updateCamera();
}
function setWalk(on) {
  if (on === walk.on) return;
  walk.on = on;
  $('walkBtn').classList.toggle('on', on);
  stage.classList.toggle('walking', on);
  if (on) { syncWalkFromCamera(); controls.enabled = false; setEye(S.eye); }
  else {
    keys.clear();
    const d = new THREE.Vector3(); camera.getWorldDirection(d);
    controls.target.copy(camera.position).addScaledVector(d, 1.2);
    controls.enabled = true; controls.update();
  }
}
$('walkBtn').onclick = () => setWalk(!walk.on);
// Eye height: where the walking camera sits, in inches. Saved with the design; Q / E change it too.
function setEye(inch, save = true) {
  S.eye = Math.max(24, Math.min(S.room.h - 6, Math.round(inch * 4) / 4));
  camera.position.y = S.eye * IN;
  $('eye').value = Math.round(S.eye); $('eyeVal').textContent = feetIn(S.eye * IN);
  applyWalk();
  if (save) saveState(S);
}
$('eye').oninput = (e) => setEye(+e.target.value);
canvas.addEventListener('pointerdown', (e) => {
  if (!walk.on || e.button !== 0) return;
  look = { x: e.clientX, y: e.clientY };
  capture(e);
});
canvas.addEventListener('pointerup', (e) => { look = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); });
function stepLook(e) {
  const k = 0.0035 * camera.fov / 50;
  walk.yaw -= (e.clientX - look.x) * k; walk.pitch = Math.max(-1.45, Math.min(1.45, walk.pitch - (e.clientY - look.y) * k));
  look = { x: e.clientX, y: e.clientY };
  applyWalk();
}
// forward / right / up in metres, forward and right along the floor
function moveWalk(fw, rt, up) {
  const s = Math.sin(walk.yaw), c = Math.cos(walk.yaw);
  camera.position.x += -s * fw + c * rt; camera.position.z += -c * fw - s * rt; camera.position.y += up;
  applyWalk();
}
function stepWalk(dt) {
  if (!keys.size) return;
  const has = (...k) => k.some((c) => keys.has(c));
  const v = (has('ShiftLeft', 'ShiftRight') ? 2.4 : 0.9) * dt;
  const fw = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
  const rt = (has('KeyD') ? 1 : 0) - (has('KeyA') ? 1 : 0);
  const up = (has('KeyE', 'PageUp') ? 1 : 0) - (has('KeyQ', 'PageDown') ? 1 : 0);
  const turn = (has('ArrowLeft') ? 1 : 0) - (has('ArrowRight') ? 1 : 0);
  if (turn) walk.yaw += turn * 1.3 * dt;
  if (fw || rt || up || turn) moveWalk(fw * v, rt * v, up * v * 0.6);
  if (up) setEye(camera.position.y / IN, false);
}
// Level: point the camera dead level so walls' vertical edges stay vertical in the picture.
$('levelBtn').onclick = () => {
  if (walk.on) { walk.pitch = 0; applyWalk(); return; }
  controls.target.y = camera.position.y; controls.update();
  if (traceReady) pt.updateCamera();
};

// ----- measuring -----
const measure = { on: false, list: [], a: null, hover: null };
function setMeasure(on) {
  measure.on = on; measure.list = []; measure.a = null; measure.hover = null;
  $('measureBtn').classList.toggle('on', on);
  canvas.classList.toggle('measuring', on);
}
$('measureBtn').onclick = () => setMeasure(!measure.on);
// A wall point under the cursor, snapped to nearby corners, edges, trim lines and the like.
function measurePoint(e) {
  const h = pick(e);
  if (!h) return null;
  const ws = stats.walls[h.wall], f = frames[h.wall], L = stats.lines;
  const tol = 9 * inchesPerPixel(h.t);
  const xs = [0, f.len], ys = [0, f.h, L.base, L.split];
  if (L.railBot != null) ys.push(L.railBot);
  if (L.crown != null) ys.push(L.crown);
  for (const b of [...ws.blocks, ...ws.ops, ...ws.fx, ...ws.boxes]) { xs.push(b.x0, b.x1); ys.push(b.y0, b.y1); }
  for (const b of ws.fx) { xs.push(b.cx); ys.push(b.cy); }
  const snap = (v, list) => { let best = v, d = tol; for (const c of list) if (Math.abs(c - v) < d) { d = Math.abs(c - v); best = c; } return best; };
  let p = { wall: h.wall, x: snap(h.x, xs), y: snap(h.y, ys) };
  // Measurements are always level or plumb: the second point follows whichever direction you move most.
  // Across two walls only a level measurement makes sense, so the height is held.
  const a = measure.a;
  if (a) {
    if (a.wall !== p.wall) p.y = a.y;
    else if (Math.abs(p.x - a.x) >= Math.abs(p.y - a.y)) p.y = a.y; else p.x = a.x;
  }
  return p;
}
function measureClick(e) {
  const p = measurePoint(e);
  if (!p) return;
  if (!measure.a) measure.a = p;
  else { measure.list.push({ a: measure.a, b: p }); measure.a = null; }
}
const worldOf = (p, z = 0.3) => { const f = frames[p.wall]; const v = f.o.clone().addScaledVector(f.t, p.x).addScaledVector(f.n, z); v.y = p.y; return v; };

// ----- dimension overlay (SVG over the canvas) -----
let cw = 1, ch = 1, lastSvg = '', fxWarn = '';
function scr(wall, x, y, z = 0.4) {
  const v = worldOf({ wall, x, y }, z).multiplyScalar(IN).project(view());
  if (v.z > 1 || v.z < -1) return null;
  return [(v.x * 0.5 + 0.5) * cw, (-v.y * 0.5 + 0.5) * ch];
}
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function dim(p, q, text, cls = '') {
  if (!p || !q) return '';
  const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * 5, ny = dx / L * 5;
  const f = (n) => n.toFixed(1);
  let tx = (p[0] + q[0]) / 2, ty = (p[1] + q[1]) / 2, anchor = 'middle';
  if (Math.abs(nx) > Math.abs(ny)) { tx += 7; anchor = 'start'; ty += 4; } else ty -= 7;
  return `<g class="dim ${cls}"><line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(q[0])}" y2="${f(q[1])}"/>`
    + `<line x1="${f(p[0] - nx)}" y1="${f(p[1] - ny)}" x2="${f(p[0] + nx)}" y2="${f(p[1] + ny)}"/>`
    + `<line x1="${f(q[0] - nx)}" y1="${f(q[1] - ny)}" x2="${f(q[0] + nx)}" y2="${f(q[1] + ny)}"/>`
    + `<text x="${f(tx)}" y="${f(ty)}" text-anchor="${anchor}">${esc(text)}</text></g>`;
}
const overlapY = (a, b) => a.y0 < b.y1 - 0.01 && a.y1 > b.y0 + 0.01;
const overlapX = (a, b) => a.x0 < b.x1 - 0.01 && a.x1 > b.x0 + 0.01;
// Nearest things to the left and right of `box` on its wall (wall corners if nothing else).
function sideNeighbours(wi, box, self) {
  const ws = stats.walls[wi], len = frames[wi].len;
  const items = [...ws.blocks.map((b, i) => ({ ...b, name: ws.types[i], key: `op${i}` })), ...ws.fx.map((b, i) => ({ ...b, name: S.walls[wi].fixtures[i]?.type || 'plate', key: `fx${i}` }))];
  let L = { x: 0, name: 'corner' }, R = { x: len, name: 'corner' };
  for (const it of items) {
    if (it.key === self || !overlapY(it, box)) continue;
    if (it.x1 <= box.x0 + 0.01 && it.x1 > L.x) L = { x: it.x1, name: it.name };
    if (it.x0 >= box.x1 - 0.01 && it.x0 < R.x) R = { x: it.x0, name: it.name };
  }
  // box mouldings: stop at whichever face of a moulding stile is nearest
  const mw = S.mould.w;
  for (const o of ws.boxes) {
    if (!overlapY(o, box)) continue;
    for (const x of [o.x0 + mw, o.x1]) if (x <= box.x0 + 0.01 && x > L.x) L = { x, name: 'box moulding' };
    for (const x of [o.x0, o.x1 - mw]) if (x >= box.x1 - 0.01 && x < R.x) R = { x, name: 'box moulding' };
  }
  return { L, R };
}
function selectionDims() {
  fxWarn = '';
  const wi = S.ui.wall, ws = stats?.walls[wi];
  if (!ws || !wallShown(wi)) return '';
  const kind = focusKind();
  let out = '';
  if (kind === 'fx') {
    const b = ws.fx[S.ui.fixture], { L, R } = sideNeighbours(wi, b, `fx${S.ui.fixture}`), lines = stats.lines;
    out += dim(scr(wi, L.x, b.cy), scr(wi, b.x0, b.cy), `${inches(b.x0 - L.x)} to ${L.name}`);
    out += dim(scr(wi, b.x1, b.cy), scr(wi, R.x, b.cy), `${inches(R.x - b.x1)} to ${R.name}`);
    const vx = b.x1 + 1.5;
    out += dim(scr(wi, vx, 0), scr(wi, vx, b.cy), `${inches(b.cy)} floor to centre`);
    // nearest thing above the plate
    let up = { y: frames[wi].h, name: 'ceiling' };
    const above = [[lines.railBot, 'chair rail'], [lines.crown, 'crown']];
    for (const [y, name] of above) if (y != null && y >= b.y1 - 0.01 && y < up.y) up = { y, name };
    ws.blocks.forEach((o, i) => { if (overlapX(o, b) && o.y0 >= b.y1 - 0.01 && o.y0 < up.y) up = { y: o.y0, name: ws.types[i] }; });
    ws.boxes.forEach((o) => { if (overlapX(o, b)) for (const y of [o.y0, o.y1 - S.mould.w]) if (y >= b.y1 - 0.01 && y < up.y) up = { y, name: 'box moulding' }; });
    out += dim(scr(wi, b.cx, b.y1), scr(wi, b.cx, up.y), `${inches(up.y - b.y1)} to ${up.name}`);
    // warn when the plate would sit on trim
    const warn = [];
    if (lines.railBot != null && b.y1 > lines.railBot + 0.01 && b.y0 < lines.split - 0.01) warn.push('the chair rail');
    if (b.y0 < lines.base - 0.01) warn.push('the baseboard');
    if (lines.crown != null && b.y1 > lines.crown + 0.01) warn.push('the crown');
    ws.blocks.forEach((o, i) => { if (overlapX(o, b) && overlapY(o, b)) warn.push(`the ${ws.types[i]}`); });
    const mw = S.mould.w;
    if (ws.boxes.some((o) => overlapX(o, b) && overlapY(o, b) && !(b.x0 >= o.x0 + mw && b.x1 <= o.x1 - mw && b.y0 >= o.y0 + mw && b.y1 <= o.y1 - mw))) warn.push('a box moulding');
    if (warn.length) {
      fxWarn = `Overlaps ${[...new Set(warn)].join(', ')}`;
      const c = [scr(wi, b.x0, b.y0), scr(wi, b.x1, b.y0), scr(wi, b.x1, b.y1), scr(wi, b.x0, b.y1)];
      if (c.every(Boolean)) out += `<polygon class="warn" points="${c.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/>`;
    }
  } else if (kind === 'op') {
    const i = S.ui.opening, b = ws.blocks[i], o = ws.ops[i];
    if (!b) return '';
    const { L, R } = sideNeighbours(wi, b, `op${i}`), y = Math.min(b.y1 - 6, (o.y0 + o.y1) / 2);
    out += dim(scr(wi, L.x, y), scr(wi, b.x0, y), `${inches(b.x0 - L.x)} to ${L.name}`);
    out += dim(scr(wi, b.x1, y), scr(wi, R.x, y), `${inches(R.x - b.x1)} to ${R.name}`);
    if (o.y0 > 0.5) out += dim(scr(wi, (o.x0 + o.x1) / 2, 0), scr(wi, (o.x0 + o.x1) / 2, o.y0), `${inches(o.y0)} to sill`);
  }
  return out;
}
function measureSvg() {
  let out = '';
  const line = (a, b, cls) => {
    const p = scr(a.wall, a.x, a.y, 0.6), q = scr(b.wall, b.x, b.y, 0.6);
    if (!p || !q) return '';
    const d = worldOf(a, 0).distanceTo(worldOf(b, 0));
    let text = inches(d);
    if (a.wall === b.wall && Math.abs(a.x - b.x) > 0.06 && Math.abs(a.y - b.y) > 0.06) text += `  (${inches(Math.abs(a.x - b.x))} across, ${inches(Math.abs(a.y - b.y))} up)`;
    return dim(p, q, text, cls);
  };
  for (const m of measure.list) out += line(m.a, m.b, 'meas');
  if (measure.a && measure.hover) out += line(measure.a, measure.hover, 'meas live');
  for (const p of [measure.a, measure.hover]) {
    const s = p && scr(p.wall, p.x, p.y, 0.6);
    if (s) out += `<circle class="meas" cx="${s[0].toFixed(1)}" cy="${s[1].toFixed(1)}" r="3.5"/>`;
  }
  return out;
}
function drawOverlay() {
  cw = canvas.clientWidth || 1; ch = canvas.clientHeight || 1;
  let out = '';
  if (mode === 'room' && !measure.on && !tween) out += selectionDims(); else fxWarn = '';
  if (measure.on) out += measureSvg();
  if (out !== lastSvg) { dimsEl.innerHTML = out; lastSvg = out; }
}

// ----- inside camera views -----
function setView(name) {
  if (mode === 'room') { if (name.startsWith('wall')) selectWall(+name.slice(4)); return; }
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
  if (walk.on) syncWalkFromCamera();
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
  updateOrtho();
  if (traceReady) pt.updateCamera();
}
new ResizeObserver(resize).observe(canvas);

// Inside the room the walls are solid to light, so the camera has to stay within them.
function clampInside() {
  const m = 0.12, p = camera.position;
  p.set(Math.max(m, Math.min(S.room.w * IN - m, p.x)), Math.max(m, Math.min(S.room.h * IN - m, p.y)), Math.max(m, Math.min(S.room.l * IN - m, p.z)));
}
controls.addEventListener('change', () => {
  if (mode !== 'design') return;
  clampInside();
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
$('ptToggle').onchange = (e) => { photoreal = e.target.checked; traceDirty = true; lastEdit = 0; };
$('saveBtn').onclick = () => canvas.toBlob((blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'panel-design.png'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}, 'image/png');

function status(text, done) { $('statusText').textContent = text; $('statusDot').classList.toggle('done', !!done); }
const feetIn = (m) => { const v = Math.round(m / IN), f = Math.floor(v / 12); return `${f}' ${v - f * 12}"`; };
const MEASURE_HINT = 'Measuring · click two points on the walls; lines stay level or plumb · Esc clears';

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (mode === 'room') {
    if (dragDirty) { dragDirty = false; rebuild(); }
    if (tween) stepTween(now);
    if (!elev) updateLayoutFrame();
    lighting.renderPreview(renderer, scene, view());
    drawOverlay();
    if (measure.on) status(MEASURE_HINT, true);
    else if (drag?.kind === 'fx') {
      const b = stats.walls[drag.wall].fx[drag.i];
      status(`Centre ${inches(b.cx)} from the left corner · ${inches(b.cy)} up`);
    } else if (drag?.kind === 'op') {
      const op = stats.walls[drag.wall].ops[drag.i], len = frames[drag.wall].len;
      status(`${inches(op.x0)} from the left corner · ${inches(len - op.x1)} from the right`);
    } else if (fxWarn) status(fxWarn);
    else if (elev) status(`Wall ${WALL_NAMES[S.ui.wall]} straight on · drag switches, outlets, doors and windows · scroll to zoom, drag the wall to pan`, true);
    else status('Room layout · click a wall to edit it, drag a door, window, switch or outlet to move it', true);
    return;
  }
  if (walk.on) stepWalk(dt);
  drawOverlay();
  const hint = measure.on ? MEASURE_HINT : walk.on ? `Walking · drag to look, W A S D or arrows to move, Q / E down and up` : '';
  if (!photoreal) { lighting.renderPreview(renderer, scene, camera); status(hint || 'Preview (fast)', true); return; }
  if (traceDirty) {
    if (now - lastEdit < SETTLE_MS) { lighting.renderPreview(renderer, scene, camera); status(hint || 'Preview…'); return; }
    pt.setScene(scene, camera);
    traceDirty = false; traceReady = true;
  }
  if (pt.samples < MAX_SAMPLES) {
    pt.renderSample();
    const prog = pt.samples < 1 ? 'Preparing render…' : `Rendering ${Math.floor(pt.samples)} / ${MAX_SAMPLES}`;
    status(hint ? `${hint} · ${pt.samples < 1 ? '…' : Math.floor(pt.samples)}` : prog);
  } else status(hint || 'Render complete', true);
}

resize();
rebuild();
started = true;
if (mode === 'room') orbitTo(S.ui.wall, false); else setView(`wall${S.ui.wall}`);
// handy for debugging from the console
window.planner = { S, ui, scene, camera, ortho, renderer, pt, rebuild, setView, setMode, selectWall, setElev, setWalk, setMeasure, measure, walk, get elevView() { return elevView; }, get stats() { return stats; }, get mode() { return mode; } };
frame();
