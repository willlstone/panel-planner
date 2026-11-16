import * as THREE from 'three';

const SMOOTH_COS = Math.cos(38 * Math.PI / 180);

// Accumulates triangles (in inches) and turns them into one BufferGeometry (in metres).
// Points are given in the current matrix's local space, so walls can be built flat and placed afterwards.
export class Geo {
  // `fine` (inches) splits large faces into a grid and long mouldings into short segments. The light
  // baker stores light at vertices, so it needs vertices everywhere light changes; normal drawing leaves it 0.
  constructor(fine = 0) { this.pos = []; this.nor = []; this.uv = []; this.m = null; this.fine = fine; }

  setMatrix(m) { this.m = m ? m.elements : null; }
  get empty() { return this.pos.length === 0; }

  _push(p, n, uv) {
    let x = p[0], y = p[1], z = p[2], nx = n[0], ny = n[1], nz = n[2];
    const e = this.m;
    if (e) {
      const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14];
      const NX = e[0] * nx + e[4] * ny + e[8] * nz, NY = e[1] * nx + e[5] * ny + e[9] * nz, NZ = e[2] * nx + e[6] * ny + e[10] * nz;
      x = X; y = Y; z = Z; nx = NX; ny = NY; nz = NZ;
    }
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(uv ? uv[0] : 0, uv ? uv[1] : 0);
  }

  // Winding is fixed up from the supplied normals, so callers never have to think about it.
  tri(a, b, c, na, nb, nc, ua, ub, uc) {
    const f = this.fine;
    const L = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const n = f ? Math.ceil(Math.max(L(a, b), L(b, c), L(c, a)) / f) : 1;
    if (n <= 1) return this._tri(a, b, c, na, nb, nc, ua, ub, uc);
    // split into n x n smaller triangles on a barycentric grid
    const mix = (wa, wb, wc, A, B, C) => (A ? A.map((_, k) => wa * A[k] + wb * B[k] + wc * C[k]) : undefined);
    const P = (i, j) => { const wb = i / n, wc = j / n, wa = 1 - wb - wc; return [mix(wa, wb, wc, a, b, c), mix(wa, wb, wc, na, nb, nc), ua && ub && uc ? mix(wa, wb, wc, ua, ub, uc) : undefined]; };
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      const p0 = P(i, j), p1 = P(i + 1, j), p2 = P(i, j + 1);
      this._tri(p0[0], p1[0], p2[0], p0[1], p1[1], p2[1], p0[2], p1[2], p2[2]);
      if (i + j < n - 1) { const p3 = P(i + 1, j + 1); this._tri(p1[0], p3[0], p2[0], p1[1], p3[1], p2[1], p1[2], p3[2], p2[2]); }
    }
  }

  _tri(a, b, c, na, nb, nc, ua, ub, uc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) return;
    const d = cx * (na[0] + nb[0] + nc[0]) + cy * (na[1] + nb[1] + nc[1]) + cz * (na[2] + nb[2] + nc[2]);
    if (d < 0) { this._push(a, na, ua); this._push(c, nc, uc); this._push(b, nb, ub); }
    else { this._push(a, na, ua); this._push(b, nb, ub); this._push(c, nc, uc); }
  }

  quad(a, b, c, d, na, nb = na, nc = na, nd = na, uvs) {
    const u = uvs || [];
    const f = this.fine, L = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const nu = f ? Math.ceil(Math.max(L(a, b), L(d, c)) / f) : 1, nv = f ? Math.ceil(Math.max(L(a, d), L(b, c)) / f) : 1;
    if (nu <= 1 && nv <= 1) {
      this._tri(a, b, c, na, nb, nc, u[0], u[1], u[2]);
      this._tri(a, c, d, na, nc, nd, u[0], u[2], u[3]);
      return;
    }
    // bilinear grid, so neighbouring faces cut on the same lines share their vertices
    const bl = (A, B, C, D, s, t) => (A ? A.map((_, k) => (1 - s) * (1 - t) * A[k] + s * (1 - t) * B[k] + s * t * C[k] + (1 - s) * t * D[k]) : undefined);
    const P = (i, j) => { const s = i / nu, t = j / nv; return [bl(a, b, c, d, s, t), bl(na, nb, nc, nd, s, t), u[0] ? bl(u[0], u[1], u[2], u[3], s, t) : undefined]; };
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const p = P(i, j), q = P(i + 1, j), r = P(i + 1, j + 1), w = P(i, j + 1);
      this._tri(p[0], q[0], r[0], p[1], q[1], r[1], p[2], q[2], r[2]);
      this._tri(p[0], r[0], w[0], p[1], r[1], w[1], p[2], r[2], w[2]);
    }
  }

  // Flat rectangle on the wall plane at depth z, facing into the room. uvScale = inches per texture tile.
  rect(x0, y0, x1, y1, z = 0, uvScale = 24) {
    const n = [0, 0, 1], s = 1 / uvScale;
    this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], n, n, n, n,
      [[x0 * s, y0 * s], [x1 * s, y0 * s], [x1 * s, y1 * s], [x0 * s, y1 * s]]);
  }

  // Axis-aligned box; `skip` lists faces to leave out ('x0','x1','y0','y1','z0','z1').
  box(x0, y0, z0, x1, y1, z1, skip = '') {
    const P = (x, y, z) => [x, y, z];
    if (!skip.includes('z1')) this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [0, 0, 1]);
    if (!skip.includes('z0')) this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), [0, 0, -1]);
    if (!skip.includes('x0')) this.quad(P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1), [-1, 0, 0]);
    if (!skip.includes('x1')) this.quad(P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), [1, 0, 0]);
    if (!skip.includes('y0')) this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [0, -1, 0]);
    if (!skip.includes('y1')) this.quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), [0, 1, 0]);
  }

  // Sweep a profile from A to B on the wall plane. The moulding lies to the LEFT of the direction of travel.
  // mitreA / mitreB = 1 cuts that end at 45 degrees (for picture-frame corners); capA / capB closes a square end.
  strip(profile, ax, ay, bx, by, { mitreA = 0, mitreB = 0, capA = false, capB = false, z0 = 0 } = {}) {
    let dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    dx /= len; dy /= len;
    const ix = -dy, iy = dx;
    const n = profile.length;
    const A = [], B = [];
    for (let i = 0; i < n; i++) {
      const t = profile[i][0], z = profile[i][1] + z0;
      A.push([ax + ix * t + dx * t * mitreA, ay + iy * t + dy * t * mitreA, z]);
      B.push([bx + ix * t - dx * t * mitreB, by + iy * t - dy * t * mitreB, z]);
    }
    // Per-segment normals in the (inward, z) plane.
    const sn = [];
    for (let i = 0; i < n - 1; i++) {
      const dt = profile[i + 1][0] - profile[i][0], dz = profile[i + 1][1] - profile[i][1];
      const l = Math.hypot(dt, dz);
      sn.push(l < 1e-9 ? null : [-dz / l, dt / l]);
    }
    const to3 = (a) => [ix * a[0], iy * a[0], a[1]];
    const blend = (a, b) => {
      if (!a || !b || a[0] * b[0] + a[1] * b[1] < SMOOTH_COS) return a;
      const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y);
      return [x / l, y / l];
    };
    // In fine mode, cut the run into short segments along its length.
    const segs = this.fine ? Math.max(1, Math.ceil(len / (this.fine * 1.5))) : 1;
    const at = (k, i) => (k === 0 ? A[i] : k === segs ? B[i] : A[i].map((v, c) => v + (B[i][c] - v) * k / segs));
    for (let i = 0; i < n - 1; i++) {
      const s = sn[i];
      if (!s) continue;
      const ns = to3(blend(s, i > 0 ? sn[i - 1] : null)), ne = to3(blend(s, i < n - 2 ? sn[i + 1] : null));
      // Keep the true face normal for the winding test; smooth normals only shade.
      const f = to3(s);
      for (let k = 0; k < segs; k++) this._quadFacing(at(k, i), at(k + 1, i), at(k + 1, i + 1), at(k, i + 1), f, ns, ns, ne, ne);
    }
    if (capA || capB) {
      const contour = profile.map((p) => new THREE.Vector2(p[0], p[1]));
      const faces = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const [i, j, k] of faces) {
        if (capA) { const nn = [-dx, -dy, 0]; this._tri(A[i], A[j], A[k], nn, nn, nn); }
        if (capB) { const nn = [dx, dy, 0]; this._tri(B[i], B[j], B[k], nn, nn, nn); }
      }
    }
  }

  _quadFacing(a, b, c, d, face, na, nb, nc, nd) {
    for (const [p, q, r, np, nq, nr] of [[a, b, c, na, nb, nc], [a, c, d, na, nc, nd]]) {
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz < 1e-12) continue;
      if (cx * face[0] + cy * face[1] + cz * face[2] < 0) { this._push(p, np); this._push(r, nr); this._push(q, nq); }
      else { this._push(p, np); this._push(q, nq); this._push(r, nr); }
    }
  }

  // Mitred rectangular frame. (x0,y0)-(x1,y1) is the OUTSIDE of the frame; sides can be left out (door casing).
  frame(x0, y0, x1, y1, profile, { bottom = true, right = true, top = true, left = true, z0 = 0 } = {}) {
    const on = [bottom, right, top, left];
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (let s = 0; s < 4; s++) {
      if (!on[s]) continue;
      const a = pts[s], b = pts[(s + 1) % 4];
      const prev = on[(s + 3) % 4], next = on[(s + 1) % 4];
      this.strip(profile, a[0], a[1], b[0], b[1], { mitreA: prev ? 1 : 0, mitreB: next ? 1 : 0, capA: !prev, capB: !next, z0 });
    }
  }

  build(scale = 0.0254) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(this.pos.length);
    for (let i = 0; i < p.length; i++) p[i] = this.pos[i] * scale;
    const count = p.length / 3;
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
