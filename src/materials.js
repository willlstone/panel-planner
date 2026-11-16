import * as THREE from 'three';

// ---------- procedural texture helpers (used for carpet; tileable) ----------

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Tileable fractal value noise, N x N, values 0..1.
function fbm(N, px, py, octaves, seed) {
  const out = new Float32Array(N * N);
  const r = rng(seed);
  let amp = 0.5, total = 0;
  for (let o = 0; o < octaves; o++) {
    const PX = Math.min(N, px << o), PY = Math.min(N, py << o);
    const grid = new Float32Array(PX * PY);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    for (let y = 0; y < N; y++) {
      const fy = y / N * PY, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % PY) * PX, yb = ((y0 + 1) % PY) * PX;
      for (let x = 0; x < N; x++) {
        const fx = x / N * PX, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % PX, xb = (x0 + 1) % PX;
        const a = grid[ya + xa] + (grid[ya + xb] - grid[ya + xa]) * sx;
        const b = grid[yb + xa] + (grid[yb + xb] - grid[yb + xa]) * sx;
        out[y * N + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function tex(data, N, srgb) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

function normalFromHeight(h, N, strength) {
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const yu = ((y + 1) % N) * N, yd = ((y + N - 1) % N) * N;
    for (let x = 0; x < N; x++) {
      const xr = (x + 1) % N, xl = (x + N - 1) % N;
      const dx = (h[y * N + xr] - h[y * N + xl]) * strength, dy = (h[yu + x] - h[yd + x]) * strength;
      const l = 1 / Math.hypot(dx, dy, 1), i = (y * N + x) * 4;
      d[i] = (-dx * l * 0.5 + 0.5) * 255; d[i + 1] = (-dy * l * 0.5 + 0.5) * 255; d[i + 2] = (l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }
  return tex(d, N, false);
}

function carpet(color, seed) {
  const N = 512;
  const hf = fbm(N, 128, 128, 2, seed), lf = fbm(N, 8, 8, 3, seed + 5);
  const c = new THREE.Color(color).convertLinearToSRGB();
  const col = new Uint8Array(N * N * 4), height = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const s = 0.8 + hf[i] * 0.3 + (lf[i] - 0.5) * 0.12;
    col[i * 4] = Math.min(255, c.r * s * 255); col[i * 4 + 1] = Math.min(255, c.g * s * 255); col[i * 4 + 2] = Math.min(255, c.b * s * 255); col[i * 4 + 3] = 255;
    height[i] = hf[i];
  }
  return { map: tex(col, N, true), normalMap: normalFromHeight(height, N, 5), roughnessMap: null, tile: [18, 18], avg: new THREE.Color(color) };
}

// ---------- scanned materials (Poly Haven, CC0; see textures/CREDITS.txt) ----------

// `size` is the real width of one texture tile in inches.
export const FLOORS = {
  strip_oak: { name: 'Strip oak', id: 'wooden_floor_01', size: 78.3 },
  wide_oak: { name: 'Wide-plank oak', id: 'laminate_floor_02', size: 66.9 },
  dark_plank: { name: 'Dark smooth plank', id: 'wood_floor', size: 66.9 },
  herringbone: { name: 'Herringbone parquet', id: 'herringbone_parquet', size: 133.9 },
  carpet: { name: 'Wool carpet' },
};

const WALL_SHEEN = { matte: 1, eggshell: 0.78, satin: 0.55 };

// Painted walls and ceiling use a scanned painted plaster wall (Beige Wall 001, 3 m square). Its colour is
// thrown away except for light and dark variation, so your paint colour sets the average, and its surface relief
// (normal map) is used as scanned. Its roughness map is not used: the scanned wall is far glossier than interior
// eggshell, so sheen comes from your Wall sheen choice. `contrast` scales the light and dark variation.
const WALL_SCAN = { id: 'beige_wall_001', size: 118.1 };
const TEXTURE = { smooth: null, light: { contrast: 0.5, normal: 0.6 }, medium: { contrast: 1, normal: 1.2 } };
const DETAIL_MEAN = 0.9;   // the variation map averages this, so colour = paint / DETAIL_MEAN (keeps it under 1 for export)
const WALL_UV_IN = 78.7;   // inches per unit of wall texture coordinates (WALL_UV in room.js)
const TRIM_SHEEN = { satin: 0.48, semi: 0.3, gloss: 0.14 };

const loader = new THREE.TextureLoader();
function load(url, srgb) {
  return loader.loadAsync(url).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

// Mean colour of a texture, in linear space, so a floor can be tinted to land on a chosen colour.
function averageColor(image) {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data, sum = new THREE.Color(0, 0, 0), px = new THREE.Color();
  for (let i = 0; i < d.length; i += 4) { px.setRGB(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, THREE.SRGBColorSpace); sum.add(px); }
  return sum.multiplyScalar(4 / d.length);
}

export class Materials {
  // onReady is called whenever a texture finishes loading, so the scene can be rebuilt with it.
  constructor(onReady) {
    this.onReady = onReady;
    this.wallU = new THREE.MeshStandardMaterial({ metalness: 0 });
    this.wallL = new THREE.MeshStandardMaterial({ metalness: 0 });
    this.ceil = new THREE.MeshStandardMaterial({ color: '#f4f2ec', roughness: 0.97, metalness: 0 });
    this.trim = new THREE.MeshPhysicalMaterial({ metalness: 0 });
    this.metal = new THREE.MeshStandardMaterial({ color: '#b08d57', roughness: 0.28, metalness: 1 });
    this.floor = new THREE.MeshPhysicalMaterial({ metalness: 0, color: '#b58a5c', roughness: 0.5 });
    // One trim material per part, so box panels, window and door trim, baseboard, crown and chair rail can differ.
    for (const k of ['panelU', 'panelL', 'win', 'base', 'crown', 'rail']) this[k] = new THREE.MeshPhysicalMaterial({ metalness: 0, side: THREE.DoubleSide });
    this.plate = new THREE.MeshPhysicalMaterial({ color: '#f3f2ee', roughness: 0.3, metalness: 0 });   // switch and outlet plastic
    this.slot = new THREE.MeshStandardMaterial({ color: '#1c1b19', roughness: 0.7, metalness: 0 });
    // The path tracer lets light through the back of single-sided surfaces, so the room shell must be
    // double-sided or daylight leaks in through every wall instead of only through the windows.
    for (const m of [this.wallU, this.wallL, this.ceil, this.trim, this.metal, this.floor, this.plate, this.slot]) m.side = THREE.DoubleSide;
    this._floors = {};
    this._scan = null; this._detail = {};
    const sb = `textures/${WALL_SCAN.id}_`;
    Promise.all([load(sb + 'Diffuse.jpg', true), load(sb + 'nor_gl.jpg')]).then(([diff, nor]) => {
      const rep = WALL_UV_IN / WALL_SCAN.size;
      nor.repeat.set(rep, rep);
      this._scan = { diff, nor, rep };
      this._applied = null;
      this.onReady();
    }).catch(() => { /* walls stay smooth */ });
    this._applied = null;
    this.floorTile = [78.3, 78.3];

    // Walls are deliberately untextured: a plaster relief map was tried and only added sampling noise
    // to the path-traced image, and painted drywall is smooth at room scale anyway.
  }

  _floor(kind) {
    if (this._floors[kind]) return this._floors[kind];
    const def = FLOORS[kind];
    if (!def || !def.id) return (this._floors[kind] = carpet('#b9ad9b', 7));
    const entry = (this._floors[kind] = { loading: true, tile: [def.size, def.size] });
    const base = `textures/${def.id}_`;
    Promise.all([load(base + 'Diffuse.jpg', true), load(base + 'nor_gl.jpg'), load(base + 'Rough.jpg')]).then(([map, normalMap, roughnessMap]) => {
      Object.assign(entry, { map, normalMap, roughnessMap, avg: averageColor(map.image), loading: false });
      this._applied = null;
      this.onReady();
    }).catch(() => { entry.failed = true; });
    return entry;
  }

  // The scan's light and dark variation as a grey map averaging DETAIL_MEAN, stored as sRGB like any colour map.
  _detailMap(contrast) {
    if (this._detail[contrast]) return this._detail[contrast];
    const img = this._scan.diff.image, N = img.width;
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, N, N), d = id.data, lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = new Float32Array(N * N);
    let sum = 0;
    for (let i = 0; i < N * N; i++) { L[i] = 0.2126 * lin(d[i * 4]) + 0.7152 * lin(d[i * 4 + 1]) + 0.0722 * lin(d[i * 4 + 2]); sum += L[i]; }
    const mean = sum / (N * N), srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
    for (let i = 0; i < N * N; i++) {
      const v = srgb(Math.max(0, Math.min(1, DETAIL_MEAN * (1 + contrast * (L[i] / mean - 1)))));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    t.repeat.set(this._scan.rep, this._scan.rep);
    return (this._detail[contrast] = t);
  }

  apply(S) {
    const c = S.colors;
    const trimColor = c.mono ? c.wall : c.trim;
    // Painted surfaces: paint colour and sheen, plus the scanned wall texture if it is on and loaded.
    // userData.albedo is the true average colour, for white balance and light baking.
    const tx = TEXTURE[c.texture === undefined ? 'light' : c.texture], scan = this._scan;
    for (const [m, col, k] of [[this.wallU, c.wall, 1], [this.wallL, c.twoTone ? c.lower : c.wall, 1], [this.ceil, '#f4f2ec', 1]]) {
      const sheen = m === this.ceil ? 0.97 : WALL_SHEEN[c.wallSheen];
      m.userData.albedo = new THREE.Color(col);
      const on = !!(tx && scan);
      const map = on ? this._detailMap(tx.contrast) : null;
      if (m.map !== map) { m.map = map; m.normalMap = on ? scan.nor : null; m.needsUpdate = true; }
      m.color.set(col);
      if (on) { m.color.multiplyScalar(1 / DETAIL_MEAN); m.normalScale.set(tx.normal * k, tx.normal * k); }
      m.roughness = sheen;
    }
    this.trim.color.set(trimColor); this.trim.roughness = TRIM_SHEEN[c.trimSheen];
    this.trim.clearcoat = c.trimSheen === 'gloss' ? 0.5 : 0; this.trim.clearcoatRoughness = 0.1;
    // Per-part trim: the wall colour behind it, its own colour, or the general trim colour.
    const upper = c.wall, lower = c.twoTone ? c.lower : c.wall, parts = c.parts || {};
    const partColor = (key, wallBehind) => {
      const p = parts[key] || {};
      return c.mono || p.wall ? wallBehind : (p.color || trimColor);
    };
    const set = (m, col) => { m.color.set(col); m.roughness = this.trim.roughness; m.clearcoat = this.trim.clearcoat; m.clearcoatRoughness = 0.1; };
    set(this.panelU, partColor('panel', upper)); set(this.panelL, partColor('panel', lower));
    set(this.win, partColor('window', upper)); set(this.base, partColor('base', lower));
    set(this.crown, partColor('crown', upper)); set(this.rail, partColor('rail', upper));

    const t = this._floor(S.floor), f = this.floor;
    this.floorTile = t.tile;
    const key = `${S.floor}|${S.floorColor}|${!!t.loading}|${!!this._scan}`;
    if (this._applied === key) return;
    this.floorAvg = null;
    this._applied = key;
    if (t.loading || t.failed) {
      f.map = f.normalMap = f.roughnessMap = null; f.color.set(S.floorColor || '#b58a5c'); f.roughness = 0.5;
    } else {
      f.map = t.map; f.normalMap = t.normalMap; f.roughnessMap = t.roughnessMap; f.roughness = 1;
      // Tint so the floor's average colour lands on the colour the user picked.
      if (S.floorColor) {
        const want = new THREE.Color(S.floorColor), k = (a, b) => Math.min(2.5, a / Math.max(b, 0.01));
        f.color.setRGB(k(want.r, t.avg.r), k(want.g, t.avg.g), k(want.b, t.avg.b));
      } else f.color.set('#ffffff');
    }
    f.normalScale.set(1, 1);
    f.sheen = S.floor === 'carpet' ? 0.6 : 0; f.sheenRoughness = 0.7; f.sheenColor.set('#e8e0d2');
    f.needsUpdate = true;
    // The floor's average colour as rendered (texture average times tint), used for white balance.
    this.floorAvg = t.avg && !t.loading ? t.avg.clone().multiply(f.color) : f.color.clone();
  }
}
