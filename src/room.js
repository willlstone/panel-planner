import * as THREE from 'three';
import { Geo } from './geo.js';
import { PANEL, RAIL, BASE, CROWN, casing } from './profiles.js';

export const IN = 0.0254;
const CASING_W = 3.5, CASING_D = 0.9;
const WALL_T = 5;            // wall thickness seen in window reveals and doorways
const STOOL = 1, APRON = 3;  // window stool thickness and apron height
const STUB_DEPTH = 84, STUB_SIDE = 30;   // the bit of neighbouring room seen through an open doorway
const WALL_UV = 78.7;        // inches covered by one tile of the wall surface texture
export const WALL_NAMES = ['A', 'B', 'C', 'D'];

// Split a run into box widths. Returns [] when nothing sensible fits.
export function layoutBoxes(width, sp, cfg, count, minW) {
  let n = count > 0 ? count : Math.max(1, Math.round((width - sp) / (cfg.targetW + sp)));
  const symmetric = cfg.rhythm !== 'equal';
  if (symmetric && n % 2 === 0) n += 1;
  for (; n >= 1; n -= symmetric ? 2 : 1) {
    const weights = [];
    for (let i = 0; i < n; i++) {
      let wt = 1;
      if (cfg.rhythm === 'center' && n >= 3 && i === (n - 1) / 2) wt = cfg.ratio;
      if (cfg.rhythm === 'alt' && i % 2 === 1) wt = cfg.ratio;
      weights.push(wt);
    }
    const avail = width - (n + 1) * sp, sum = weights.reduce((a, b) => a + b, 0);
    const ws = weights.map((wt) => avail * wt / sum);
    if (avail > 0 && Math.min(...ws) >= minW) return ws;
  }
  return [];
}

// Rectangles of a wall zone left free once door / window casings are taken out.
function freeRects(len, y0, y1, blocks, minH) {
  const out = [];
  let x = 0;
  for (const b of [...blocks].sort((p, q) => p.x0 - q.x0)) {
    if (b.y1 <= y0 || b.y0 >= y1) continue;
    if (b.x0 - x > 1) out.push({ x0: x, x1: b.x0, y0, y1 });
    if (b.y0 - y0 >= minH) out.push({ x0: b.x0, x1: b.x1, y0, y1: b.y0, under: true });
    if (y1 - b.y1 >= minH) out.push({ x0: b.x0, x1: b.x1, y0: b.y1, y1, over: true });
    x = Math.max(x, b.x1);
  }
  if (len - x > 1) out.push({ x0: x, x1: len, y0, y1 });
  return out;
}

// Stretches of [0, len] not interrupted by an opening that crosses height band [ya, yb].
function runSpans(len, ya, yb, blocks) {
  const out = [];
  let x = 0;
  for (const b of [...blocks].sort((p, q) => p.x0 - q.x0)) {
    if (b.y1 <= ya || b.y0 >= yb) continue;
    if (b.x0 > x) out.push([x, b.x0, x > 0, true]);
    x = Math.max(x, b.x1);
  }
  if (len > x) out.push([x, len, x > 0, false]);
  return out;   // [x0, x1, capStart, capEnd]
}

// A flat wall surface at depth z with rectangular holes cut out. Holes may have 45-degree clipped
// top corners (`clip`), which are filled back in as triangles. `pick(y)` chooses the Geo by height.
function surface(pick, X0, X1, Y0, Y1, holes, z, extraY = []) {
  const xs = [...new Set([X0, X1, ...holes.flatMap((o) => [o.x0, o.x1])])].filter((v) => v >= X0 && v <= X1).sort((a, b) => a - b);
  const ys = [...new Set([Y0, Y1, ...extraY, ...holes.flatMap((o) => [o.y0, o.y1])])].filter((v) => v >= Y0 && v <= Y1).sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (holes.some((o) => cx > o.x0 && cx < o.x1 && cy > o.y0 && cy < o.y1)) continue;
    pick(cy).rect(xs[i], ys[j], xs[i + 1], ys[j + 1], z, WALL_UV);
  }
  const n = [0, 0, 1], s = 1 / WALL_UV, uv = (p) => [p[0] * s, p[1] * s];
  for (const o of holes) {
    if (!o.clip) continue;
    const c = o.clip, G = pick(o.y1 - c / 2);
    const a = [[o.x0, o.y1, z], [o.x0 + c, o.y1, z], [o.x0, o.y1 - c, z]];
    const b = [[o.x1, o.y1, z], [o.x1 - c, o.y1, z], [o.x1, o.y1 - c, z]];
    for (const t of [a, b]) G.tri(t[0], t[1], t[2], n, n, n, uv(t[0]), uv(t[1]), uv(t[2]));
  }
}

// Where each wall sits: origin at its left corner (seen from inside), `t` along it, `n` into the room. Inches.
export function wallFrames(S) {
  const { w: W, l: L, h: H } = S.room;
  const up = new THREE.Vector3(0, 1, 0);
  return [
    { len: W, o: [0, 0, 0], n: [0, 0, 1] }, { len: L, o: [W, 0, 0], n: [-1, 0, 0] },
    { len: W, o: [W, 0, L], n: [0, 0, -1] }, { len: L, o: [0, 0, L], n: [1, 0, 0] },
  ].map((d) => {
    const n = new THREE.Vector3(...d.n), t = new THREE.Vector3().crossVectors(up, n), o = new THREE.Vector3(...d.o);
    return { len: d.len, h: H, o, n, t, m: new THREE.Matrix4().makeBasis(t, up, n).setPosition(o) };
  });
}

export function buildRoom(S, mats) {
  const { w: W, l: L, h: H } = S.room;
  const g = { floor: new Geo(), ceil: new Geo() };   // shared; everything else is built per wall
  const group = new THREE.Group();
  const matOf = {
    wallU: mats.wallU, wallL: mats.wallL, trim: mats.trim, floor: mats.floor, ceil: mats.ceil, metal: mats.metal, sash: mats.trim,
    stubWall: mats.wallU, stubFloor: mats.floor, stubCeil: mats.ceil,
  };
  const addMeshes = (parent, geos) => {
    for (const k in geos) {
      if (geos[k].empty) continue;
      const mesh = new THREE.Mesh(geos[k].build(IN), matOf[k]);
      mesh.name = k;
      mesh.receiveShadow = true;
      mesh.castShadow = k === 'trim' || k === 'metal';
      parent.add(mesh);
    }
  };
  const stats = { len: { panel: 0, rail: 0, base: 0, crown: 0, casing: 0, stile: 0 }, walls: [], windows: [], stubs: [] };
  const sp = S.mould.spacing, mw = S.mould.w, md = S.mould.d;
  const minBox = 2 * mw + 3;

  const panelProf = PANEL[S.mould.profile](mw, md);
  const innerProf = PANEL[S.mould.profile](mw * 0.6, md * 0.7);
  const railProf = RAIL[S.split.railStyle](S.split.railH, S.split.railD);
  const baseProf = BASE[S.base.style](S.base.h, S.base.d);
  const crownProf = CROWN[S.crown.style](S.crown.h, S.crown.p);
  const casingProf = casing(CASING_W, CASING_D);
  const apronProf = PANEL.flat(APRON, 0.6);

  const baseTop = S.base.on ? S.base.h : 0;
  const splitY = Math.min(S.split.height, H - 24);
  const railBot = splitY - S.split.railH;
  const zoneLo = { y0: baseTop, y1: S.split.rail ? railBot : splitY + sp / 2 };
  const zoneHi = { y0: S.split.rail ? splitY : splitY - sp / 2, y1: S.crown.on ? H - S.crown.h : H };
  const solidLower = S.lower.mode === 'shaker' || S.lower.mode === 'bead';

  const tu = mats.floorTile[0], tv = mats.floorTile[1];
  const floorUV = (x, z) => (S.floorRotate ? [z / tu, x / tv] : [x / tu, z / tv]);

  const defs = [
    { len: W, o: [0, 0, 0], n: [0, 0, 1] },
    { len: L, o: [W, 0, 0], n: [-1, 0, 0] },
    { len: W, o: [W, 0, L], n: [0, 0, -1] },
    { len: L, o: [0, 0, L], n: [1, 0, 0] },
  ];

  defs.forEach((def, wi) => {
    const cfg = S.walls[wi], len = def.len;
    const n = new THREE.Vector3(...def.n), up = new THREE.Vector3(0, 1, 0), t = new THREE.Vector3().crossVectors(up, n);
    const m = new THREE.Matrix4().makeBasis(t, up, n).setPosition(...def.o);
    // Each wall gets its own meshes so the layout view can hide the walls nearest the camera.
    const G = { wallU: new Geo(), wallL: new Geo(), trim: new Geo(), metal: new Geo(), sash: new Geo(), stubWall: new Geo(), stubFloor: new Geo(), stubCeil: new Geo() };
    for (const k in G) G[k].setMatrix(m);
    const lowerGeo = solidLower ? G.trim : G.wallL;
    const pickWall = (y) => (y < splitY ? lowerGeo : G.wallU);
    const world = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m);
    const wstat = { upper: [], lower: [], ops: [] };
    stats.walls.push(wstat);
    const T = G.trim;

    // ----- openings -----
    const blocks = [], holes = [];
    for (const op of cfg.openings || []) {
      const isWin = op.type === 'window', isDoor = op.type === 'door', isOpen = op.type === 'opening';
      const cased = !isOpen || op.cased;
      const ow = Math.max(12, Math.min(op.w, len - 8));
      const x0 = Math.max(isOpen && !cased ? 2 : CASING_W + 2, Math.min(len - ow - (cased ? CASING_W + 2 : 2), op.x));
      const y0 = isWin ? op.sill : 0;
      const top = H - 2 - (S.crown.on ? S.crown.h : 0) - (cased ? CASING_W : 0);
      const y1 = Math.max(y0 + 12, Math.min(y0 + op.h, top));
      const o = { x0, x1: x0 + ow, y0, y1, clip: isOpen ? Math.max(0, Math.min(op.clip || 0, ow / 2 - 2, (y1 - y0) / 2)) : 0 };
      const oh = y1 - y0, cx = (o.x0 + o.x1) / 2;
      holes.push(o);
      wstat.ops.push(o);

      if (isWin) {
        blocks.push({ x0: o.x0 - CASING_W - 0.75, x1: o.x1 + CASING_W + 0.75, y0: o.y0 - STOOL - APRON, y1: o.y1 + CASING_W });
        // casing on three sides standing on a stool, with an apron under it
        T.frame(o.x0 - CASING_W, o.y0, o.x1 + CASING_W, o.y1 + CASING_W, casingProf, { bottom: false });
        T.box(o.x0 - CASING_W - 0.75, o.y0 - STOOL, 0, o.x1 + CASING_W + 0.75, o.y0, 1.7, 'z0');
        T.strip(apronProf, o.x0 - CASING_W, o.y0 - STOOL - APRON, o.x1 + CASING_W, o.y0 - STOOL - APRON, { capA: true, capB: true });
        stats.len.casing += 2 * (oh + CASING_W) + 2 * (ow + 2 * CASING_W);
        // reveal through the wall, then a double-hung sash with muntin grids
        const z1 = -WALL_T, R = G.sash;
        R.quad([o.x0, o.y0, 0], [o.x0, o.y1, 0], [o.x0, o.y1, z1], [o.x0, o.y0, z1], [1, 0, 0]);
        R.quad([o.x1, o.y0, 0], [o.x1, o.y1, 0], [o.x1, o.y1, z1], [o.x1, o.y0, z1], [-1, 0, 0]);
        R.quad([o.x0, o.y1, 0], [o.x1, o.y1, 0], [o.x1, o.y1, z1], [o.x0, o.y1, z1], [0, -1, 0]);
        R.quad([o.x0, o.y0, 0], [o.x1, o.y0, 0], [o.x1, o.y0, z1], [o.x0, o.y0, z1], [0, 1, 0]);
        const sz0 = -4, sz1 = -2.6, sw = 2, cy = (o.y0 + o.y1) / 2;
        R.box(o.x0, o.y0, sz0, o.x0 + sw, o.y1, sz1, 'x0');
        R.box(o.x1 - sw, o.y0, sz0, o.x1, o.y1, sz1, 'x1');
        R.box(o.x0 + sw, o.y0, sz0, o.x1 - sw, o.y0 + sw + 0.75, sz1, 'y0x0x1');
        R.box(o.x0 + sw, o.y1 - sw, sz0, o.x1 - sw, o.y1, sz1, 'y1x0x1');
        R.box(o.x0 + sw, cy - 0.9, sz0, o.x1 - sw, cy + 0.9, sz1, 'x0x1');
        const cols = Math.max(1, Math.round(op.cols || 1)), rows = Math.max(1, Math.round(op.rows || 1)), mb = 0.35;
        for (const [ya, yb] of [[o.y0 + sw + 0.75, cy - 0.9], [cy + 0.9, o.y1 - sw]]) {
          for (let i = 1; i < cols; i++) {
            const x = o.x0 + sw + (ow - 2 * sw) * i / cols;
            R.box(x - mb, ya, sz0 + 0.3, x + mb, yb, sz1 - 0.3, 'y0y1');
          }
          for (let j = 1; j < rows; j++) {
            const y = ya + (yb - ya) * j / rows;
            R.box(o.x0 + sw, y - mb, sz0 + 0.3, o.x1 - sw, y + mb, sz1 - 0.3, 'x0x1');
          }
        }
        // Daylight enters here: hand the opening to the lighting rig in world space (metres).
        stats.windows.push({ center: world(cx, cy, z1 - 1).multiplyScalar(IN), normal: n.clone(), tangent: t.clone(), w: ow * IN, h: oh * IN });
        continue;
      }

      blocks.push(cased ? { x0: o.x0 - CASING_W, x1: o.x1 + CASING_W, y0: 0, y1: o.y1 + CASING_W } : { x0: o.x0, x1: o.x1, y0: 0, y1: o.y1 });
      if (cased) {
        T.frame(o.x0 - CASING_W, 0, o.x1 + CASING_W, o.y1 + CASING_W, casingProf, { bottom: false });
        stats.len.casing += 2 * (oh + CASING_W) + ow + 2 * CASING_W;
      }

      if (isDoor) {
        // jamb, slab set back in the opening, two applied panels, a knob
        const zs = -1.5;
        T.quad([o.x0, 0, 0], [o.x0, o.y1, 0], [o.x0, o.y1, zs], [o.x0, 0, zs], [1, 0, 0]);
        T.quad([o.x1, 0, 0], [o.x1, o.y1, 0], [o.x1, o.y1, zs], [o.x1, 0, zs], [-1, 0, 0]);
        T.quad([o.x0, o.y1, 0], [o.x1, o.y1, 0], [o.x1, o.y1, zs], [o.x0, o.y1, zs], [0, -1, 0]);
        T.rect(o.x0, 0, o.x1, o.y1, zs);
        const dp = PANEL.stepped(1.1, 0.35), mx = 5, my = 6, mid = o.y1 * 0.42;
        if (ow > 20 && oh > 40) {
          T.frame(o.x0 + mx, my + 2, o.x1 - mx, mid - 2.5, dp, { z0: zs });
          T.frame(o.x0 + mx, mid + 2.5, o.x1 - mx, o.y1 - my, dp, { z0: zs });
        }
        const K = G.metal, kx = o.x1 - 2.75, ky = 36;
        K.box(kx - 0.35, ky - 0.35, zs, kx + 0.35, ky + 0.35, zs + 1.6, 'z0');
        K.box(kx - 1.1, ky - 1.1, zs + 1.6, kx + 1.1, ky + 1.1, zs + 2.5, '');
        K.box(kx - 1.3, ky - 1.3, zs, kx + 1.3, ky + 1.3, zs + 0.2, 'z0');
        continue;
      }

      // Open doorway: drywall-wrapped jamb following the (optionally angled) head, then a stub of the
      // room beyond so the opening looks into a real space and no stray light leaks in.
      const c = o.clip, z1 = -WALL_T, ccy = o.y1 / 2;
      const path = [[o.x0, 0], [o.x0, o.y1 - c], [o.x0 + c, o.y1], [o.x1 - c, o.y1], [o.x1, o.y1 - c], [o.x1, 0]];
      const jamb = (G, p, q) => {
        let nx = -(q[1] - p[1]), ny = q[0] - p[0];
        const l = Math.hypot(nx, ny);
        if (l < 1e-6) return;
        nx /= l; ny /= l;
        if (nx * (cx - p[0]) + ny * (ccy - p[1]) < 0) { nx = -nx; ny = -ny; }
        G.quad([p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], z1], [p[0], p[1], z1], [nx, ny, 0]);
      };
      for (let i = 0; i < path.length - 1; i++) {
        const p = path[i], q = path[i + 1];
        const vertical = p[0] === q[0], lo = Math.min(p[1], q[1]), hi = Math.max(p[1], q[1]);
        if (vertical && lo < splitY && hi > splitY) { jamb(lowerGeo, [p[0], lo], [p[0], splitY]); jamb(G.wallU, [p[0], splitY], [p[0], hi]); }
        else jamb(pickWall((p[1] + q[1]) / 2), p, q);
      }
      const sx0 = Math.max(0, o.x0 - STUB_SIDE), sx1 = Math.min(len, o.x1 + STUB_SIDE), zb = z1 - STUB_DEPTH;
      surface(() => G.stubWall, sx0, sx1, 0, H, [o], z1);
      G.stubWall.rect(sx0, 0, sx1, H, zb, WALL_UV);
      G.stubWall.quad([sx0, 0, z1], [sx0, H, z1], [sx0, H, zb], [sx0, 0, zb], [1, 0, 0]);
      G.stubWall.quad([sx1, 0, z1], [sx1, H, z1], [sx1, H, zb], [sx1, 0, zb], [-1, 0, 0]);
      G.stubCeil.quad([sx0, H, z1], [sx1, H, z1], [sx1, H, zb], [sx0, H, zb], [0, -1, 0]);
      // floor runs on through the doorway (and across the threshold) with the same board layout
      const fc = [[sx0, 0, 0], [sx1, 0, 0], [sx1, 0, zb], [sx0, 0, zb]];
      G.stubFloor.quad(fc[0], fc[1], fc[2], fc[3], [0, 1, 0], undefined, undefined, undefined,
        fc.map((p) => { const v = world(p[0], p[1], p[2]); return floorUV(v.x, v.z); }));
      stats.stubs.push({ pos: world(cx, H - 1, (z1 + zb) / 2).multiplyScalar(IN) });
    }

    // ----- wall surface, cut around openings and split at the paint line -----
    surface(pickWall, 0, len, 0, H, holes, 0, [splitY]);

    // ----- running trim -----
    const run = (prof, y, ya, yb, key) => {
      for (const [x0, x1, capA, capB] of runSpans(len, ya, yb, blocks)) {
        T.strip(prof, x0, y, x1, y, { capA, capB });
        stats.len[key] += x1 - x0;
      }
    };
    if (S.base.on) run(baseProf, 0, 0, S.base.h, 'base');
    if (S.split.rail) run(railProf, railBot, railBot, splitY, 'rail');
    if (S.crown.on) run(crownProf, H - S.crown.h, H - S.crown.h, H, 'crown');

    // ----- boxes -----
    const boxes = (rect, cfgZone, list) => {
      const full = !rect.under && !rect.over && blocks.length === 0;
      const ws = layoutBoxes(rect.x1 - rect.x0, sp, cfgZone, full ? cfg.count : 0, minBox);
      const y0 = rect.y0 + sp, y1 = rect.y1 - sp;
      if (y1 - y0 < minBox) return;
      let x = rect.x0 + sp;
      for (const bw of ws) {
        T.frame(x, y0, x + bw, y1, panelProf);
        stats.len.panel += 2 * (bw + y1 - y0);
        list.push([bw, y1 - y0]);
        if (S.mould.double) {
          const k = mw + S.mould.innerGap;
          if (bw - 2 * k > minBox && y1 - y0 - 2 * k > minBox) {
            T.frame(x + k, y0 + k, x + bw - k, y1 - k, innerProf);
            stats.len.panel += 2 * (bw + y1 - y0 - 4 * k);
          }
        }
        x += bw + sp;
      }
    };

    if (S.upper.on) for (const r of freeRects(len, zoneHi.y0, zoneHi.y1, blocks, minBox + 2 * sp)) boxes(r, S.upper, wstat.upper);

    const lowerCfg = S.lower.align && S.upper.on ? S.upper : S.lower;
    if (S.lower.mode === 'boxes') {
      for (const r of freeRects(len, zoneLo.y0, zoneLo.y1, blocks, minBox + 2 * sp)) boxes(r, lowerCfg, wstat.lower);
    } else if (S.lower.mode === 'shaker') {
      const sw = 3.5, prof = PANEL.flat(sw, 0.5);
      for (const r of freeRects(len, zoneLo.y0, zoneLo.y1, blocks, 2 * sw + 4)) {
        T.strip(prof, r.x0, r.y1 - sw, r.x1, r.y1 - sw);
        T.strip(prof, r.x0, r.y0, r.x1, r.y0);
        const ws = layoutBoxes(r.x1 - r.x0, sw, S.lower, 0, 4);
        let x = r.x0;
        for (let i = 0; i <= ws.length; i++) {
          T.strip(prof, x, r.y1 - sw, x, r.y0 + sw);
          x += sw + (ws[i] || 0);
        }
        stats.len.stile += 2 * (r.x1 - r.x0) + (ws.length + 1) * (r.y1 - r.y0 - 2 * sw);
        for (const bw of ws) wstat.lower.push([bw, r.y1 - r.y0 - 2 * sw]);
      }
    } else if (S.lower.mode === 'bead') {
      const pitch = 2.5, d = 0.3;
      for (const r of freeRects(len, zoneLo.y0, zoneLo.y1, blocks, 6)) {
        const wd = r.x1 - r.x0, prof = [[0, 0], [0, d]];
        for (let x = pitch; x < wd - 0.5; x += pitch) prof.push([x - 0.22, d], [x - 0.11, d * 0.35], [x, d * 0.35], [x + 0.11, d]);
        prof.push([wd, d], [wd, 0]);
        T.strip(prof, r.x0, r.y1, r.x0, r.y0);
      }
    }

    const wallGroup = new THREE.Group();
    wallGroup.name = `wall${wi}`;
    addMeshes(wallGroup, G);
    group.add(wallGroup);
  });

  // ----- floor -----
  g.floor.quad([0, 0, 0], [W, 0, 0], [W, 0, L], [0, 0, L], [0, 1, 0], undefined, undefined, undefined,
    [floorUV(0, 0), floorUV(W, 0), floorUV(W, L), floorUV(0, L)]);

  // ----- ceiling: flat, or a tray (flat border, angled step, raised centre with clipped corners) -----
  const tr = S.tray, C = g.ceil, down = [0, -1, 0];
  const trayFits = tr.on && 2 * (tr.inset + tr.run) < Math.min(W, L) - 12 && tr.rise > 0;
  let top = H, inner = { x0: 0, x1: W, z0: 0, z1: L };
  if (!trayFits) {
    C.quad([0, H, 0], [W, H, 0], [W, H, L], [0, H, L], down);
  } else {
    const maxClip = Math.min(W, L) / 2 - tr.inset - tr.run - 4;
    const c1 = Math.max(0.05, Math.min(tr.clip, maxClip + tr.run * 0.586)), c2 = Math.max(0.05, c1 - tr.run * (2 - Math.SQRT2));
    const oct = (i, c) => [[i + c, i], [W - i - c, i], [W - i, i + c], [W - i, L - i - c], [W - i - c, L - i], [i + c, L - i], [i, L - i - c], [i, i + c]];
    const P1 = oct(tr.inset, c1), P2 = oct(tr.inset + tr.run, c2);
    top = H + tr.rise;
    const outer = [[0, 0], [W, 0], [W, L], [0, L]], all = [...outer, ...P1];
    const v2 = (p) => new THREE.Vector2(p[0], p[1]);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer.map(v2), [P1.map(v2)])) {
      C.tri([all[a][0], H, all[a][1]], [all[b][0], H, all[b][1]], [all[c][0], H, all[c][1]], down, down, down);
    }
    for (let k = 0; k < 8; k++) {
      const a = P1[k], b = P1[(k + 1) % 8], c = P2[(k + 1) % 8], d = P2[k];
      const A = [a[0], H, a[1]], B = [b[0], H, b[1]], Cc = [c[0], top, c[1]], D = [d[0], top, d[1]];
      const e1 = new THREE.Vector3(B[0] - A[0], 0, B[2] - A[2]), e2 = new THREE.Vector3(D[0] - A[0], D[1] - A[1], D[2] - A[2]);
      const nn = e1.cross(e2).normalize(); if (nn.y > 0) nn.negate();
      C.quad(A, B, Cc, D, [nn.x, nn.y, nn.z]);
    }
    for (let k = 1; k < 7; k++) C.tri([P2[0][0], top, P2[0][1]], [P2[k][0], top, P2[k][1]], [P2[k + 1][0], top, P2[k + 1][1]], down, down, down);
    const i2 = tr.inset + tr.run;
    inner = { x0: i2, x1: W - i2, z0: i2, z1: L - i2 };
  }
  stats.ceiling = { y: top * IN, x0: inner.x0 * IN, x1: inner.x1 * IN, z0: inner.z0 * IN, z1: inner.z1 * IN };

  addMeshes(group, g);
  stats.tris = 0;
  group.traverse((o) => { if (o.isMesh) stats.tris += o.geometry.index.count / 3; });
  return { group, stats };
}
