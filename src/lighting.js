import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GradientEquirectTexture, ShapedAreaLight } from 'three-gpu-pathtracer';
import { IN } from './room.js';

// Colour of light from a source at K kelvin (Tanner Helland's fit to the black-body curve), as linear RGB
// scaled to luminance 1, so changing the colour temperature does not change brightness.
export function kelvin(K) {
  const t = K / 100, cl = (v) => Math.max(0, Math.min(255, v)) / 255;
  let r, g, b;
  if (t <= 66) {
    r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255;
  }
  const c = new THREE.Color().setRGB(cl(r), cl(g), cl(b), THREE.SRGBColorSpace);
  return c.multiplyScalar(1 / lum(c));
}
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const unit = (c) => c.clone().multiplyScalar(1 / Math.max(1e-6, lum(c)));
const maxOne = (c) => c.multiplyScalar(1 / Math.max(c.r, c.g, c.b));
const rotY = (v, a) => new THREE.Vector3(v.x * Math.cos(a) + v.z * Math.sin(a), v.y, -v.x * Math.sin(a) + v.z * Math.cos(a));

// Fallback colour temperatures, used before the sky photographs have loaded.
const DAYLIGHT = {
  soft:  { north: 7500, east: 6500, south: 6000, west: 6200 },
  sunny: { north: 9000, east: 6800, south: 6500, west: 6600 },
};
const SUN = { east: 4300, south: 5500, west: 4000 };

// Photographed skies (Poly Haven, CC0; see textures/CREDITS.txt). Daylight in the path tracer comes from
// these: real sky colour and brightness, and in 'sunny' a real sun, through the window openings.
const SKIES = { soft: 'textures/sky_overcast_2k.hdr', sunny: 'textures/sky_sunny_2k.hdr' };
// How bright the sky is, as the average radiance of the sky excluding the sun (sets overall daylight level).
const SKY_LEVEL = { soft: 30, sunny: 20 };
// Where the sun sits relative to the window, by the way the window faces: in front for south, glancing in
// from the side for east and west, behind the house for north.
const SUN_OFFSET = { south: 20, east: 65, west: -65, north: 180 };

class HdrSky {
  constructor(url, onReady) {
    new RGBELoader().setDataType(THREE.FloatType).loadAsync(url)
      .then((tex) => { this._analyse(tex); this.ready = true; onReady(); })
      .catch(() => { this.failed = true; });
  }

  // Boil the image down to a 64 x 32 grid of directions and colours, find the sun, and measure how bright
  // the sky is, so window light can be worked out for any orientation without touching the GPU.
  _analyse(tex) {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    this.tex = tex;
    const { data, width: w, height: h } = tex.image;
    const L = (k) => 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    let top = 0, bottom = 0;
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { const v = L((y * w + x) * 4); if (y < h / 2) top += v; else bottom += v; }
    const zenithFirst = top > bottom;   // which end of the image is the sky
    const dir = (u, row) => {
      const v = zenithFirst ? 1 - row / h : row / h, el = (v - 0.5) * Math.PI, ph = (u - 0.5) * 2 * Math.PI;
      return new THREE.Vector3(Math.cos(el) * Math.cos(ph), Math.sin(el), Math.cos(el) * Math.sin(ph));
    };
    const GW = 64, GH = 32, sum = new Float64Array(GW * GH * 3);
    let peak = -1, pk = 0;
    for (let y = 0; y < h; y++) {
      const j = Math.floor(y * GH / h);
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4, c = (j * GW + Math.floor(x * GW / w)) * 3;
        sum[c] += data[k]; sum[c + 1] += data[k + 1]; sum[c + 2] += data[k + 2];
        const v = L(k); if (v > peak) { peak = v; pk = y * w + x; }
      }
    }
    const per = (w / GW) * (h / GH);
    this.cells = [];
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const c = (j * GW + i) * 3, d = dir((i + 0.5) / GW, (j + 0.5) * h / GH);
      const col = new THREE.Color(sum[c] / per, sum[c + 1] / per, sum[c + 2] / per);
      this.cells.push({ d, col, dw: Math.max(0, Math.sqrt(1 - d.y * d.y)) * (2 * Math.PI / GW) * (Math.PI / GH) });
    }
    this.sun = dir((pk % w + 0.5) / w, Math.floor(pk / w) + 0.5);
    this.sunColor = new THREE.Color(data[pk * 4], data[pk * 4 + 1], data[pk * 4 + 2]);
    // Clamp the brightest cells (the sun) to a few times the typical sky so sky level means sky, not sun.
    const ls = this.cells.filter((c) => c.d.y > 0).map((c) => lum(c.col)).sort((a, b) => a - b);
    this.clampL = ls[Math.floor(ls.length / 2)] * 6;
    this.level = lum(this.irradiance(new THREE.Vector3(0, 1, 0), 0, true)) / Math.PI;
  }

  // Light arriving on a surface facing `o`, with the sky turned by `theta`: cosine-weighted sum over the sky.
  irradiance(o, theta, clamp) {
    const E = new THREE.Color(0, 0, 0);
    for (const c of this.cells) {
      const cos = rotY(c.d, theta).dot(o);
      if (cos <= 0) continue;
      const l = lum(c.col), k = clamp && l > this.clampL ? this.clampL / l : 1;
      E.r += c.col.r * k * cos * c.dw; E.g += c.col.g * k * cos * c.dw; E.b += c.col.b * k * cos * c.dw;
    }
    return E;
  }

  // The sky image multiplied by a white-balance colour, kept until the balance changes.
  tinted(wb) {
    if (wb.r === 1 && wb.g === 1 && wb.b === 1) return this.tex;
    const key = wb.getHexString();
    if (this._tintKey === key) return this._tint;
    this._tint?.dispose();
    const src = this.tex.image.data, out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 4) { out[i] = src[i] * wb.r; out[i + 1] = src[i + 1] * wb.g; out[i + 2] = src[i + 2] * wb.b; out[i + 3] = 1; }
    const t = new THREE.DataTexture(out, this.tex.image.width, this.tex.image.height, THREE.RGBAFormat, THREE.FloatType);
    Object.assign(t, { mapping: THREE.EquirectangularReflectionMapping, flipY: this.tex.flipY, colorSpace: this.tex.colorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, needsUpdate: true });
    this._tint = t; this._tintKey = key;
    return t;
  }
}

// Two rigs:
//  - `shared` lights are real: the path tracer uses them, and the quick preview shows them unshadowed.
//  - `preview` lights exist only for the rasterised preview, standing in for light the path tracer
//    computes properly (bounce light, and daylight from the sky photograph). Attached just for the preview.
export class Lighting {
  constructor(scene, onReady = () => {}) {
    this.scene = scene;
    this.onReady = onReady;
    this.shared = new THREE.Group(); this.shared.name = 'lights';
    this.preview = new THREE.Group(); this.preview.name = 'preview-lights';
    scene.add(this.shared);
    this.sky = new GradientEquirectTexture(256);
    this.background = this.sky;
    scene.background = this.sky; scene.environment = this.sky;
    this.envPT = 1; this.envPreview = 0.3;
    this.skies = {};
  }

  _sky(preset) {
    if (!SKIES[preset]) return null;
    return (this.skies[preset] ||= new HdrSky(SKIES[preset], () => this.onReady()));
  }

  _clear(group) {
    for (const c of [...group.children]) { group.remove(c); c.dispose?.(); c.shadow?.map?.dispose(); }
  }

  update(S, stats, mats) {
    this._clear(this.shared); this._clear(this.preview);
    const { w, l, h } = S.room, W = w * IN, L = l * IN, H = h * IN;
    const preset = S.light.preset, wins = stats.windows;
    const centre = new THREE.Vector3(W / 2, H * 0.4, L / 2);
    const span = Math.max(W, L, H);
    const evening = preset === 'evening';
    const facing = S.light.facing || 'south', bulbK = S.light.bulbK || 2700;

    // Daylight from the sky photograph once it has loaded; colour-temperature stand-ins until then.
    const sky = evening ? null : this._sky(preset);
    const hdr = !!(sky && sky.ready && wins.length);
    let theta = 0, out = null, winLight = null, sunWorld = null;
    if (hdr) {
      out = wins[0].normal.clone().negate();            // looking out of the (first) window
      theta = Math.atan2(out.x, out.z) + SUN_OFFSET[facing] * Math.PI / 180 - Math.atan2(sky.sun.x, sky.sun.z);
      winLight = sky.irradiance(out, theta, false);
      sunWorld = rotY(sky.sun, theta);
    }
    const winK = evening ? 11000 : DAYLIGHT[preset][facing];
    const sunK = !hdr && preset === 'sunny' ? SUN[facing] : null;   // north windows never get direct sun
    const mainK = evening ? bulbK : sunK || winK;

    // White balance. Your eyes adapt to the light filling the room, which is the source colour tinted by
    // everything it bounces off. In a closed room each bounce multiplies by the average surface colour rho,
    // so the light builds up as 1 / (1 - k * rho) per channel (k < 1 for light lost through windows and
    // absorbed). 'eye' corrects most of the way for that; 'camera' leaves it uncorrected at 6500 K.
    const wb = new THREE.Color(1, 1, 1);
    if (S.light.wb !== 'camera') {
      const rho = new THREE.Color(0, 0, 0), add = (c, area) => rho.add(c.clone().multiplyScalar(area));
      const wallsA = 2 * (W + L) * H, flat = W * L;
      add(mats.wallU.color, wallsA * 0.8); add(mats.trim.color, wallsA * 0.2); add(mats.ceil.color, flat); add(mats.floorAvg || mats.floor.color, flat);
      rho.multiplyScalar(1 / (wallsA + 2 * flat));
      const k = 0.85, src = hdr ? unit(winLight) : kelvin(mainK);
      const amb = new THREE.Color(src.r / (1 - k * rho.r), src.g / (1 - k * rho.g), src.b / (1 - k * rho.b));
      const ref = kelvin(6500), a = 0.85, la = lum(amb);
      wb.setRGB((ref.r * la / amb.r) ** a, (ref.g * la / amb.g) ** a, (ref.b * la / amb.b) ** a);
      wb.setRGB(+wb.r.toFixed(3), +wb.g.toFixed(3), +wb.b.toFixed(3));   // fewer distinct tints to cache
    }
    this.wb = wb;
    const col = (K) => kelvin(K).multiply(wb);

    const shadowLight = (color, intensity, dir, from) => {
      const d = new THREE.DirectionalLight(color, intensity);
      d.position.copy(from).addScaledVector(dir, -span * 1.6);
      d.target.position.copy(from);
      d.castShadow = true;
      d.shadow.mapSize.set(2048, 2048); d.shadow.bias = -0.0004; d.shadow.normalBias = 0.012;
      Object.assign(d.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.1, far: span * 4 });
      d.shadow.camera.updateProjectionMatrix();
      return d;
    };
    this.sunny = false;

    this.adapt = 1;
    if (hdr) {
      // Sky portals: each window glows with exactly the light the photographed sky sends through it
      // (colour and brightness measured from the image, sun left out), and the sun is a separate light
      // with the colour and strength measured from its pixels. The path tracer can aim straight at these,
      // so it converges as fast as before while the light itself comes from the real sky. The sky image
      // is the view out of the window; it adds no light of its own, so nothing is counted twice.
      const scale = SKY_LEVEL[preset] / sky.level;
      const env = sky.tinted(wb);
      this.background = env;
      this.scene.environment = env;
      this.scene.environmentRotation.set(0, theta, 0);
      this.scene.backgroundRotation.set(0, theta, 0);
      this.envPT = 0;
      this.bgIntensity = scale;
      this.envPreview = 0.32 / sky.level;
      const inward = sunWorld.clone().negate();
      const sunE = sky.irradiance(sky.sun, 0, false).sub(sky.irradiance(sky.sun, 0, true)).multiply(wb).multiplyScalar(scale);
      const sunIn = preset === 'sunny' && sunWorld.y > 0 && sunWorld.dot(out) > 0.05 && lum(sunE) > 0;
      const glow = wins.map((win) => sky.irradiance(win.normal.clone().negate(), theta, true).multiply(wb).multiplyScalar(scale / Math.PI));
      // Exposure: when the sun streams in, eyes and cameras turn down. Hold the light entering the room to
      // about twice what the sky alone lets in, so a sunny room reads brighter without everything blowing out.
      const skyFlux = wins.reduce((t, win, i) => t + Math.PI * lum(glow[i]) * win.w * win.h, 0);
      const sunFlux = sunIn ? wins.reduce((t, win) => t + lum(sunE) * Math.max(0, inward.dot(win.normal)) * win.w * win.h, 0) : 0;
      const k = Math.min(1, 2 * skyFlux / (skyFlux + sunFlux));
      this.adapt = k;
      this.bgIntensity = scale * k;
      wins.forEach((win, i) => {
        const a = new THREE.RectAreaLight(unit(glow[i]), lum(glow[i]) * k, win.w, win.h);
        a.position.copy(win.center); a.lookAt(win.center.clone().add(win.normal));
        this.shared.add(a);
      });
      if (sunIn) {
        const sun = shadowLight(unit(sunE), lum(sunE) * k, inward, wins[0].center.clone().addScaledVector(inward, span * 0.4));
        this.shared.add(sun, sun.target);
        this.sunny = true;
        this.sunLux = lum(sunE);
      } else {
        const key = shadowLight(unit(winLight).multiply(wb), 1.1, wins[0].normal.clone().add(new THREE.Vector3(0, -0.45, 0)).normalize(), centre);
        key.castShadow = false;
        this.preview.add(key, key.target);
      }
    } else {
      this.background = this.sky;
      this.scene.environment = this.sky;
      this.scene.environmentRotation.set(0, 0, 0);
      this.scene.backgroundRotation.set(0, 0, 0);
      if (evening) { this.sky.topColor.set('#0b1230').multiply(wb); this.sky.bottomColor.set('#3a3350').multiply(wb); }
      else { this.sky.topColor.copy(maxOne(col(winK * 1.5))); this.sky.bottomColor.copy(maxOne(col(winK))); }
      this.sky.update();
      this.sky.needsPMREMUpdate = true;
      this.envPT = evening ? 0.2 : 1;   // kept low: the window area light carries the daylight and converges far faster
      this.envPreview = evening ? 0.08 : 0.32;
      this.bgIntensity = evening ? 1 : 5;   // the view out of the window blows out, as in a photo

      // Daylight through each window: a soft area source the size of the opening.
      for (const win of wins) {
        const a = new THREE.RectAreaLight(col(winK), evening ? 0.6 : preset === 'sunny' ? (sunK ? 12 : 20) : 24, win.w, win.h);
        a.position.copy(win.center);
        a.lookAt(win.center.clone().add(win.normal));
        this.shared.add(a);
      }
      if (wins.length && !evening) {
        const win = wins[0];
        // Direction the light travels: in through the window, angled across the room and down.
        const az = 28 * Math.PI / 180, el = (preset === 'sunny' ? 36 : 24) * Math.PI / 180;
        const dir = win.normal.clone().multiplyScalar(Math.cos(az)).addScaledVector(win.tangent, Math.sin(az))
          .multiplyScalar(Math.cos(el)).add(new THREE.Vector3(0, -Math.sin(el), 0)).normalize();
        if (sunK) {
          const sun = shadowLight(col(sunK), 9, dir, win.center.clone().addScaledVector(dir, span * 0.4));
          this.shared.add(sun, sun.target);
          this.sunny = true;
        } else {
          // preview only: a gentle key from the window side so mouldings show relief while you drag sliders
          const key = shadowLight(col(winK), 1.1, dir, centre);
          key.castShadow = false;   // trim on the window wall would throw false shadows across the room
          this.preview.add(key, key.target);
        }
      }
    }

    // Recessed ceiling lights for the evening scene, or when the room has no window at all.
    if (evening || wins.length === 0) {
      const c = stats.ceiling, cw = c.x1 - c.x0, cl = c.z1 - c.z0;
      const nx = Math.max(1, Math.round(cw / 1.7)), nz = Math.max(1, Math.round(cl / 1.7));
      const power = evening ? 300 : 200;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const can = new ShapedAreaLight(col(bulbK), power, 0.15, 0.15);
        can.isCircular = true;
        can.position.set(c.x0 + cw * (i + 0.5) / nx, c.y - 0.012, c.z0 + cl * (j + 0.5) / nz);
        can.lookAt(can.position.x, 0, can.position.z);
        this.shared.add(can);
      }
      if (!this.preview.children.length) {
        const key = shadowLight(col(evening ? bulbK : winK), 0.5, new THREE.Vector3(0.25, -1, -0.3).normalize(), centre);
        this.preview.add(key, key.target);
      }
    }

    // A soft ceiling light in each neighbouring space seen through an open doorway, so it reads as a room.
    for (const stub of stats.stubs) {
      const a = new THREE.RectAreaLight(col(evening ? bulbK : 5500), (evening ? 28 : 22) * (hdr ? this.adapt : 1), 0.5, 0.5);
      a.position.copy(stub.pos);
      a.lookAt(stub.pos.x, 0, stub.pos.z);
      this.shared.add(a);
    }

    const skyCol = hdr ? unit(winLight).multiply(wb) : col(evening ? bulbK : winK);
    const hemi = new THREE.HemisphereLight(skyCol, new THREE.Color(evening ? '#6b5a48' : '#cdbfae').multiply(wb), evening ? 0.35 : 0.75);
    this.preview.add(hemi);
    for (const g of [this.shared, this.preview]) g.traverse((o) => o.updateMatrixWorld(true));
    this.scene.environmentIntensity = this.envPT;
    this.scene.backgroundIntensity = this.bgIntensity;
  }

  // Draw the fast preview with the stand-in lights attached, then put the scene back as the path tracer expects it.
  renderPreview(renderer, scene, camera) {
    scene.add(this.preview);
    scene.environmentIntensity = this.envPreview;
    scene.backgroundIntensity = Math.min(this.bgIntensity, this.envPreview * 15);
    renderer.render(scene, camera);
    scene.remove(this.preview);
    scene.environmentIntensity = this.envPT;
    scene.backgroundIntensity = this.bgIntensity;
  }
}
