// Localise la zone d'illustration sur le scan de la carte.
//
// Scryfall fournit, pour chaque carte, le scan complet (png) ET un recadrage de l'illustration
// seule (art_crop). On retrouve où l'art_crop se situe dans le scan par corrélation croisée
// normalisée (NCC) : ça marche pour tous les cadres (moderne, ancien, planeswalker, saga…)
// sans avoir à connaître la géométrie de chacun. En cas d'échec, on se rabat sur des
// positions par défaut selon le type de cadre.

import { dims, makeCanvas } from './util.js';

// Positions par défaut (fractions de la carte) quand la détection échoue.
const FRAME_DEFAULTS = {
  2015: { x: 0.08, y: 0.113, w: 0.84, h: 0.44 },
  future: { x: 0.08, y: 0.113, w: 0.84, h: 0.44 },
  2003: { x: 0.085, y: 0.112, w: 0.83, h: 0.435 },
  1997: { x: 0.115, y: 0.098, w: 0.77, h: 0.43 },
  1993: { x: 0.115, y: 0.098, w: 0.77, h: 0.43 },
};

export function defaultRect(card, W, H) {
  const f = FRAME_DEFAULTS[card?.frame] || FRAME_DEFAULTS[2015];
  return { x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H };
}

// Image -> niveaux de gris (Float32Array) à la taille demandée.
function grayOf(img, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const g = new Float32Array(c.width * c.height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    // Les coins transparents du png comptent comme noirs.
    const a = data[i + 3] / 255;
    g[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a;
  }
  return { g, w: c.width, h: c.height };
}

// Image intégrale (somme cumulée) : moyenne de n'importe quel rectangle en O(1).
function integral(t) {
  const W = t.w + 1;
  const I = new Float64Array(W * (t.h + 1));
  for (let y = 0; y < t.h; y++) {
    let row = 0;
    for (let x = 0; x < t.w; x++) {
      row += t.g[y * t.w + x];
      I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row;
    }
  }
  return { I, w: t.w, h: t.h };
}

// Gabarit de l'illustration à la taille tw x th, échantillonné un pixel sur `step`,
// centré et normé pour la corrélation. Chaque échantillon est la moyenne de la zone
// correspondante de l'illustration (pas de crénelage).
function makeTemplate(A, tw, th, step) {
  const sx = A.w / tw;
  const sy = A.h / th;
  const W = A.w + 1;
  const xs = [];
  const ys = [];
  const vs = [];
  for (let y = 0; y < th; y += step) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(A.h, Math.floor((y + 1) * sy)));
    for (let x = 0; x < tw; x += step) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(A.w, Math.floor((x + 1) * sx)));
      const sum = A.I[y1 * W + x1] - A.I[y0 * W + x1] - A.I[y1 * W + x0] + A.I[y0 * W + x0];
      xs.push(x);
      ys.push(y);
      vs.push(sum / ((x1 - x0) * (y1 - y0)));
    }
  }
  const n = vs.length;
  const mean = vs.reduce((a, b) => a + b, 0) / n;
  let norm = 0;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = vs[i] - mean;
    norm += v[i] * v[i];
  }
  return { xs, ys, v, n, norm: Math.sqrt(norm) || 1, w: tw, h: th };
}

// Meilleure position du gabarit dans l'image, dans la fenêtre [x0..x1] x [y0..y1].
export function bestMatch(img, tpl, x0, x1, y0, y1) {
  const { g, w: W } = img;
  const { v, n, norm } = tpl;
  const off = new Int32Array(n);
  for (let i = 0; i < n; i++) off[i] = tpl.ys[i] * W + tpl.xs[i];
  let best = { score: -Infinity, x: 0, y: 0 };
  const xMax = Math.min(x1, img.w - tpl.w);
  const yMax = Math.min(y1, img.h - tpl.h);
  for (let y = Math.max(0, y0); y <= yMax; y++) {
    for (let x = Math.max(0, x0); x <= xMax; x++) {
      const base = y * W + x;
      let s = 0;
      let s2 = 0;
      let st = 0;
      for (let i = 0; i < n; i++) {
        const p = g[base + off[i]];
        s += p;
        s2 += p * p;
        st += p * v[i];
      }
      const varI = s2 - (s * s) / n;
      if (varI <= 1e-6) continue;
      const score = st / (Math.sqrt(varI) * norm);
      if (score > best.score) best = { score, x, y };
    }
  }
  return best;
}

// Retourne { rect, score } en pixels du scan, ou null si rien de convaincant.
// Recherche en pyramide : carte à 60 px (toutes positions, toutes tailles), puis 180 px et 420 px
// (affinage local de la position puis de la taille).
export function detectArtRect(cardImg, artImg) {
  const { w: W, h: H } = dims(cardImg);
  const { w: aw, h: ah } = dims(artImg);
  const aspect = aw / ah;
  const artW = Math.min(aw, 440);
  const A = integral(grayOf(artImg, artW, artW / aspect));
  const levels = [60, 180, 420].map((px) => {
    const k = Math.min(1, px / W);
    return { k, img: grayOf(cardImg, W * k, H * k) };
  });

  // 1) Niveau grossier : l'illustration commence toujours dans la moitié haute / gauche de la carte.
  const L0 = levels[0].img;
  let best = { score: -Infinity };
  for (let frac = 0.38; frac <= 0.97; frac += 0.035) {
    const tw = Math.round(frac * L0.w);
    const th = Math.round(tw / aspect);
    if (th >= L0.h * 0.95 || tw < 8 || th < 6) continue;
    const m = bestMatch(L0, makeTemplate(A, tw, th, 2), 0, Math.round(L0.w * 0.5), 0, Math.round(L0.h * 0.6));
    if (m.score > best.score) best = { ...m, frac };
  }
  if (!(best.score > 0.3)) return null;

  // 2) Affinage niveau par niveau.
  const plans = [
    { span: 0.03, fstep: 0.0075, step: 3 },
    { span: 0.006, fstep: 0.0015, step: 4 },
  ];
  for (let li = 1; li < levels.length; li++) {
    const { img } = levels[li];
    const P = plans[li - 1];
    const r = levels[li].k / levels[li - 1].k;
    const at = (frac, cx, cy, rad) => {
      const tw = Math.round(frac * img.w);
      const th = Math.round(tw / aspect);
      if (th >= img.h || tw < 10) return { score: -Infinity };
      return { ...bestMatch(img, makeTemplate(A, tw, th, P.step), cx - rad, cx + rad, cy - rad, cy + rad), tw, th, frac };
    };
    let cur = at(best.frac, Math.round(best.x * r), Math.round(best.y * r), 4);
    const pos = { x: cur.x, y: cur.y };
    for (let frac = best.frac - P.span; frac <= best.frac + P.span + 1e-9; frac += P.fstep) {
      const m = at(frac, pos.x, pos.y, 2);
      if (m.score > cur.score) cur = m;
    }
    const again = at(cur.frac, cur.x, cur.y, 2);
    best = again.score > cur.score ? again : cur;
  }
  if (!(best.score > 0.5)) return null;

  // L'art_crop de Scryfall est rogné légèrement à l'intérieur de la fenêtre d'illustration :
  // on élargit d'environ 2 px (sur 745) pour ne pas laisser dépasser un liseré de l'art d'origine.
  const k = levels[levels.length - 1].k;
  const m = W * 0.003;
  const x = Math.max(0, best.x / k - m);
  const y = Math.max(0, best.y / k - m);
  return {
    score: best.score,
    rect: { x, y, w: Math.min(W - x, best.tw / k + 2 * m), h: Math.min(H - y, best.th / k + 2 * m) },
  };
}
