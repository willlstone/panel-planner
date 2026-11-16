import * as THREE from 'three';
import { MeshBVH, MeshBVHUniformStruct, FloatVertexAttributeTexture, BVHShaderGLSL } from 'three-mesh-bvh';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Light baking.
//
// The path tracer re-simulates every bounce of light for every pixel each time the camera moves. But on
// matte surfaces (paint, wood, plaster) the light arriving at a point doesn't depend on where you look from.
// So we path-trace that once: for every vertex of a finely divided copy of the room, how much light arrives
// (its irradiance), counting direct light from the windows, sun and bulbs plus several bounces between
// surfaces. Drawing a frame is then just colour x stored light, which is instant from any angle.
// What baking gives up: reflections and gloss (everything is drawn matte) and fine detail smaller than the
// vertex spacing (about 2"), such as the sharpest edges of sun patches.

const MAX_RECT = 16, MAX_DISK = 24, BOUNCES = 4;

const shader = /* glsl */`
precision highp isampler2D;
precision highp usampler2D;
${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_ray_functions}

#define PI 3.14159265359
#define EPS 0.0006
uniform BVH bvh;
uniform sampler2D normalAttr, albedoAttr, posTex, nrmTex, prevTex;
uniform int rectCount, diskCount, sunOn, spp, mode;   // mode 0: direct light only, 1: bounced light only
uniform vec3 rectC[${MAX_RECT}], rectU[${MAX_RECT}], rectV[${MAX_RECT}], rectN[${MAX_RECT}], rectL[${MAX_RECT}];
uniform vec3 diskC[${MAX_DISK}], diskN[${MAX_DISK}], diskL[${MAX_DISK}];
uniform float diskR[${MAX_DISK}];
uniform vec3 sunDir, sunE, skyL;
uniform uint frame;

uint seed;
float rnd() {
  seed = seed * 747796405u + 2891336453u;
  uint w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  return float((w >> 22u) ^ w) / 4294967295.0;
}
void basis(vec3 n, out vec3 t, out vec3 b) {
  t = normalize(abs(n.y) < 0.9 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  b = cross(n, t);
}
vec3 cosineDir(vec3 n) {
  float r1 = rnd(), r2 = rnd(), r = sqrt(r1), a = 2.0 * PI * r2;
  vec3 t, b; basis(n, t, b);
  return normalize(t * r * cos(a) + b * r * sin(a) + n * sqrt(max(0.0, 1.0 - r1)));
}
bool blocked(vec3 o, vec3 d, float maxD) {
  uvec4 fi; vec3 fn, bc; float side, dist;
  bool h = bvhIntersectFirstHit(bvh, o, d, fi, fn, bc, side, dist);
  return h && dist < maxD;
}
// Direct light arriving at p (surface normal n): one random point on each light, with a shadow ray.
vec3 direct(vec3 p, vec3 n) {
  vec3 E = vec3(0.0);
  for (int i = 0; i < ${MAX_RECT}; i++) {
    if (i >= rectCount) break;
    vec3 q = rectC[i] + (2.0 * rnd() - 1.0) * rectU[i] + (2.0 * rnd() - 1.0) * rectV[i];
    vec3 w = q - p; float d2 = dot(w, w), d = sqrt(d2); w /= d;
    float cp = dot(n, w), cl = dot(rectN[i], -w);
    if (cp <= 0.0 || cl <= 0.0) continue;
    if (blocked(p, w, d - EPS)) continue;
    E += rectL[i] * cp * cl * (4.0 * length(rectU[i]) * length(rectV[i])) / d2;
  }
  for (int i = 0; i < ${MAX_DISK}; i++) {
    if (i >= diskCount) break;
    vec3 t, b; basis(diskN[i], t, b);
    float r = diskR[i] * sqrt(rnd()), a = 2.0 * PI * rnd();
    vec3 q = diskC[i] + t * r * cos(a) + b * r * sin(a);
    vec3 w = q - p; float d2 = dot(w, w), d = sqrt(d2); w /= d;
    float cp = dot(n, w), cl = dot(diskN[i], -w);
    if (cp <= 0.0 || cl <= 0.0) continue;
    if (blocked(p, w, d - EPS)) continue;
    E += diskL[i] * cp * cl * (PI * diskR[i] * diskR[i]) / d2;
  }
  if (sunOn == 1) {
    vec3 w = -sunDir; float cp = dot(n, w);
    if (cp > 0.0 && !blocked(p, w, 1e4)) E += sunE * cp;
  }
  return E;
}

varying vec2 vUv;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 prev = texelFetch(prevTex, px, 0);
  vec4 pos = texelFetch(posTex, px, 0);
  if (pos.w == 0.0) { gl_FragColor = prev; return; }
  vec3 n0 = normalize(texelFetch(nrmTex, px, 0).xyz);
  seed = uint(px.x) * 1973u + uint(px.y) * 9277u + frame * 26699u + 1u;
  rnd(); rnd();
  vec3 acc = vec3(0.0); float back = 0.0;
  for (int s = 0; s < 64; s++) {
    if (s >= spp) break;
    // Irradiance estimate: direct light here, plus light reflected from what a cosine-weighted ray hits.
    // With a matte surface of colour rho at the hit point, each bounce contributes rho x (light arriving there).
    vec3 p = pos.xyz + n0 * EPS, N = n0;
    if (mode == 0) { acc += direct(p, N); continue; }
    vec3 E = vec3(0.0), T = vec3(1.0);
    for (int k = 0; k < ${BOUNCES}; k++) {
      vec3 d = cosineDir(N);
      uvec4 fi; vec3 fn, bc; float side, dist;
      if (!bvhIntersectFirstHit(bvh, p, d, fi, fn, bc, side, dist)) { E += T * PI * skyL; break; }
      if (side < 0.0 && k == 0) back += 1.0;   // the first ray hit the inside of something: this point is buried
      vec3 ns = normalize(textureSampleBarycoord(normalAttr, bc, fi.xyz).xyz);
      if (dot(ns, fn) < 0.0) ns = -ns;
      T *= textureSampleBarycoord(albedoAttr, bc, fi.xyz).rgb;
      p = p + d * dist + fn * EPS; N = ns;
      E += T * direct(p, N);
    }
    acc += E;
  }
  gl_FragColor = prev + vec4(acc, back);
}`;

export class Baker {
  constructor(renderer) {
    this.renderer = renderer;
    this.quad = new FullScreenQuad(null);
    this.samples = 0;
    this.active = false;
  }

  dispose() {
    this.active = false;
    this.targets?.flat().forEach((t) => t.dispose());
    this.mat?.dispose();
    for (const t of [this.posTex, this.nrmTex]) t?.dispose();
    this.bvhUniform?.dispose?.();
    this.targets = null;
  }

  // group: the finely divided room (world-space meshes in metres). lights: the real lights.
  // albedo(mesh) gives the colour light bounces off with; skyL is the radiance of open sky through a window.
  setup(group, lights, albedo, skyL) {
    this.dispose();
    const meshes = [];
    group.updateMatrixWorld(true);
    group.traverse((o) => { if (o.isMesh) meshes.push(o); });

    // Weld vertices that share a position and normal: one bake point each.
    const key = new Map(), pts = [], nrm = [];
    let vertTotal = 0;
    for (const m of meshes) {
      const P = m.geometry.attributes.position.array, N = m.geometry.attributes.normal.array, cnt = P.length / 3;
      const vmap = new Int32Array(cnt);
      for (let i = 0; i < cnt; i++) {
        const k = `${Math.round(P[i * 3] * 4000)},${Math.round(P[i * 3 + 1] * 4000)},${Math.round(P[i * 3 + 2] * 4000)},${Math.round(N[i * 3] * 20)},${Math.round(N[i * 3 + 1] * 20)},${Math.round(N[i * 3 + 2] * 20)}`;
        let id = key.get(k);
        if (id === undefined) { id = pts.length / 3; key.set(k, id); pts.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); nrm.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]); }
        vmap[i] = id;
      }
      m.userData.vmap = vmap;
      vertTotal += cnt;
    }
    const count = pts.length / 3;
    this.meshes = meshes; this.count = count;

    // Neighbours of each point (through shared triangles), for filling in buried points afterwards.
    const nb = Array.from({ length: count }, () => []);
    for (const m of meshes) {
      const v = m.userData.vmap;
      for (let i = 0; i < v.length; i += 3) {
        const a = v[i], b = v[i + 1], c = v[i + 2];
        nb[a].push(b, c); nb[b].push(a, c); nb[c].push(a, b);
      }
    }
    this.nb = nb;

    // One merged copy of the room for ray tracing, with each vertex's bounce colour.
    const pos = new Float32Array(vertTotal * 3), nor = new Float32Array(vertTotal * 3), alb = new Float32Array(vertTotal * 3);
    let o = 0;
    for (const m of meshes) {
      const P = m.geometry.attributes.position.array, N = m.geometry.attributes.normal.array, c = albedo(m);
      pos.set(P, o); nor.set(N, o);
      for (let i = 0; i < P.length; i += 3) { alb[o + i] = c.r; alb[o + i + 1] = c.g; alb[o + i + 2] = c.b; }
      o += P.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('albedo', new THREE.BufferAttribute(alb, 3));
    const idx = new Uint32Array(vertTotal); for (let i = 0; i < vertTotal; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const bvh = new MeshBVH(geo, { maxLeafTris: 4 });
    this.bvhUniform = new MeshBVHUniformStruct(); this.bvhUniform.updateFrom(bvh);
    const normalAttr = new FloatVertexAttributeTexture(); normalAttr.updateFrom(geo.attributes.normal);
    const albedoAttr = new FloatVertexAttributeTexture(); albedoAttr.updateFrom(geo.attributes.albedo);

    // Bake points as textures: one texel per point.
    const S = Math.ceil(Math.sqrt(count));
    this.size = S;
    const pt = new Float32Array(S * S * 4), nt = new Float32Array(S * S * 4);
    for (let i = 0; i < count; i++) {
      pt[i * 4] = pts[i * 3]; pt[i * 4 + 1] = pts[i * 3 + 1]; pt[i * 4 + 2] = pts[i * 3 + 2]; pt[i * 4 + 3] = 1;
      nt[i * 4] = nrm[i * 3]; nt[i * 4 + 1] = nrm[i * 3 + 1]; nt[i * 4 + 2] = nrm[i * 3 + 2];
    }
    const tex = (d) => Object.assign(new THREE.DataTexture(d, S, S, THREE.RGBAFormat, THREE.FloatType), { needsUpdate: true });
    this.posTex = tex(pt); this.nrmTex = tex(nt);
    const rt = () => new THREE.WebGLRenderTarget(S, S, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    // Two running sums, each ping-ponged: direct light (kept sharp) and bounced light (smoothed later).
    this.targets = [[rt(), rt()], [rt(), rt()]];
    for (const t of this.targets.flat()) { this.renderer.setRenderTarget(t); this.renderer.setClearColor(0x000000, 0); this.renderer.clear(); }
    this.renderer.setRenderTarget(null);

    // Lights, in world space. Area lights shine along their -z axis (three.js lights look at their target).
    const U = { rectCount: 0, diskCount: 0, sunOn: 0 };
    const rect = { C: [], U: [], V: [], N: [], L: [] }, disk = { C: [], N: [], L: [], R: [] };
    let sunDir = new THREE.Vector3(0, -1, 0), sunE = new THREE.Color(0, 0, 0);
    lights.updateMatrixWorld(true);
    lights.traverse((l) => {
      if (l.isRectAreaLight) {
        const e = l.matrixWorld.elements, c = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld);
        const x = new THREE.Vector3(e[0], e[1], e[2]).normalize(), y = new THREE.Vector3(e[4], e[5], e[6]).normalize();
        const n = new THREE.Vector3(e[8], e[9], e[10]).normalize().negate();
        const L = new THREE.Vector3(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity);
        if (l.isCircular) { if (disk.C.length < MAX_DISK) { disk.C.push(c); disk.N.push(n); disk.L.push(L); disk.R.push(l.width / 2); } }
        else if (rect.C.length < MAX_RECT) { rect.C.push(c); rect.U.push(x.multiplyScalar(l.width / 2)); rect.V.push(y.multiplyScalar(l.height / 2)); rect.N.push(n); rect.L.push(L); }
      } else if (l.isDirectionalLight) {
        const p = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld), t = new THREE.Vector3().setFromMatrixPosition(l.target.matrixWorld);
        sunDir = t.sub(p).normalize(); sunE = l.color.clone().multiplyScalar(l.intensity); U.sunOn = 1;
      }
    });
    const pad = (a, n, v) => { const out = a.slice(); while (out.length < n) out.push(v.clone ? v.clone() : v); return out; };
    const z = new THREE.Vector3();
    this.mat = new THREE.ShaderMaterial({
      defines: { TRI_INTERSECT_EPSILON: 1e-6 },
      uniforms: {
        bvh: { value: this.bvhUniform }, normalAttr: { value: normalAttr }, albedoAttr: { value: albedoAttr },
        posTex: { value: this.posTex }, nrmTex: { value: this.nrmTex }, prevTex: { value: null },
        mode: { value: 0 }, rectCount: { value: rect.C.length }, diskCount: { value: disk.C.length }, sunOn: { value: U.sunOn }, spp: { value: 2 },
        rectC: { value: pad(rect.C, MAX_RECT, z) }, rectU: { value: pad(rect.U, MAX_RECT, z) }, rectV: { value: pad(rect.V, MAX_RECT, z) },
        rectN: { value: pad(rect.N, MAX_RECT, z) }, rectL: { value: pad(rect.L, MAX_RECT, z) },
        diskC: { value: pad(disk.C, MAX_DISK, z) }, diskN: { value: pad(disk.N, MAX_DISK, z) }, diskL: { value: pad(disk.L, MAX_DISK, z) },
        diskR: { value: pad(disk.R, MAX_DISK, 0) },
        sunDir: { value: sunDir }, sunE: { value: new THREE.Vector3(sunE.r, sunE.g, sunE.b) },
        skyL: { value: new THREE.Vector3(skyL.r, skyL.g, skyL.b) }, frame: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: shader,
    });
    this.quad.material = this.mat;
    this._extra = [normalAttr, albedoAttr];
    this.samples = 0; this.frame = 0; this.cur = 0;
    this.nrm = new Float32Array(nrm);
    this.active = true;
    this.values = new Float32Array(count * 3);
    for (const m of meshes) m.geometry.setAttribute('bakeE', new THREE.BufferAttribute(new Float32Array(m.geometry.attributes.position.count * 3), 3));
  }

  // Add `spp` samples per point.
  step(spp) {
    if (!this.active) return;
    const r = this.renderer, prev = r.getRenderTarget(), auto = r.autoClear, u = this.mat.uniforms;
    r.autoClear = false;
    u.spp.value = spp;
    for (let mode = 0; mode < 2; mode++) {
      const pair = this.targets[mode];
      u.mode.value = mode;
      u.prevTex.value = pair[this.cur].texture;
      u.frame.value = ++this.frame;
      r.setRenderTarget(pair[1 - this.cur]);
      this.quad.render(r);
    }
    r.setRenderTarget(prev);
    r.autoClear = auto;
    this.cur = 1 - this.cur;
    this.samples += spp;
  }

  // Average each point with its neighbours on the same surface (normals within ~18 degrees), `iters` times.
  _smooth(E, iters) {
    const n = this.count, N = this.nrm, nb = this.nb, out = new Float32Array(E.length);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        let r = E[i * 3] * 2, g = E[i * 3 + 1] * 2, b = E[i * 3 + 2] * 2, w = 2;
        for (const j of nb[i]) {
          if (N[i * 3] * N[j * 3] + N[i * 3 + 1] * N[j * 3 + 1] + N[i * 3 + 2] * N[j * 3 + 2] < 0.95) continue;
          r += E[j * 3]; g += E[j * 3 + 1]; b += E[j * 3 + 2]; w++;
        }
        out[i * 3] = r / w; out[i * 3 + 1] = g / w; out[i * 3 + 2] = b / w;
      }
      E.set(out);
    }
  }

  // Read the sums back, average them, fill in buried points from their neighbours, and store the light
  // on every vertex of the display meshes.
  apply() {
    if (!this.active || !this.samples) return;
    const S = this.size, n = this.count, dir = new Float32Array(S * S * 4), ind = new Float32Array(S * S * 4);
    this.renderer.readRenderTargetPixels(this.targets[0][this.cur], 0, 0, S, S, dir);
    this.renderer.readRenderTargetPixels(this.targets[1][this.cur], 0, 0, S, S, ind);
    const E = this.values, B = new Float32Array(n * 3), ok = new Uint8Array(n), k = 1 / this.samples;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) { E[i * 3 + c] = dir[i * 4 + c] * k; B[i * 3 + c] = ind[i * 4 + c] * k; }
      ok[i] = ind[i * 4 + 3] * k < 0.25 ? 1 : 0;   // mostly hitting the inside of something: buried under trim
    }
    // Points buried under trim take their neighbours' light, then noise is smoothed. Bounced light changes
    // slowly across a surface, so it is smoothed a lot; direct light only lightly, to keep shadow edges.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const next = ok.slice();
      for (let i = 0; i < n; i++) {
        if (ok[i]) continue;
        let c = 0;
        const sum = [0, 0, 0, 0, 0, 0];
        for (const j of this.nb[i]) if (ok[j]) { for (let q = 0; q < 3; q++) { sum[q] += E[j * 3 + q]; sum[q + 3] += B[j * 3 + q]; } c++; }
        if (c) { for (let q = 0; q < 3; q++) { E[i * 3 + q] = sum[q] / c; B[i * 3 + q] = sum[q + 3] / c; } next[i] = 1; changed = true; }
      }
      ok.set(next);
      if (!changed) break;
    }
    this._smooth(B, this.samples < 64 ? 6 : this.samples < 256 ? 4 : 3);
    this._smooth(E, 1);
    for (let i = 0; i < n * 3; i++) E[i] += B[i];
    for (const m of this.meshes) {
      const a = m.geometry.attributes.bakeE, v = m.userData.vmap, arr = a.array;
      for (let i = 0; i < v.length; i++) { const j = v[i] * 3; arr[i * 3] = E[j]; arr[i * 3 + 1] = E[j + 1]; arr[i * 3 + 2] = E[j + 2]; }
      a.needsUpdate = true;
    }
  }
}

// A copy of a material that takes its light only from the baked values on its vertices.
export function bakedMaterial(src) {
  const m = src.clone();
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec3 bakeE;\nvarying vec3 vBakeE;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBakeE = bakeE;');
    sh.fragmentShader = 'varying vec3 vBakeE;\n' + sh.fragmentShader.replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\nirradiance += vBakeE;');
  };
  m.customProgramCacheKey = () => 'baked';
  return m;
}
