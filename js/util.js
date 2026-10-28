// Petits utilitaires partagés : DOM, stockage, images, partage de fichiers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Crée un élément : h('div', {class: 'x', onclick: fn}, 'texte', autreElement)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer;
export function toast(msg, type = 'info', ms = 3500) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), ms);
}

// localStorage peut être indisponible (navigation privée, données bloquées) : on ne plante jamais.
export const storage = {
  get(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* stockage indisponible */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* stockage indisponible */
    }
  },
};

// ---------- Images ----------

export function dims(img) {
  return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
}

export async function blobToImage(blob) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* repli sur <img> ci-dessous (ex. HEIC sur certains navigateurs) */
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Format d'image non pris en charge par ce navigateur.");
  }
  return img;
}

// Les images Scryfall sont servies avec CORS : on les récupère en blob pour pouvoir
// les dessiner dans un canvas puis exporter le résultat.
export async function fetchImage(url, signal) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error("Impossible de télécharger l'image de la carte (réseau ou CORS).");
  }
  if (!res.ok) throw new Error(`Image indisponible (${res.status}).`);
  const blob = await res.blob();
  return { blob, img: await blobToImage(blob) };
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Réduit une image pour qu'aucun côté ne dépasse maxDim (garde les photos de 12+ Mpx raisonnables).
export function downscale(img, maxDim) {
  const { w, h } = dims(img);
  const k = Math.min(1, maxDim / Math.max(w, h));
  const c = makeCanvas(w * k, h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export image impossible.'))), type, quality);
    } catch (e) {
      reject(e);
    }
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64, type = 'image/png') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Partage natif sur téléphone (feuille de partage iOS / Android), téléchargement sinon.
// Retourne 'shared', 'cancelled', 'downloaded' ou 'blocked' (partage refusé faute de geste récent).
export async function shareFiles(files, { title, forceDownloadOnBlock = false } = {}) {
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      if (e.name === 'NotAllowedError' && !forceDownloadOnBlock) return 'blocked';
      /* sinon on retombe sur le téléchargement */
    }
  }
  for (const f of files) download(f, f.name);
  return 'downloaded';
}

export function toFile(blob, filename) {
  return new File([blob], filename, { type: blob.type });
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// ---------- IndexedDB (planche d'impression, brouillon) ----------

const DB_NAME = 'proxy-forge';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB indisponible'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transaction annulée'));
      }),
  );
}

export const idb = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, val, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
