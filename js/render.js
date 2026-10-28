// Rendu d'une carte : scan officiel + nouvelle illustration dans la zone d'art.

import { dims, makeCanvas, downscale } from './util.js';

// Où dessiner l'illustration (mode « cover » + zoom + décalage) dans la zone d'art.
export function artPlacement(rect, art, zoom, offX, offY) {
  const { w: aw, h: ah } = dims(art);
  const cover = Math.max(rect.w / aw, rect.h / ah) * zoom;
  const dw = aw * cover;
  const dh = ah * cover;
  const { offX: ox, offY: oy } = clampOffsets(rect, dw, dh, offX, offY);
  return {
    dx: rect.x + rect.w / 2 + ox * rect.w - dw / 2,
    dy: rect.y + rect.h / 2 + oy * rect.h - dh / 2,
    dw,
    dh,
    offX: ox,
    offY: oy,
  };
}

// L'image doit toujours couvrir toute la zone : on borne le décalage.
export function clampOffsets(rect, dw, dh, offX, offY) {
  const mx = Math.max(0, (dw - rect.w) / 2 / rect.w);
  const my = Math.max(0, (dh - rect.h) / 2 / rect.h);
  return { offX: Math.min(mx, Math.max(-mx, offX)), offY: Math.min(my, Math.max(-my, offY)) };
}

// Couleur de bordure (milieu du bord gauche), pour remplir les coins arrondis à l'impression.
export function sampleBorderColor(base) {
  const { w, h } = dims(base);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(base, 0, 0);
  const x = Math.max(1, Math.round(w * 0.012));
  const y = Math.round(h * 0.5);
  const d = ctx.getImageData(x - 1, y - 1, 3, 3).data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
  }
  return [Math.round(r / 9), Math.round(g / 9), Math.round(b / 9)];
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const luminance = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

/**
 * s = { base, rect, art, zoom, offX, offY, outline, proxyMark, borderColor }
 * opts.fillCorners : remplit les coins arrondis transparents (pour JPEG / impression).
 */
export function renderCard(canvas, s, { fillCorners = false } = {}) {
  const { w: W, h: H } = dims(s.base);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (fillCorners) {
    // Coins arrondis (rayon 3 mm sur 63 mm) remplis de la couleur de bordure, que le scan soit
    // un PNG à coins transparents ou un JPEG à coins blancs.
    ctx.fillStyle = rgb(s.borderColor || [0, 0, 0]);
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    roundRectPath(ctx, 0, 0, W, H, W * 0.0476);
    ctx.clip();
    ctx.drawImage(s.base, 0, 0, W, H);
    ctx.restore();
  } else {
    ctx.drawImage(s.base, 0, 0, W, H);
  }

  if (s.art && s.rect) {
    const r = s.rect;
    const p = artPlacement(r, s.art, s.zoom || 1, s.offX || 0, s.offY || 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.art, p.dx, p.dy, p.dw, p.dh);
    ctx.restore();
    if (s.outline) {
      // Fin liseré sombre : imite le biseau du cadre et masque les raccords.
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(1, W * 0.002);
      ctx.strokeRect(r.x + ctx.lineWidth / 2, r.y + ctx.lineWidth / 2, r.w - ctx.lineWidth, r.h - ctx.lineWidth);
      ctx.restore();
    }
  }

  if (s.proxyMark) drawProxyMark(ctx, W, H, s.borderColor || [0, 0, 0]);
  return canvas;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawProxyMark(ctx, W, H, border) {
  ctx.save();
  const size = Math.round(H * 0.0125);
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = luminance(border) < 0.5 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.75)';
  ctx.fillText('PROXY', W / 2, H - H * 0.0085);
  ctx.restore();
}

// ---------- Retouches de l'illustration (sans IA) ----------

function channelStats(data) {
  const n = data.length / 4;
  const mean = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      mean[c] += data[i + c];
      sq[c] += data[i + c] * data[i + c];
    }
  }
  return mean.map((m, c) => {
    const mu = m / n;
    return { mean: mu, std: Math.sqrt(Math.max(1, sq[c] / n - mu * mu)) };
  });
}

const refStatsCache = new WeakMap();

function statsOf(img) {
  if (refStatsCache.has(img)) return refStatsCache.get(img);
  const small = downscale(img, 160);
  const d = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
  const st = channelStats(d);
  refStatsCache.set(img, st);
  return st;
}

/**
 * Applique luminosité / contraste / saturation (-100..100) et « harmonie » (0..100) :
 * l'harmonie transfère la colorimétrie de l'illustration originale vers la photo
 * (moyenne / écart-type par canal), pour qu'elle se fonde mieux dans la carte.
 */
export function adjustArt(src, adj, refArt, maxDim = 1600) {
  const c = downscale(src, maxDim);
  const { b = 0, c: con = 0, s: sat = 0, harmony = 0 } = adj || {};
  if (!b && !con && !sat && !(harmony && refArt)) return c;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;

  let tr = null;
  if (harmony && refArt) {
    const from = statsOf(c);
    const to = statsOf(refArt);
    const k = harmony / 100;
    tr = from.map((f, i) => ({ f, t: to[i], k }));
  }
  const bright = b * 1.28;
  const cf = (259 * (con * 1.28 + 255)) / (255 * (259 - con * 1.28));
  const sf = 1 + sat / 100;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let bl = d[i + 2];
    if (tr) {
      r = r + tr[0].k * (((r - tr[0].f.mean) / tr[0].f.std) * tr[0].t.std + tr[0].t.mean - r);
      g = g + tr[1].k * (((g - tr[1].f.mean) / tr[1].f.std) * tr[1].t.std + tr[1].t.mean - g);
      bl = bl + tr[2].k * (((bl - tr[2].f.mean) / tr[2].f.std) * tr[2].t.std + tr[2].t.mean - bl);
    }
    r = cf * (r + bright - 128) + 128;
    g = cf * (g + bright - 128) + 128;
    bl = cf * (bl + bright - 128) + 128;
    if (sf !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = l + (r - l) * sf;
      g = l + (g - l) * sf;
      bl = l + (bl - l) * sf;
    }
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = bl;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
