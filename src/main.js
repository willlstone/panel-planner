import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer, DenoiseMaterial } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { loadState, saveState, resetState } from './state.js';
import { Materials } from './materials.js';
import { buildRoom, IN, WALL_NAMES } from './room.js';
import { Lighting } from './lighting.js';
import { UI } from './ui.js';

const MAX_SAMPLES = 800;        // path tracing stops refining here
const SETTLE_MS = 160;          // wait this long after the last edit before re-tracing

const $ = (id) => document.getElementById(id);
const fail = (msg) => { const e = $('error'); e.hidden = false; e.textContent = msg; };
window.addEventListener('error', (e) => fail(`Something went wrong:\n${e.message}`));
window.addEventListener('unhandledrejection', (e) => fail(`Something went wrong:\n${e.reason?.message || e.reason}`));

const S = loadState();
const canvas = $('view');
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

let room = null, stats = null;
let traceDirty = true, lastEdit = 0, traceReady = false, photoreal = true;

function rebuild() {
  mats.apply(S);
  const built = buildRoom(S, mats);
  if (room) { scene.remove(room); room.traverse((o) => o.geometry?.dispose()); }
  room = built.group; stats = built.stats;
  scene.add(room);
  lighting.update(S, stats);
  // Direct sun only comes in through the window, so the shell must cast shadows in that scene.
  room.traverse((o) => { if (o.isMesh && (o.name.startsWith('wall') || o.name === 'ceil')) o.castShadow = lighting.sunny; });
  renderer.toneMappingExposure = S.light.exposure;
  ui.setStats(stats);
  saveState(S);
  traceDirty = true; lastEdit = performance.now();
}

// ----- camera views -----
function setView(name) {
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
}

const VIEWS = [...WALL_NAMES.map((n, i) => [`wall${i}`, `Wall ${n}`]), ['corner', 'Corner'], ['detail', 'Close-up']];
for (const [id, label] of VIEWS) {
  const b = document.createElement('button'); b.textContent = label; b.onclick = () => setView(id);
  $('views').append(b);
}

const ui = new UI($('controls'), S, {
  onChange: rebuild,
  onView: setView,
  onReset: () => { resetState(S); },
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (traceReady) pt.updateCamera();
}
new ResizeObserver(resize).observe(canvas);

// The walls are solid to light, so the camera has to stay inside the room.
controls.addEventListener('change', () => {
  const m = 0.12, p = camera.position;
  p.set(Math.max(m, Math.min(S.room.w * IN - m, p.x)), Math.max(m, Math.min(S.room.h * IN - m, p.y)), Math.max(m, Math.min(S.room.l * IN - m, p.z)));
  if (traceReady) pt.updateCamera();
});
$('ptToggle').onchange = (e) => { photoreal = e.target.checked; traceDirty = true; lastEdit = 0; };
$('saveBtn').onclick = () => canvas.toBlob((blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'panel-design.png'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}, 'image/png');

function status(text, done) { $('statusText').textContent = text; $('statusDot').classList.toggle('done', !!done); }

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
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
setView('wall0');
// handy for debugging from the console
window.planner = { S, ui, scene, camera, renderer, pt, rebuild, setView, get stats() { return stats; } };
frame();
