// All design state. Lengths are inches.
// Opening x is the distance from the wall's left corner (seen from inside the room) to the opening's left edge.
export const OPENING_DEFAULTS = {
  window: { type: 'window', x: 30, w: 32, h: 58, sill: 27, cols: 3, rows: 2, clip: 0, cased: true },
  door: { type: 'door', x: 30, w: 32, h: 80, sill: 0, cols: 1, rows: 1, clip: 0, cased: true },
  opening: { type: 'opening', x: 30, w: 38, h: 82, sill: 0, cols: 1, rows: 1, clip: 8, cased: false },
};
const op = (type, over) => ({ ...OPENING_DEFAULTS[type], ...over });

// The starting room is the dining room from the reference photos: two windows on wall A, a doorless
// angled-top doorway to the kitchen on B, another to the atrium at the left of C, D blank, tray ceiling.
// Sizes are estimates from the photos and are meant to be replaced with tape-measure numbers.
export const DEFAULTS = {
  room: { w: 156, l: 144, h: 96 },
  tray: { on: true, inset: 14, run: 7, rise: 8, clip: 14 },
  split: { height: 34, rail: true, railStyle: 'classic', railH: 2.5, railD: 0.9 },
  base: { on: true, style: 'colonial', h: 5.25, d: 0.7 },
  crown: { on: false, style: 'ogee', h: 4.25, p: 3.75 },
  mould: { profile: 'ogee', w: 1.5, d: 0.7, spacing: 3.5, double: false, innerGap: 2.5 },
  upper: { on: true, targetW: 26, rhythm: 'equal', ratio: 2 },
  lower: { mode: 'boxes', align: true, targetW: 26, rhythm: 'equal', ratio: 2 },
  walls: [
    { count: 0, openings: [op('window', { x: 28 }), op('window', { x: 96 })] },
    { count: 0, openings: [op('opening', { x: 40, w: 38 })] },
    { count: 0, openings: [op('opening', { x: 12, w: 44 })] },
    { count: 0, openings: [] },
  ],
  colors: {
    wall: '#bcc9cb', twoTone: false, lower: '#b9c2b6', trim: '#f4f3ef', mono: false,
    wallSheen: 'eggshell', trimSheen: 'semi',
  },
  floor: 'strip_oak', floorColor: null, floorRotate: false,
  light: { preset: 'soft', exposure: 1 },
  ui: { wall: 0, opening: 0 },
};

export const PRESETS = [
  {
    name: 'Parisian', hint: 'Rail, tall boxes, one colour',
    set: {
      split: { height: 36, rail: true, railStyle: 'classic', railH: 2.75, railD: 1 },
      crown: { on: true, style: 'ogee', h: 4.25, p: 3.75 }, base: { on: true, style: 'colonial', h: 6.5, d: 0.75 },
      mould: { profile: 'ogee', w: 1.75, d: 0.75, spacing: 4, double: false, innerGap: 2.5 },
      upper: { on: true, targetW: 30, rhythm: 'equal', ratio: 2 }, lower: { mode: 'boxes', align: true, targetW: 30, rhythm: 'equal', ratio: 2 },
      colors: { wall: '#dfe1e0', twoTone: false, lower: '#b9c2b6', trim: '#dfe1e0', mono: true, wallSheen: 'eggshell', trimSheen: 'satin' },
    },
  },
  {
    name: 'Modern boxes', hint: 'No rail, wide centre',
    set: {
      split: { height: 34, rail: false, railStyle: 'simple', railH: 2.5, railD: 0.75 },
      crown: { on: true, style: 'modern', h: 3, p: 2.5 }, base: { on: true, style: 'modern', h: 4.5, d: 0.6 },
      mould: { profile: 'stepped', w: 1.5, d: 0.6, spacing: 5, double: false, innerGap: 2.5 },
      upper: { on: true, targetW: 34, rhythm: 'center', ratio: 2.2 }, lower: { mode: 'boxes', align: true, targetW: 34, rhythm: 'center', ratio: 2.2 },
      colors: { wall: '#e7e0d3', twoTone: false, lower: '#b9c2b6', trim: '#f6f4ef', mono: false, wallSheen: 'matte', trimSheen: 'satin' },
    },
  },
  {
    name: 'Double frame', hint: 'Nested boxes, two-tone',
    set: {
      split: { height: 38, rail: true, railStyle: 'beaded', railH: 3, railD: 1.1 },
      crown: { on: true, style: 'cove', h: 4.5, p: 4 }, base: { on: true, style: 'stepped', h: 7, d: 0.8 },
      mould: { profile: 'bolection', w: 2, d: 0.9, spacing: 4.5, double: true, innerGap: 2.5 },
      upper: { on: true, targetW: 38, rhythm: 'alt', ratio: 2 }, lower: { mode: 'boxes', align: true, targetW: 38, rhythm: 'alt', ratio: 2 },
      colors: { wall: '#d9d2c4', twoTone: true, lower: '#5d6b62', trim: '#f2efe8', mono: false, wallSheen: 'matte', trimSheen: 'semi' },
    },
  },
  {
    name: 'Shaker wainscot', hint: 'Recessed panels below',
    set: {
      split: { height: 42, rail: true, railStyle: 'simple', railH: 2.5, railD: 1.1 },
      crown: { on: true, style: 'modern', h: 3.5, p: 3 }, base: { on: true, style: 'modern', h: 5.5, d: 0.75 },
      upper: { on: false, targetW: 30, rhythm: 'equal', ratio: 2 }, lower: { mode: 'shaker', align: false, targetW: 22, rhythm: 'equal', ratio: 2 },
      colors: { wall: '#a9b4b0', twoTone: false, lower: '#b9c2b6', trim: '#f4f2ec', mono: false, wallSheen: 'matte', trimSheen: 'satin' },
    },
  },
];

const KEY = 'panel-planner-v2';
const clone = (o) => JSON.parse(JSON.stringify(o));

export function merge(target, src) {
  for (const k in src) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') merge(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

// Replace the contents of `s` with a saved design laid over the defaults, so designs saved by an
// older version (missing newer settings) still load. Anything unrecognised in the walls is dropped.
export function applyDesign(s, saved) {
  const next = clone(DEFAULTS);
  if (saved && typeof saved === 'object') {
    const copy = clone(saved), walls = copy.walls;
    delete copy.walls;
    merge(next, copy);
    if (Array.isArray(walls) && walls.length === 4 && walls.every((w) => w && Array.isArray(w.openings))) {
      next.walls = walls.map((w) => ({
        count: +w.count || 0,
        openings: w.openings.filter((o) => o && OPENING_DEFAULTS[o.type]).map((o) => ({ ...OPENING_DEFAULTS[o.type], ...o })),
      }));
    }
  }
  next.ui = { wall: 0, opening: 0 };
  for (const k in s) delete s[k];
  Object.assign(s, next);
  return s;
}

export function loadState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* fall back to defaults */ }
  return applyDesign({}, saved);
}

// Design files: a small JSON wrapper so a file can be recognised (and versioned) on import.
const FILE_TAG = 'panel-planner-design';
export function exportDesign(s) {
  const design = clone(s);
  delete design.ui;
  return { format: FILE_TAG, version: 2, design };
}
export function importDesign(s, text) {
  let data = null;
  try { data = JSON.parse(text); } catch { /* reported below */ }
  const design = data && data.format === FILE_TAG ? data.design : data;
  if (!design || typeof design !== 'object' || !design.room || !Array.isArray(design.walls)) {
    throw new Error('That file is not a Panel Planner design.');
  }
  return applyDesign(s, design);
}

export function saveState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function resetState(s) {
  for (const k in s) delete s[k];
  Object.assign(s, clone(DEFAULTS));
}

export const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
export function setPath(o, p, v) {
  const ks = p.split('.'); const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}
