import { getPath, setPath, PRESETS, merge, OPENING_DEFAULTS, exportDesign, importDesign } from './state.js';
import { PANEL_NAMES, RAIL_NAMES, BASE_NAMES, CROWN_NAMES } from './profiles.js';
import { FLOORS } from './materials.js';
import { WALL_NAMES } from './room.js';

// ----- formatting -----
export function inches(v) {
  const e = Math.round(v * 8), whole = Math.floor(e / 8), f = e % 8;
  if (!f) return `${whole}"`;
  const d = f % 4 === 0 ? 2 : f % 2 === 0 ? 4 : 8;
  return `${whole ? whole + ' ' : ''}${f / (8 / d)}/${d}"`;
}
const feet = (v) => { const f = Math.floor(v / 12), i = Math.round(v - f * 12); return i ? `${f}' ${i}"` : `${f}'`; };
const times = (v) => `${v.toFixed(1)}×`;
const pct = (v) => `${Math.round(v * 100)}%`;

// A swatch is a hex string, or [hex, name] for a real paint. Named paints use published screen
// values for the colour, which only approximate the paint on a wall.
const WALL_COLORS = [['#c9d3d0', 'Pale Smoke · Benjamin Moore 1584'], ['#edeae5', 'Snowbound · Sherwin-Williams SW 7004'], '#e4ddd0', '#eeebe4', '#dfe1e0', '#d5cdbd', '#c9c2b4', '#a9b4b0', '#b9c2b6', '#8c9a8e', '#5d6b62', '#39485a', '#2f3a3a', '#c8a9a0', '#b98b73'];
const TRIM_COLORS = ['#f4f2ec', '#ffffff', '#ebe6da', '#dfe1e0', '#cfd3d0', '#2b2b2a'];
const opts = (o) => Object.entries(o).map(([v, l]) => [v, typeof l === 'string' ? l : l.name]);

const FLOOR_COLORS = ['#c9a06a', '#b9814a', '#a8683a', '#8a5a36', '#5a3a26', '#d8c3a0', '#9a8f84', '#3a2a22'];
const w = (s) => `walls.${s.ui.wall}`;
const cur = (s) => s.walls[s.ui.wall].openings[s.ui.opening];
const o = (s) => `${w(s)}.openings.${s.ui.opening}`;
const isType = (...t) => (s) => !!cur(s) && t.includes(cur(s).type);
const wallLen = (s) => (s.ui.wall % 2 ? s.room.l : s.room.w);
const TYPE_NAMES = { window: 'Window', door: 'Door', opening: 'Doorway' };

// Declarative control list. `p` is a state path (or a function of state returning one).
const SECTIONS = [
  { title: 'Walls, doors & windows', tab: 'room', open: true, items: [
    { t: 'note', text: 'Click a wall in the view to work on it. Drag a door or window to slide it along its wall.' },
    { t: 'seg', p: 'ui.wall', label: 'Wall', options: WALL_NAMES.map((n, i) => [i, n]), view: true },
    { t: 'note', text: (s) => `Wall ${WALL_NAMES[s.ui.wall]} is ${feet(wallLen(s))} long.` },
    { t: 'openings' },
    { t: 'seg', p: (s) => `${o(s)}.type`, label: 'Type', options: [['window', 'Window'], ['door', 'Door'], ['opening', 'Doorway']], opening: true, show: (s) => !!cur(s) },
    { t: 'range', p: (s) => `${o(s)}.x`, label: 'From left corner', min: 0, max: wallLen, step: 0.5, fmt: inches, show: (s) => !!cur(s) },
    { t: 'range', p: (s) => `${o(s)}.w`, label: 'Width', min: 16, max: 120, step: 0.5, fmt: inches, show: (s) => !!cur(s) },
    { t: 'range', p: (s) => `${o(s)}.h`, label: 'Height', min: 20, max: 108, step: 0.5, fmt: inches, show: (s) => !!cur(s) },
    { t: 'range', p: (s) => `${o(s)}.sill`, label: 'Sill height', min: 6, max: 60, step: 0.5, fmt: inches, show: isType('window') },
    { t: 'range', p: (s) => `${o(s)}.cols`, label: 'Panes across', min: 1, max: 6, step: 1, fmt: String, show: isType('window') },
    { t: 'range', p: (s) => `${o(s)}.rows`, label: 'Panes per sash', min: 1, max: 4, step: 1, fmt: (v) => `${v} high`, show: isType('window') },
    { t: 'range', p: (s) => `${o(s)}.clip`, label: 'Angled top', min: 0, max: 20, step: 0.5, fmt: (v) => (v ? inches(v) : 'Square'), show: isType('opening') },
    { t: 'check', p: (s) => `${o(s)}.cased`, label: 'Trim casing around the doorway', show: isType('opening') },
    { t: 'note', text: 'Doorway = an opening with no door. Height is measured to the top of the opening; the angled corners cut in from there.', show: isType('opening') },
    { t: 'range', p: (s) => `${w(s)}.count`, label: 'Boxes across', min: 0, max: 10, step: 1, fmt: (v) => (v ? String(v) : 'Auto'), show: (s) => !s.walls[s.ui.wall].openings.length },
  ] },
  { title: 'Quick looks', open: true, items: [{ t: 'presets' }] },
  { title: 'Room size & ceiling', tab: 'room', open: true, items: [
    { t: 'note', text: 'Click any number to type an exact measurement in inches.' },
    { t: 'range', p: 'room.w', label: 'Walls A & C', min: 72, max: 360, step: 1, fmt: feet },
    { t: 'range', p: 'room.l', label: 'Walls B & D', min: 72, max: 360, step: 1, fmt: feet },
    { t: 'range', p: 'room.h', label: 'Ceiling', min: 84, max: 144, step: 0.5, fmt: feet },
    { t: 'sub', text: 'Tray ceiling' },
    { t: 'check', p: 'tray.on', label: 'Raised centre (tray ceiling)' },
    { t: 'range', p: 'tray.inset', label: 'Border width', min: 4, max: 48, step: 0.5, fmt: inches, show: (s) => s.tray.on },
    { t: 'range', p: 'tray.rise', label: 'Rise', min: 2, max: 24, step: 0.5, fmt: inches, show: (s) => s.tray.on },
    { t: 'range', p: 'tray.run', label: 'Angled step', min: 0.5, max: 24, step: 0.5, fmt: inches, show: (s) => s.tray.on },
    { t: 'range', p: 'tray.clip', label: 'Corner cut', min: 0, max: 36, step: 0.5, fmt: inches, show: (s) => s.tray.on },
  ] },
  { title: 'Floor', tab: 'room', items: [
    { t: 'select', p: 'floor', label: 'Material', options: opts(FLOORS) },
    { t: 'color', p: 'floorColor', label: 'Colour', swatches: FLOOR_COLORS, none: 'Natural', fallback: '#b9814a' },
    { t: 'note', text: 'Pick the colour closest to your real floor; the wood grain is tinted to match it.' },
    { t: 'check', p: 'floorRotate', label: 'Run boards the other way' },
  ] },
  { title: 'Chair rail', open: true, items: [
    { t: 'range', p: 'split.height', label: 'Height', min: 24, max: 72, step: 0.5, fmt: inches },
    { t: 'check', p: 'split.rail', label: 'Chair rail moulding' },
    { t: 'note', text: 'With the rail off, this height is where upper and lower boxes divide.', show: (s) => !s.split.rail },
    { t: 'select', p: 'split.railStyle', label: 'Profile', options: opts(RAIL_NAMES), show: (s) => s.split.rail },
    { t: 'range', p: 'split.railH', label: 'Rail size', min: 1.5, max: 5, step: 0.25, fmt: inches, show: (s) => s.split.rail },
    { t: 'range', p: 'split.railD', label: 'Projection', min: 0.5, max: 2, step: 0.125, fmt: inches, show: (s) => s.split.rail },
  ] },
  { title: 'Trim boxes', open: true, items: [
    { t: 'sub', text: 'Above the rail' },
    { t: 'check', p: 'upper.on', label: 'Boxes above' },
    { t: 'range', p: 'upper.targetW', label: 'Box width', min: 10, max: 96, step: 1, fmt: (v) => `~${inches(v)}`, show: (s) => s.upper.on },
    { t: 'seg', p: 'upper.rhythm', label: 'Rhythm', options: [['equal', 'Equal'], ['center', 'Wide centre'], ['alt', 'Alternating']], show: (s) => s.upper.on },
    { t: 'range', p: 'upper.ratio', label: 'Wide : narrow', min: 1.2, max: 4, step: 0.1, fmt: times, show: (s) => s.upper.on && s.upper.rhythm !== 'equal' },
    { t: 'sub', text: 'Below the rail' },
    { t: 'select', p: 'lower.mode', label: 'Style', options: [['boxes', 'Trim boxes'], ['shaker', 'Shaker recessed panels'], ['bead', 'Beadboard'], ['none', 'Plain wall']] },
    { t: 'check', p: 'lower.align', label: 'Line up with boxes above', show: (s) => s.lower.mode === 'boxes' && s.upper.on },
    { t: 'range', p: 'lower.targetW', label: 'Panel width', min: 10, max: 96, step: 1, fmt: (v) => `~${inches(v)}`,
      show: (s) => s.lower.mode === 'shaker' || (s.lower.mode === 'boxes' && !(s.lower.align && s.upper.on)) },
    { t: 'seg', p: 'lower.rhythm', label: 'Rhythm', options: [['equal', 'Equal'], ['center', 'Wide centre'], ['alt', 'Alternating']],
      show: (s) => s.lower.mode === 'boxes' && !(s.lower.align && s.upper.on) },
    { t: 'range', p: 'lower.ratio', label: 'Wide : narrow', min: 1.2, max: 4, step: 0.1, fmt: times,
      show: (s) => s.lower.mode === 'boxes' && !(s.lower.align && s.upper.on) && s.lower.rhythm !== 'equal' },
    { t: 'sub', text: 'Box moulding' },
    { t: 'select', p: 'mould.profile', label: 'Profile', options: opts(PANEL_NAMES) },
    { t: 'range', p: 'mould.w', label: 'Width', min: 0.75, max: 4, step: 0.125, fmt: inches },
    { t: 'range', p: 'mould.d', label: 'Projection', min: 0.25, max: 1.5, step: 0.0625, fmt: inches },
    { t: 'range', p: 'mould.spacing', label: 'Spacing', min: 2, max: 10, step: 0.25, fmt: inches },
    { t: 'check', p: 'mould.double', label: 'Double frame (box within a box)' },
    { t: 'range', p: 'mould.innerGap', label: 'Inner gap', min: 1, max: 6, step: 0.25, fmt: inches, show: (s) => s.mould.double },
  ] },
  { title: 'Baseboard & crown', items: [
    { t: 'check', p: 'base.on', label: 'Baseboard' },
    { t: 'select', p: 'base.style', label: 'Profile', options: opts(BASE_NAMES), show: (s) => s.base.on },
    { t: 'range', p: 'base.h', label: 'Height', min: 3, max: 10, step: 0.25, fmt: inches, show: (s) => s.base.on },
    { t: 'check', p: 'crown.on', label: 'Crown moulding' },
    { t: 'select', p: 'crown.style', label: 'Profile', options: opts(CROWN_NAMES), show: (s) => s.crown.on },
    { t: 'range', p: 'crown.h', label: 'Drop', min: 2, max: 8, step: 0.25, fmt: inches, show: (s) => s.crown.on },
    { t: 'range', p: 'crown.p', label: 'Projection', min: 1.5, max: 8, step: 0.25, fmt: inches, show: (s) => s.crown.on },
  ] },
  { title: 'Paint', open: true, items: [
    { t: 'color', p: 'colors.wall', label: 'Walls', swatches: WALL_COLORS },
    { t: 'check', p: 'colors.mono', label: 'Paint trim the wall colour' },
    { t: 'color', p: 'colors.trim', label: 'Trim', swatches: TRIM_COLORS, show: (s) => !s.colors.mono },
    { t: 'check', p: 'colors.twoTone', label: 'Different colour below the rail' },
    { t: 'color', p: 'colors.lower', label: 'Lower wall', swatches: WALL_COLORS, show: (s) => s.colors.twoTone },
    { t: 'seg', p: 'colors.wallSheen', label: 'Wall sheen', options: [['matte', 'Matte'], ['eggshell', 'Eggshell'], ['satin', 'Satin']] },
    { t: 'seg', p: 'colors.trimSheen', label: 'Trim sheen', options: [['satin', 'Satin'], ['semi', 'Semi-gloss'], ['gloss', 'Gloss']] },
  ] },
  { title: 'Light', open: true, items: [
    { t: 'seg', p: 'light.preset', label: 'Scene', options: [['soft', 'Soft day'], ['sunny', 'Sunny'], ['evening', 'Evening']] },
    { t: 'range', p: 'light.exposure', label: 'Exposure', min: 0.4, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  ] },
  { title: 'Cut list', open: true, items: [{ t: 'cut' }] },
];

export class UI {
  constructor(root, S, { onChange, onView, onReset, onTab, onSelect }) {
    Object.assign(this, { root, S, onChange, onView, onReset, onTab, onSelect });
    this.open = new Set(SECTIONS.filter((s) => s.open).map((s) => s.title));
    this.stats = null;
    this.render();
  }

  // Replace the current design with one read from a design file. Throws if the text is not a design.
  loadDesignText(text) {
    importDesign(this.S, text);
    this.render();
    this.onChange();
    this.onView('wall0');
  }

  setStats(stats) {
    this.stats = stats;
    const el = this.root.querySelector('#cut');
    if (el) el.innerHTML = this._cutHTML();
  }

  _path(item) { return typeof item.p === 'function' ? item.p(this.S) : item.p; }

  _cutHTML() {
    const st = this.stats;
    if (!st) return '';
    const ft = (v) => `${(v / 12).toFixed(1)} ft`;
    const group = (list) => {
      const m = new Map();
      for (const [bw, bh] of list) { const k = `${inches(bw)} × ${inches(bh)}`; m.set(k, (m.get(k) || 0) + 1); }
      return [...m].map(([k, n]) => `${n} @ ${k}`).join('<br>') || '—';
    };
    const ws = st.walls[this.S.ui.wall];
    const rows = [
      [`Wall ${WALL_NAMES[this.S.ui.wall]} upper boxes`, group(ws.upper)],
      [`Wall ${WALL_NAMES[this.S.ui.wall]} lower panels`, group(ws.lower)],
      ['Box moulding', ft(st.len.panel)], ['Chair rail', ft(st.len.rail)], ['Baseboard', ft(st.len.base)],
      ['Crown', ft(st.len.crown)], ['Casing', ft(st.len.casing)],
    ];
    if (st.len.stile) rows.push(['Stiles & rails', ft(st.len.stile)]);
    return `<table class="cut">${rows.filter((r) => r[1] !== '0.0 ft').map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>
      <p class="note" style="margin-top:8px">Box sizes are outside-of-moulding. Lengths are whole-room totals before waste; add about 10%.</p>`;
  }

  render() {
    const S = this.S, root = this.root, scroll = root.scrollTop;
    root.innerHTML = '';
    const tabs = document.createElement('div'); tabs.className = 'tabs';
    for (const [id, label, hint] of [['room', '1  Room', 'Shape, doors, windows'], ['design', '2  Design', 'Paneling, paint, light']]) {
      const b = document.createElement('button');
      b.className = S.ui.tab === id ? 'on' : '';
      b.innerHTML = `${label}<small>${hint}</small>`;
      b.onclick = () => { if (S.ui.tab === id) return; S.ui.tab = id; this.render(); root.scrollTop = 0; this.onTab(id); };
      tabs.append(b);
    }
    root.append(tabs);
    for (const sec of SECTIONS) {
      if ((sec.tab || 'design') !== S.ui.tab) continue;
      const det = document.createElement('details');
      det.open = this.open.has(sec.title);
      det.addEventListener('toggle', () => (det.open ? this.open.add(sec.title) : this.open.delete(sec.title)));
      det.innerHTML = `<summary>${sec.title}</summary>`;
      const body = document.createElement('div'); body.className = 'body';
      for (const item of sec.items) {
        if (item.show && !item.show(S)) continue;
        const el = this._control(item);
        if (el) body.append(el);
      }
      det.append(body); root.append(det);
    }
    const reset = document.createElement('div'); reset.className = 'body'; reset.style.paddingTop = '14px';
    reset.innerHTML = `<div class="sub">Design file</div>
      <div class="filebtns"><button class="btn" data-a="export">Export design</button><button class="btn" data-a="import">Import design</button></div>
      <p class="note" data-a="msg">Export saves the whole room and design as a file you can keep, share or open on another computer.</p>
      <button class="btn" data-a="reset" style="text-align:center">Reset everything</button>
      <p class="note">Dimensions are in feet and inches. Your design is also saved in this browser.</p>`;
    const q = (a) => reset.querySelector(`[data-a="${a}"]`);
    q('reset').onclick = () => { this.onReset(); this.render(); this.onChange(); };
    q('export').onclick = () => {
      const blob = new Blob([JSON.stringify(exportDesign(S), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'panel-design.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    q('import').onclick = () => {
      const pick = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
      pick.onchange = async () => {
        const file = pick.files[0];
        if (!file) return;
        try {
          this.loadDesignText(await file.text());
        } catch (e) {
          const msg = this.root.querySelector('[data-a="msg"]');
          if (msg) { msg.textContent = `Could not import ${file.name}: ${e.message}`; msg.style.color = '#a2452f'; }
        }
      };
      pick.click();
    };
    root.append(reset);
    root.scrollTop = scroll;
  }

  _commit(item, value, rerender) {
    const S = this.S, path = this._path(item);
    setPath(S, path, value);
    if (item.opening) {
      // sensible sizes when an opening changes type, keeping where it sits on the wall
      const op = cur(S);
      Object.assign(op, OPENING_DEFAULTS[value], { x: op.x });
    }
    if (path === 'ui.wall') S.ui.opening = 0;
    if (rerender) this.render();
    if (item.view) this.onView(`wall${value}`);
    this.onChange();
  }

  _control(item) {
    const S = this.S, row = document.createElement('div');
    if (item.t === 'sub') { row.className = 'sub'; row.textContent = item.text; return row; }
    if (item.t === 'note') { row.className = 'note'; row.textContent = typeof item.text === 'function' ? item.text(S) : item.text; return row; }
    if (item.t === 'cut') { row.id = 'cut'; row.innerHTML = this._cutHTML(); return row; }
    if (item.t === 'openings') {
      // one chip per opening on this wall, plus add / remove
      const wl = S.walls[S.ui.wall];
      row.className = 'chips';
      wl.openings.forEach((op, i) => {
        const b = document.createElement('button');
        b.className = 'chip' + (i === S.ui.opening ? ' on' : '');
        b.textContent = `${i + 1} ${TYPE_NAMES[op.type]}`;
        b.onclick = () => { S.ui.opening = i; this.render(); this.onSelect(); };
        row.append(b);
      });
      const adds = document.createElement('div'); adds.className = 'chips addrow';
      for (const type of ['window', 'door', 'opening']) {
        const add = document.createElement('button'); add.className = 'chip add'; add.textContent = `+ ${TYPE_NAMES[type]}`;
        add.onclick = () => {
          const d = OPENING_DEFAULTS[type];
          wl.openings.push({ ...d, x: Math.max(4, Math.round(wallLen(S) / 2 - d.w / 2)) });
          S.ui.opening = wl.openings.length - 1; this.render(); this.onChange();
        };
        adds.append(add);
      }
      if (wl.openings.length) {
        const del = document.createElement('button'); del.className = 'chip del'; del.textContent = 'Remove';
        del.onclick = () => {
          wl.openings.splice(S.ui.opening, 1);
          S.ui.opening = Math.max(0, Math.min(S.ui.opening, wl.openings.length - 1)); this.render(); this.onChange();
        };
        row.append(del);
      } else {
        const none = document.createElement('span'); none.className = 'note'; none.textContent = 'No openings on this wall';
        row.prepend(none);
      }
      const wrap = document.createElement('div'); wrap.className = 'openings';
      wrap.append(row, adds);
      return wrap;
    }
    if (item.t === 'presets') {
      row.className = 'presets';
      for (const p of PRESETS) {
        const b = document.createElement('button');
        b.innerHTML = `${p.name}<small>${p.hint}</small>`;
        b.onclick = () => { merge(S, p.set); this.render(); this.onChange(); };
        row.append(b);
      }
      return row;
    }
    const path = this._path(item), value = getPath(S, path);
    if (item.t === 'check') {
      const l = document.createElement('label'); l.className = 'check';
      l.innerHTML = `<input type="checkbox" ${value ? 'checked' : ''}><span>${item.label}</span>`;
      l.querySelector('input').onchange = (e) => this._commit(item, e.target.checked, true);
      return l;
    }
    row.className = 'row';
    const label = document.createElement('label'); label.textContent = item.label; row.append(label);
    if (item.t === 'range') {
      const max = typeof item.max === 'function' ? item.max(S) : item.max;
      const input = Object.assign(document.createElement('input'), { type: 'range', min: item.min, max, step: item.step, value });
      const val = document.createElement('span'); val.className = 'val'; val.textContent = item.fmt(value);
      val.title = 'Click to type an exact value';
      input.oninput = () => { const v = +input.value; val.textContent = item.fmt(v); this._commit(item, v, false); };
      // Click the readout to type an exact number (inches for lengths).
      val.onclick = () => {
        const box = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: getPath(S, this._path(item)), className: 'num' });
        val.replaceWith(box); box.focus(); box.select();
        const done = (keep) => {
          const v = parseFloat(box.value);
          if (keep && Number.isFinite(v)) this._commit(item, Math.max(item.min, Math.min(max, v)), false);
          this.render();
        };
        box.onblur = () => done(true);
        box.onkeydown = (e) => { if (e.key === 'Enter') box.blur(); if (e.key === 'Escape') { box.onblur = null; done(false); } };
      };
      row.append(input, val);
    } else if (item.t === 'select') {
      row.classList.add('wide');
      const sel = document.createElement('select');
      for (const [v, l] of item.options) sel.add(new Option(l, v, false, v === value));
      sel.onchange = () => this._commit(item, sel.value, true);
      row.append(sel);
    } else if (item.t === 'seg') {
      row.classList.add('wide');
      const seg = document.createElement('div'); seg.className = 'seg';
      for (const [v, l] of item.options) {
        const b = document.createElement('button'); b.textContent = l;
        if (String(v) === String(value)) b.className = 'on';
        b.onclick = () => this._commit(item, v, true);
        seg.append(b);
      }
      row.append(seg);
    } else if (item.t === 'color') {
      row.classList.add('wide');
      const box = document.createElement('div'); box.className = 'colors';
      if (item.none) {
        const b = document.createElement('button'); b.className = 'chip' + (value ? '' : ' on'); b.textContent = item.none;
        b.onclick = () => this._commit(item, null, true);
        box.append(b);
      }
      let chosenName = '';
      for (const sw of item.swatches) {
        const [c, name] = Array.isArray(sw) ? sw : [sw, ''];
        if (name && c === value) chosenName = name;
        const b = document.createElement('button'); b.className = 'sw' + (c === value ? ' on' : ''); b.style.background = c; b.title = name || c;
        b.onclick = () => this._commit(item, c, true);
        box.append(b);
      }
      const pick = Object.assign(document.createElement('input'), { type: 'color', value: value || item.fallback || '#888888', title: 'Custom colour' });
      pick.oninput = () => this._commit(item, pick.value, false);
      box.append(pick);
      if (chosenName) {
        const cap = document.createElement('div'); cap.className = 'paintname'; cap.textContent = chosenName;
        box.append(cap);
      }
      row.append(box);
    }
    return row;
  }
}
