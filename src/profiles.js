// Moulding cross-sections as polylines of [t, z] in inches.
// t runs across the face of the moulding (from its outer/bottom edge), z is how far it stands off the wall.
// Every profile starts and ends on the wall (z = 0) except crowns, which end on the ceiling.

const rad = Math.PI / 180;
// Elliptical arc around (ct, cz); angles in degrees, 0 = +t, 90 = +z.
function arc(ct, cz, rt, rz, a0, a1, n = 8) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0 + (a1 - a0) * (i / n)) * rad;
    out.push([ct + rt * Math.cos(a), cz + rz * Math.sin(a)]);
  }
  return out;
}
// Cyma (S) curve between two points.
function cyma(t0, z0, t1, z1, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    out.push([t0 + (t1 - t0) * s, z0 + (z1 - z0) * (0.5 - 0.5 * Math.cos(Math.PI * s))]);
  }
  return out;
}
const E = 0.06; // eased edge

// Three stock mouldings modelled from the owner's samples. Thick edge at t = 0.
// Base cap: rounded nose, long shallow sweep, then a step down to a thin flat lip.
const capMould = (w, d) => [
  [0, 0], [0, 0.7 * d], ...arc(0.12 * w, 0.7 * d, 0.12 * w, 0.3 * d, 180, 90, 6),
  ...cyma(0.16 * w, d, 0.7 * w, 0.52 * d, 10),
  [0.7 * w, 0.34 * d], [w - E, 0.34 * d], [w, 0.34 * d - E], [w, 0],
];
// Cove and bead: thick edge, scooped cove, a raised bead, then a flat fillet.
const coveBead = (w, d) => [
  [0, 0], [0, d - E], [E, d], [0.08 * w, d],
  ...arc(0.3 * w, d, 0.22 * w, 0.45 * d, 180, 335, 12),
  ...arc(0.66 * w, 0.6 * d, 0.14 * w, 0.4 * d, 150, 0, 10),
  [0.8 * w, 0.4 * d], [w - E, 0.4 * d], [w, 0.4 * d - E], [w, 0],
];
// Colonial: flat lip, cove, a big rounded torus, then an ogee falling to a thin lip.
const colonial = (w, d) => [
  [0, 0], [0, 0.3 * d], [0.1 * w, 0.3 * d],
  ...arc(0.1 * w, 0.72 * d, 0.18 * w, 0.42 * d, 270, 360, 8),
  [0.28 * w, 0.78 * d], [0.32 * w, 0.78 * d],
  ...arc(0.5 * w, 0.78 * d, 0.18 * w, 0.22 * d, 180, 0, 14),
  [0.68 * w, 0.62 * d], [0.74 * w, 0.62 * d],
  ...cyma(0.74 * w, 0.62 * d, 0.92 * w, 0.25 * d, 8),
  [w - E, 0.25 * d], [w, 0.25 * d - E], [w, 0],
];
// Mirror a profile so its thick edge ends up at t = w (the top of a chair rail).
const flip = (f) => (w, d) => f(w, d).map(([t, z]) => [w - t, z]).reverse();

// Panel mouldings: w = face width, d = projection. t = 0 is the outside edge of the box.
export const PANEL = {
  ogee: (w, d) => [
    [0, 0], ...arc(0.14 * w, 0.78 * d, 0.14 * w, 0.22 * d, 180, 90, 6),
    [0.3 * w, d], [0.3 * w, 0.86 * d], ...cyma(0.36 * w, 0.86 * d, 0.86 * w, 0.3 * d),
    [0.86 * w, 0.2 * d], [w - E, 0.2 * d], [w, 0.2 * d - E], [w, 0],
  ],
  bead: (w, d) => [
    [0, 0], [0, 0.5 * d], [0.1 * w, 0.5 * d], ...arc(0.275 * w, 0.5 * d, 0.175 * w, 0.5 * d, 180, 0, 10),
    ...arc(0.92 * w, 0.5 * d, 0.47 * w, 0.35 * d, 180, 270, 8), [w, 0.15 * d], [w, 0],
  ],
  stepped: (w, d) => [
    [0, 0], [0, d - E], [E, d], [0.4 * w, d], [0.4 * w, 0.62 * d], [0.7 * w, 0.62 * d],
    [0.7 * w, 0.3 * d], [w, 0.3 * d], [w, 0],
  ],
  flat: (w, d) => [[0, 0], [0, d - E], [E, d], [w - E, d], [w, d - E], [w, 0]],
  halfround: (w, d) => arc(w / 2, 0, w / 2, d, 180, 0, 16),
  bolection: (w, d) => [
    [0, 0], [0, 0.3 * d], [0.12 * w, 0.3 * d], [0.12 * w, 0.45 * d],
    ...arc(0.5 * w, 0.45 * d, 0.38 * w, 0.55 * d, 180, 0, 14),
    [0.88 * w, 0.3 * d], [w, 0.3 * d], [w, 0],
  ],
  cap: capMould,
  covebead: coveBead,
  colonial,
};
export const PANEL_NAMES = { ogee: 'Ogee', bead: 'Bead & cove', stepped: 'Stepped', flat: 'Flat stock', halfround: 'Half round', bolection: 'Bolection',
  cap: 'Base cap (sample 1)', covebead: 'Cove & bead (sample 2)', colonial: 'Colonial (sample 3)' };

// Chair rails: h = height, d = projection. t = 0 is the bottom edge.
export const RAIL = {
  classic: (h, d) => [
    [0, 0], [0, 0.22 * d], ...cyma(0, 0.22 * d, 0.38 * h, 0.62 * d, 8), [0.38 * h, 0.7 * d], [0.42 * h, 0.7 * d],
    ...arc(0.62 * h, 0.7 * d, 0.2 * h, 0.3 * d, 180, 0, 10),
    [0.82 * h, 0.5 * d], ...arc(h, 0.5 * d, 0.18 * h, 0.3 * d, 180, 270, 6), [h, 0],
  ],
  beaded: (h, d) => [
    [0, 0], [0, 0.55 * d - E], [E, 0.55 * d], [0.55 * h, 0.55 * d],
    ...arc(0.775 * h, 0.55 * d, 0.225 * h, 0.45 * d, 180, 0, 12), [h, 0],
  ],
  simple: (h, d) => [[0, 0], [0, d - 2 * E], [2 * E, d], [h - 2 * E, d], [h, d - 2 * E], [h, 0]],  cap: flip(capMould),
  covebead: flip(coveBead),
  colonial: flip(colonial),
};
export const RAIL_NAMES = { classic: 'Classic', beaded: 'Beaded', simple: 'Square',
  cap: 'Base cap (sample 1)', covebead: 'Cove & bead (sample 2)', colonial: 'Colonial (sample 3)' };

// Baseboards: h = height, d = thickness. t = 0 is the floor.
export const BASE = {
  colonial: (h, d) => [
    [0, 0], [0, d], [0.62 * h, d], [0.62 * h, 0.86 * d], ...cyma(0.65 * h, 0.86 * d, 0.92 * h, 0.36 * d, 8),
    [0.92 * h, 0.28 * d], ...arc(h - 0.04 * h, 0.14 * d, 0.04 * h, 0.14 * d, 90, 0, 4), [h, 0],
  ],
  stepped: (h, d) => [
    [0, 0], [0, d], [0.7 * h, d], [0.7 * h, 0.7 * d], [0.84 * h, 0.7 * d],
    ...arc(h, 0.7 * d, 0.16 * h, 0.4 * d, 180, 270, 6), [h, 0],
  ],
  modern: (h, d) => [[0, 0], [0, d], [h - 2 * E, d], [h, d - 2 * E], [h, 0]],
};
export const BASE_NAMES = { colonial: 'Colonial', stepped: 'Stepped', modern: 'Square' };

// Crowns: h = drop down the wall, p = projection across the ceiling. Starts on the wall, ends on the ceiling.
export const CROWN = {
  ogee: (h, p) => [
    [0, 0], [0, 0.1 * p], [0.12 * h, 0.1 * p],
    ...arc(0.12 * h, 0.38 * p, 0.33 * h, 0.28 * p, 270, 360, 8),
    [0.45 * h, 0.46 * p], [0.5 * h, 0.46 * p],
    ...arc(0.9 * h, 0.46 * p, 0.4 * h, 0.46 * p, 180, 90, 10),
    [0.9 * h, p], [h, p],
  ],
  cove: (h, p) => [
    [0, 0], [0, 0.12 * p], [0.15 * h, 0.12 * p],
    ...arc(0.15 * h, 0.85 * p, 0.73 * h, 0.73 * p, 270, 360, 14),
    [0.88 * h, p], [h, p],
  ],
  modern: (h, p) => [[0, 0], [0, 0.15 * p], [0.15 * h, 0.15 * p], [0.85 * h, 0.85 * p], [0.85 * h, p], [h, p]],
};
export const CROWN_NAMES = { ogee: 'Ogee', cove: 'Cove', modern: 'Angled' };

// Door and window casing. t = 0 is the outside edge.
export const casing = (w, d) => [
  [0, 0], [0, d - E], [E, d], [0.22 * w, d], [0.28 * w, 0.82 * d], [0.78 * w, 0.62 * d],
  ...arc(0.87 * w, 0.62 * d, 0.09 * w, 0.2 * d, 180, 0, 6),
  [0.96 * w, 0.5 * d], [w, 0.5 * d], [w, 0],
];
