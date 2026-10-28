import {
  $, $$, h, debounce, toast, storage, dims, blobToImage, fetchImage, makeCanvas, downscale,
  canvasToBlob, shareFiles, toFile, slug, idb, uid,
} from './util.js';
import * as sf from './scryfall.js';
import { detectArtRect, defaultRect } from './artbox.js';
import { renderCard, artPlacement, sampleBorderColor, adjustArt } from './render.js';
import * as ai from './ai.js';
import * as hf from './hf.js';
import { buildPdf, PER_PAGE } from './pdf.js';
import { parseDecklist, matchEntry, norm } from './decklist.js';

// ============================================================
// Réglages (stockés sur l'appareil)
// ============================================================

const settings = {
  provider: 'gemini',
  keys: { gemini: '', openai: '' },
  model: { gemini: 'auto', openai: 'auto' },
  models: { gemini: [], openai: [] },
  quality: 'medium',
  engine: 'free', // moteur du bouton « Générer » : 'free' (Hugging Face), 'gemini' ou 'openai'
  hfToken: '',
  hfSpace: '', // vide = choix automatique
  hfCtx: null, // dernier Space utilisable trouvé (évite de le rechercher à chaque fois)
  lang: 'fr',
  proxyMark: true,
  ...storage.get('pf-settings', {}),
};
const saveSettings = () => storage.set('pf-settings', settings);
const langName = (code) => sf.LANGS.find(([c]) => c === code)?.[1] || code;

// ============================================================
// Navigation par onglets (#search, #editor, #sheet, #settings)
// ============================================================

const VIEWS = ['search', 'editor', 'sheet', 'settings'];

function show(view) {
  if (!VIEWS.includes(view)) view = 'search';
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === view));
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'sheet') renderSheet();
  if (view === 'editor') refreshAiPanel();
}
function go(view) {
  if (location.hash === `#${view}`) show(view);
  else location.hash = view;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(location.hash.slice(1)));

// ============================================================
// Recherche
// ============================================================

const qInput = $('#q');
const sugList = $('#suggestions');
let acCtrl = null;
let sugItems = [];
let sugActive = -1;

function hideSuggestions() {
  sugList.hidden = true;
  sugList.replaceChildren();
  sugItems = [];
  sugActive = -1;
}

function showSuggestions(items) {
  sugItems = items;
  sugActive = -1;
  if (!items.length) return hideSuggestions();
  sugList.replaceChildren(
    ...items.map((it, i) =>
      h('li', { role: 'option' },
        h('button', { type: 'button', 'data-i': i, onclick: () => pickSuggestion(it) },
          h('span', {}, it.label),
          it.sub && it.sub !== it.label ? h('span', { class: 'sub' }, it.sub) : null,
          it.lang ? h('span', { class: 'lang' }, it.lang) : null,
        ),
      ),
    ),
  );
  sugList.hidden = false;
}

const suggest = debounce(async (text) => {
  acCtrl?.abort();
  if (text.length < 2) return hideSuggestions();
  acCtrl = new AbortController();
  const { signal } = acCtrl;
  try {
    const wantLocal = text.length >= 3 && settings.lang !== 'en';
    const [en, local] = await Promise.all([
      sf.autocomplete(text, signal),
      wantLocal ? sf.searchLocalized(text, settings.lang, signal).catch(() => []) : [],
    ]);
    if (signal.aborted) return;
    const items = [];
    const seen = new Set();
    for (const c of local) {
      if (seen.has(c.name) || items.length >= 6) continue;
      seen.add(c.name);
      items.push({ label: sf.displayName(c), sub: c.name, lang: c.lang, card: c });
    }
    for (const name of en) {
      if (seen.has(name) || items.length >= 12) continue;
      seen.add(name);
      items.push({ label: name, name });
    }
    if (qInput.value.trim() === text) showSuggestions(items);
  } catch (e) {
    if (e.name !== 'AbortError') console.warn(e);
  }
}, 250);

qInput.addEventListener('input', () => suggest(qInput.value.trim()));
qInput.addEventListener('keydown', (e) => {
  if (sugList.hidden || !sugItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugActive = (sugActive + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
    $$('button', sugList).forEach((b, i) => b.classList.toggle('active', i === sugActive));
  } else if (e.key === 'Enter' && sugActive >= 0) {
    e.preventDefault();
    pickSuggestion(sugItems[sugActive]);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#suggestions, #q')) hideSuggestions();
});

async function pickSuggestion(it) {
  hideSuggestions();
  acCtrl?.abort();
  try {
    if (it.card) return openCard(it.card, it.card.lang);
    const card = await sf.named(it.name);
    if (!card) throw new Error('Carte introuvable.');
    openCard(card, settings.lang);
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(buildQuery());
});

// ----- Filtres -----

const filtersForm = $('#filters');
$('#btn-filters').addEventListener('click', () => {
  filtersForm.hidden = !filtersForm.hidden;
  $('#btn-filters').setAttribute('aria-expanded', String(!filtersForm.hidden));
});
$$('#f-colors .mana').forEach((b) =>
  b.addEventListener('click', () => {
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    updateFilterCount();
  }),
);
filtersForm.addEventListener('input', updateFilterCount);
filtersForm.addEventListener('reset', () => {
  $$('#f-colors .mana').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  setTimeout(updateFilterCount);
});
filtersForm.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(buildQuery());
});

function filterParts() {
  const parts = [];
  const colors = $$('#f-colors .mana[aria-pressed="true"]').map((b) => b.dataset.c);
  const mode = $('#f-color-mode').value;
  const wubrg = colors.filter((c) => c !== 'c');
  if (wubrg.length) parts.push(`${mode}${wubrg.join('')}`);
  else if (colors.includes('c')) parts.push(mode.startsWith('id') ? 'id=c' : 'c=c');
  const type = $('#f-type').value;
  if (type) parts.push(`t:${type}`);
  if ($('#f-legendary').checked) parts.push('t:legendary');
  const rarity = $('#f-rarity').value;
  if (rarity) parts.push(`r:${rarity}`);
  const mv = $('#f-mv').value.trim();
  if (mv !== '') parts.push(`mv${$('#f-mv-op').value}${Number(mv)}`);
  const set = $('#f-set').value.trim();
  if (set) parts.push(`s:${set}`);
  const oracle = $('#f-oracle').value.trim();
  if (oracle) parts.push(`o:"${oracle.replace(/"/g, '')}"`);
  const raw = $('#f-raw').value.trim();
  if (raw) parts.push(raw);
  return parts;
}

function updateFilterCount() {
  const n = filterParts().length;
  const el = $('#filter-count');
  el.hidden = !n;
  el.textContent = n;
}

function buildQuery() {
  return [qInput.value.trim(), ...filterParts()].filter(Boolean).join(' ');
}

// ----- Résultats -----

let nextPageUrl = null;

async function runSearch(q) {
  hideSuggestions();
  if (!q) return toast('Saisis un nom ou choisis au moins un filtre.');
  const info = $('#results-info');
  info.hidden = false;
  info.textContent = 'Recherche…';
  $('#search-intro').hidden = true;
  try {
    let res = await sf.search(q);
    if (!res.data.length && settings.lang !== 'en') res = await sf.search(`${q} lang:${settings.lang}`);
    nextPageUrl = res.has_more ? res.next_page : null;
    $('#results').replaceChildren();
    appendResults(res.data);
    info.textContent = res.total_cards
      ? `${res.total_cards} carte${res.total_cards > 1 ? 's' : ''}`
      : 'Aucune carte trouvée. Essaie un autre nom ou moins de filtres.';
  } catch (e) {
    info.textContent = e.message;
  }
  $('#btn-more').hidden = !nextPageUrl;
}

function cardThumb(card, size = 'normal') {
  const f = sf.faces(card)[0];
  return f?.image_uris?.[size] || f?.image_uris?.normal || '';
}

function appendResults(cards) {
  $('#results').append(
    ...cards.map((c) =>
      h('button', { type: 'button', class: 'card-tile', onclick: () => openCard(c, c.lang === 'en' ? settings.lang : c.lang) },
        h('img', { src: cardThumb(c), alt: sf.displayName(c), loading: 'lazy', crossorigin: 'anonymous' }),
        h('span', {}, sf.displayName(c)),
      ),
    ),
  );
}

$('#btn-more').addEventListener('click', async () => {
  if (!nextPageUrl) return;
  try {
    const res = await sf.nextPage(nextPageUrl);
    nextPageUrl = res?.has_more ? res.next_page : null;
    appendResults(res?.data || []);
  } catch (e) {
    toast(e.message, 'error');
  }
  $('#btn-more').hidden = !nextPageUrl;
});

$('#btn-random').addEventListener('click', async () => {
  try {
    const card = await sf.random(filterParts().join(' '));
    if (!card) throw new Error('Aucune carte ne correspond aux filtres.');
    openCard(card, settings.lang);
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ============================================================
// Éditeur
// ============================================================

const preview = $('#preview');
const ed = {
  oracleId: null,
  lang: 'en',
  prints: [],
  print: null,
  face: 0,
  base: null,
  origArt: null,
  origArtUrl: '',
  borderColor: [0, 0, 0],
  rect: null,
  rectAuto: null,
  sources: [], // { id, kind: 'photo'|'ai', blob, img, label }
  active: null, // id de la source utilisée, null = illustration d'origine
  artCanvas: null,
  zoom: 1,
  offX: 0,
  offY: 0,
  adj: { b: 0, c: 0, s: 0, harmony: 0 },
  outline: true,
  proxyMark: settings.proxyMark,
  qty: 1,
  mode: 'image',
  editingId: null,
  loadToken: 0,
  aiPreset: 'style',
};

function activeSource() {
  return ed.sources.find((s) => s.id === ed.active) || null;
}

function setLoading(on) {
  $('#preview-loading').hidden = !on;
}

async function openCard(card, lang) {
  $('#editor-empty').hidden = true;
  $('#editor').hidden = false;
  go('editor');
  ed.editingId = null;
  ed.qty = 1;
  $('#ed-qty').textContent = '1';
  updateAddButton();
  // Les photos déjà ajoutées restent disponibles, mais on repart de l'illustration d'origine.
  ed.active = null;
  ed.zoom = 1;
  ed.offX = 0;
  ed.offY = 0;
  syncSliders();
  ed.oracleId = sf.oracleIdOf(card);
  ed.print = card;
  showTitle();
  await loadLang(lang || settings.lang, card);
}

async function loadLang(lang, prefer) {
  setLoading(true);
  try {
    let list = await sf.prints(ed.oracleId, lang);
    if (!list.length && lang !== 'en') {
      toast(`Pas de version « ${langName(lang)} » pour cette carte : version anglaise utilisée.`);
      lang = 'en';
      list = await sf.prints(ed.oracleId, 'en');
    }
    if (!list.length && prefer) list = [prefer];
    ed.lang = lang;
    ed.prints = list;
    renderLangSelect();
    const pick = (prefer && list.find((c) => c.id === prefer.id)) || sf.bestPrint(list);
    await selectPrint(pick, ed.face);
  } catch (e) {
    toast(e.message, 'error');
    setLoading(false);
  }
}

async function selectPrint(card, face = 0, { rect } = {}) {
  ed.print = card;
  const n = sf.faces(card).length;
  ed.face = Math.min(face, n - 1);
  renderPrints();
  renderFaceSelect();
  showTitle();
  await loadBase({ rect });
  saveDraft();
}

function showTitle() {
  const c = ed.print;
  if (!c) return;
  const f = sf.faces(c)[ed.face] || {};
  $('#ed-name').textContent = f.printed_name || f.name || sf.displayName(c);
  $('#ed-sub').textContent = [c.set_name, `#${c.collector_number}`, (c.lang || '').toUpperCase(), c.released_at?.slice(0, 4)]
    .filter(Boolean)
    .join(' · ');
}

function renderLangSelect() {
  const sel = $('#ed-lang');
  sel.replaceChildren(...sf.LANGS.map(([code, name]) => h('option', { value: code, selected: code === ed.lang }, name)));
}
$('#ed-lang').addEventListener('change', (e) => loadLang(e.target.value, null));

function renderPrints() {
  const wrap = $('#ed-prints');
  wrap.replaceChildren(
    ...ed.prints.map((c) =>
      h('button', {
        type: 'button',
        class: `pr${c.id === ed.print?.id ? ' on' : ''}${sf.isRiskyFrame(c) ? ' risky' : ''}`,
        title: `${c.set_name} (${c.released_at?.slice(0, 4) || ''})`,
        onclick: () => c.id !== ed.print?.id && selectPrint(c, ed.face),
      },
        h('img', { src: cardThumb(c, 'small'), alt: c.set_name, loading: 'lazy', crossorigin: 'anonymous' }),
        h('span', {}, `${c.set.toUpperCase()} ${c.released_at?.slice(2, 4) ? `’${c.released_at.slice(2, 4)}` : ''}`),
      ),
    ),
  );
  $('#ed-print-count').textContent = ed.prints.length > 1 ? `${ed.prints.length} versions` : '';
  const on = wrap.querySelector('.on');
  if (on) wrap.scrollLeft = on.offsetLeft - wrap.clientWidth / 2 + on.clientWidth / 2;
}

function renderFaceSelect() {
  const fs = sf.faces(ed.print);
  $('#ed-face-wrap').hidden = fs.length < 2;
  $('#ed-face').replaceChildren(
    ...fs.map((f, i) => h('option', { value: i, selected: i === ed.face }, `${i ? 'Verso' : 'Recto'} – ${f.printed_name || f.name}`)),
  );
}
$('#ed-face').addEventListener('change', (e) => selectPrint(ed.print, Number(e.target.value)));

async function loadBase({ rect } = {}) {
  const token = ++ed.loadToken;
  setLoading(true);
  const f = sf.faces(ed.print)[ed.face];
  try {
    const baseUrl = f.image_uris.png || f.image_uris.large || f.image_uris.normal;
    const artUrl = f.image_uris.art_crop;
    const [base, art] = await Promise.all([fetchImage(baseUrl), artUrl ? fetchImage(artUrl).catch(() => null) : null]);
    if (token !== ed.loadToken) return;
    ed.base = base.img;
    ed.origArt = art?.img || null;
    ed.origArtUrl = artUrl || '';
    ed.borderColor = sampleBorderColor(ed.base);
    const { w: W, h: H } = dims(ed.base);

    await new Promise((r) => requestAnimationFrame(r));
    const det = ed.origArt ? detectArtRect(ed.base, ed.origArt) : null;
    if (token !== ed.loadToken) return;
    ed.rectAuto = det?.rect || defaultRect(ed.print, W, H);
    ed.rect = rect ? { ...rect } : { ...ed.rectAuto };

    const warn = [];
    if (sf.isRiskyFrame(ed.print)) {
      warn.push('Cette édition est sans bordure ou « full art » : l’illustration déborde sous le texte, le remplacement sera imparfait. Choisis plutôt une édition classique.');
    }
    if (!det) warn.push('Zone d’illustration estimée automatiquement : vérifie-la avec « Ajuster la zone ».');
    $('#ed-warning').hidden = !warn.length;
    $('#ed-warning').textContent = warn.join(' ');

    processArt();
    renderSources();
  } catch (e) {
    if (token === ed.loadToken) toast(e.message, 'error');
  } finally {
    if (token === ed.loadToken) setLoading(false);
  }
}

// ----- Rendu -----

function renderState() {
  return {
    base: ed.base,
    rect: ed.rect,
    art: activeSource() ? ed.artCanvas : null,
    zoom: ed.zoom,
    offX: ed.offX,
    offY: ed.offY,
    outline: ed.outline,
    proxyMark: ed.proxyMark,
    borderColor: ed.borderColor,
  };
}

let drawPending = false;
function draw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    if (!ed.base) return;
    renderCard(preview, renderState());
    positionZone();
  });
}

function processArt() {
  refreshGemini();
  const src = activeSource();
  ed.artCanvas = src ? adjustArt(src.img, ed.adj, ed.origArt) : null;
  $('#art-controls').hidden = !src;
  $('#zoom-row').hidden = !src;
  preview.classList.toggle('grab', !!src || ed.mode === 'zone');
  updateModeHint();
  draw();
}
const processArtSoon = debounce(processArt, 60);

// ----- Sources d'illustration (photo, résultats IA) -----

function renderSources() {
  const wrap = $('#ed-sources');
  const items = [
    h('button', { type: 'button', class: `src${ed.active ? '' : ' on'}`, onclick: () => setActive(null) },
      ed.origArtUrl ? h('img', { src: ed.origArtUrl, alt: '', crossorigin: 'anonymous' }) : h('img', { alt: '' }),
      h('span', {}, 'Original'),
    ),
  ];
  for (const s of ed.sources) {
    const thumb = downscale(s.img, 200);
    items.push(
      h('div', { class: `src${s.id === ed.active ? ' on' : ''}`, role: 'button', tabindex: '0', onclick: () => setActive(s.id) },
        thumb,
        h('span', {}, s.label),
        h('button', {
          type: 'button',
          class: 'del',
          'aria-label': `Retirer ${s.label}`,
          onclick: (e) => {
            e.stopPropagation();
            removeSource(s.id);
          },
        }, '×'),
      ),
    );
  }
  wrap.replaceChildren(...items);
}

function setActive(id) {
  if (ed.active === id) return;
  ed.active = id;
  ed.zoom = 1;
  ed.offX = 0;
  ed.offY = 0;
  $('#ed-zoom').value = 1;
  renderSources();
  processArt();
  saveDraft();
}

function removeSource(id) {
  ed.sources = ed.sources.filter((s) => s.id !== id);
  if (ed.active === id) setActive(ed.sources.at(-1)?.id || null);
  else renderSources();
  saveDraft();
}

async function addSource(blob, kind, label) {
  const img = await blobToImage(blob);
  const s = { id: uid(), kind, blob, img, label };
  ed.sources.push(s);
  // Nouvelle image = on repart de réglages neutres.
  ed.adj = { b: 0, c: 0, s: 0, harmony: 0 };
  syncSliders();
  setActive(s.id);
  return s;
}

// Photo du téléphone ou image créée dans l'app Gemini.
async function importImage(input, kind, label, message) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  setLoading(true);
  try {
    // On ré-encode en JPEG raisonnable : plus léger à stocker et à envoyer à l'IA.
    const img = await blobToImage(file);
    const blob = await canvasToBlob(downscale(img, 2048), 'image/jpeg', 0.92);
    const n = ed.sources.filter((s) => s.label.startsWith(label)).length + 1;
    await addSource(blob, kind, n > 1 ? `${label} ${n}` : label);
    toast(message, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}
$('#ed-file').addEventListener('change', (e) =>
  importImage(e.target, 'photo', 'Photo', 'Photo ajoutée : fais-la glisser pour la cadrer.'),
);

// ----- Réglages de l'illustration -----

const sliders = { b: '#ed-b', c: '#ed-c', s: '#ed-s', harmony: '#ed-harmony' };
for (const [k, sel] of Object.entries(sliders)) {
  $(sel).addEventListener('input', (e) => {
    ed.adj[k] = Number(e.target.value);
    processArtSoon();
    saveDraft();
  });
}
function syncSliders() {
  for (const [k, sel] of Object.entries(sliders)) $(sel).value = ed.adj[k] || 0;
  $('#ed-zoom').value = ed.zoom;
}
$('#ed-reset-adj').addEventListener('click', () => {
  ed.adj = { b: 0, c: 0, s: 0, harmony: 0 };
  syncSliders();
  processArt();
  saveDraft();
});
$('#ed-zoom').addEventListener('input', (e) => {
  ed.zoom = Number(e.target.value);
  clampView();
  draw();
  saveDraft();
});
$('#ed-recenter').addEventListener('click', () => {
  ed.zoom = 1;
  ed.offX = 0;
  ed.offY = 0;
  syncSliders();
  draw();
  saveDraft();
});
$('#ed-proxy').addEventListener('change', (e) => {
  ed.proxyMark = e.target.checked;
  draw();
});
$('#ed-outline').addEventListener('change', (e) => {
  ed.outline = e.target.checked;
  draw();
});

function clampView() {
  if (!ed.artCanvas || !ed.rect) return;
  const p = artPlacement(ed.rect, ed.artCanvas, ed.zoom, ed.offX, ed.offY);
  ed.offX = p.offX;
  ed.offY = p.offY;
}

// ----- Gestes sur l'aperçu : glisser / pincer pour cadrer l'image -----

const pointers = new Map();
let gesture = null;

function toCardPx() {
  return dims(ed.base).w / preview.getBoundingClientRect().width;
}

function startGesture() {
  const pts = [...pointers.values()];
  gesture = {
    zoom: ed.zoom,
    offX: ed.offX,
    offY: ed.offY,
    cx: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    cy: pts.reduce((a, p) => a + p.y, 0) / pts.length,
    dist: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
  };
}

preview.addEventListener('pointerdown', (e) => {
  if (ed.mode !== 'image' || !ed.artCanvas) return;
  preview.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  startGesture();
});
preview.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pts = [...pointers.values()];
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const k = toCardPx();
  if (pts.length > 1 && gesture.dist) {
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    ed.zoom = Math.min(4, Math.max(1, (gesture.zoom * dist) / gesture.dist));
    $('#ed-zoom').value = ed.zoom;
  }
  ed.offX = gesture.offX + ((cx - gesture.cx) * k) / ed.rect.w;
  ed.offY = gesture.offY + ((cy - gesture.cy) * k) / ed.rect.h;
  clampView();
  draw();
});
function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size) startGesture();
  else {
    gesture = null;
    saveDraft();
  }
}
preview.addEventListener('pointerup', endPointer);
preview.addEventListener('pointercancel', endPointer);
preview.addEventListener(
  'wheel',
  (e) => {
    if (ed.mode !== 'image' || !ed.artCanvas) return;
    e.preventDefault();
    ed.zoom = Math.min(4, Math.max(1, ed.zoom * Math.exp(-e.deltaY * 0.0015)));
    $('#ed-zoom').value = ed.zoom;
    clampView();
    draw();
  },
  { passive: false },
);

// ----- Mode « Ajuster la zone » : cadre déplaçable / redimensionnable -----

const zone = $('#zone');

$$('#mode-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    ed.mode = b.dataset.mode;
    $$('#mode-seg button').forEach((x) => x.classList.toggle('on', x === b));
    zone.hidden = ed.mode !== 'zone';
    preview.classList.toggle('grab', ed.mode === 'zone' || !!ed.artCanvas);
    updateModeHint();
    positionZone();
  }),
);

function updateModeHint() {
  const el = $('#mode-hint');
  if (ed.mode === 'zone') {
    el.replaceChildren(
      'Fais glisser le cadre ou ses coins. ',
      h('button', { type: 'button', class: 'btn small ghost', onclick: resetZone }, 'Zone automatique'),
    );
  } else {
    el.textContent = activeSource() ? 'Glisse pour cadrer, pince (ou molette) pour zoomer.' : '';
  }
}

function resetZone() {
  if (!ed.rectAuto) return;
  ed.rect = { ...ed.rectAuto };
  clampView();
  draw();
  saveDraft();
}

function positionZone() {
  if (zone.hidden || !ed.rect || !ed.base) return;
  const { w: W, h: H } = dims(ed.base);
  zone.style.left = `${(ed.rect.x / W) * 100}%`;
  zone.style.top = `${(ed.rect.y / H) * 100}%`;
  zone.style.width = `${(ed.rect.w / W) * 100}%`;
  zone.style.height = `${(ed.rect.h / H) * 100}%`;
}

let zoneDrag = null;
zone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  zone.setPointerCapture(e.pointerId);
  zoneDrag = { handle: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, rect: { ...ed.rect } };
});
zone.addEventListener('pointermove', (e) => {
  if (!zoneDrag) return;
  const k = toCardPx();
  const dx = (e.clientX - zoneDrag.x) * k;
  const dy = (e.clientY - zoneDrag.y) * k;
  const { w: W, h: H } = dims(ed.base);
  const r0 = zoneDrag.rect;
  let { x, y, w, h: hh } = r0;
  const min = 40;
  if (zoneDrag.handle === 'move') {
    x = Math.min(W - w, Math.max(0, r0.x + dx));
    y = Math.min(H - hh, Math.max(0, r0.y + dy));
  } else {
    const hd = zoneDrag.handle;
    if (hd.includes('w')) {
      x = Math.min(r0.x + r0.w - min, Math.max(0, r0.x + dx));
      w = r0.x + r0.w - x;
    }
    if (hd.includes('e')) w = Math.min(W - r0.x, Math.max(min, r0.w + dx));
    if (hd.includes('n')) {
      y = Math.min(r0.y + r0.h - min, Math.max(0, r0.y + dy));
      hh = r0.y + r0.h - y;
    }
    if (hd.includes('s')) hh = Math.min(H - r0.y, Math.max(min, r0.h + dy));
  }
  ed.rect = { x, y, w, h: hh };
  clampView();
  draw();
});
function endZone() {
  if (!zoneDrag) return;
  zoneDrag = null;
  saveDraft();
}
zone.addEventListener('pointerup', endZone);
zone.addEventListener('pointercancel', endZone);

// ----- Quantité, ajout à la planche, partage -----

$$('.action-bar .qty button').forEach((b) =>
  b.addEventListener('click', () => {
    ed.qty = Math.max(1, Math.min(99, ed.qty + Number(b.dataset.d)));
    $('#ed-qty').textContent = ed.qty;
  }),
);

function updateAddButton() {
  $('#ed-add').replaceChildren(
    ...(ed.editingId ? ['Mettre à jour'] : ['Ajouter', h('span', { class: 'wide-only' }, 'à la planche')]),
  );
}

function itemName() {
  const f = sf.faces(ed.print)[ed.face] || {};
  return f.printed_name || f.name || sf.displayName(ed.print);
}

$('#ed-add').addEventListener('click', async () => {
  if (!ed.base) return;
  const btn = $('#ed-add');
  btn.disabled = true;
  try {
    const canvas = renderCard(makeCanvas(1, 1), renderState(), { fillCorners: true });
    const render = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const src = activeSource();
    const item = {
      id: ed.editingId || uid(),
      createdAt: Date.now(),
      qty: ed.qty,
      name: itemName(),
      sub: `${ed.print.set.toUpperCase()} · ${(ed.print.lang || 'en').toUpperCase()} · #${ed.print.collector_number}`,
      render,
      w: canvas.width,
      h: canvas.height,
      state: {
        card: ed.print,
        face: ed.face,
        lang: ed.lang,
        oracleId: ed.oracleId,
        rect: ed.rect,
        zoom: ed.zoom,
        offX: ed.offX,
        offY: ed.offY,
        adj: ed.adj,
        outline: ed.outline,
        proxyMark: ed.proxyMark,
        art: src ? src.blob : null,
        artKind: src ? src.kind : null,
      },
    };
    if (ed.editingId) {
      const old = await idb.get('items', ed.editingId);
      if (old) item.createdAt = old.createdAt;
    }
    await idb.put('items', item);
    toast(ed.editingId ? 'Carte mise à jour ✓' : `Ajoutée à la planche ✓ (${ed.qty}×)`, 'ok');
    ed.editingId = null;
    updateAddButton();
    updateBadge();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#ed-share').addEventListener('click', async () => {
  if (!ed.base) return;
  try {
    const canvas = renderCard(makeCanvas(1, 1), renderState());
    const blob = await canvasToBlob(canvas, 'image/png');
    await offerFiles([toFile(blob, `${slug(itemName()) || 'carte'}-proxy.png`)], itemName());
  } catch (e) {
    toast(e.message, 'error');
  }
});

// Safari refuse parfois le partage s'il arrive trop longtemps après le geste de l'utilisateur :
// on propose alors un bouton pour relancer le partage (nouveau geste = autorisé).
const readyDialog = $('#ready-dialog');
let readyFiles = null;
async function offerFiles(files, title) {
  const r = await shareFiles(files, { title });
  if (r !== 'blocked') return r;
  readyFiles = { files, title };
  $('#ready-name').textContent = files.length > 1 ? `${files.length} fichiers` : files[0].name;
  readyDialog.showModal();
  return r;
}
$('#ready-share').addEventListener('click', async () => {
  readyDialog.close();
  if (readyFiles) await shareFiles(readyFiles.files, { title: readyFiles.title, forceDownloadOnBlock: true });
});
$('#ready-close').addEventListener('click', () => readyDialog.close());

// ============================================================
// IA
// ============================================================

let aiCtrl = null;

function renderPresets() {
  $('#ai-presets').replaceChildren(
    ...Object.entries(ai.PRESETS).map(([id, p]) =>
      h('button', {
        type: 'button',
        class: 'preset',
        role: 'radio',
        'aria-checked': String(id === ed.aiPreset),
        onclick: () => {
          ed.aiPreset = id;
          renderPresets();
          refreshGemini();
        },
      }, p.label),
    ),
  );
  $('#ai-hint').textContent = ai.PRESETS[ed.aiPreset].hint;
}

const ENGINE_LABELS = { free: 'gratuit (Hugging Face)', gemini: 'Google Gemini (clé API)', openai: 'OpenAI (clé API)' };

function refreshAiPanel() {
  const engine = settings.engine;
  const missingKey = engine !== 'free' && !settings.keys[engine];
  $('#ai-engine').textContent = `${ENGINE_LABELS[engine] || engine}${missingKey ? ' — clé manquante' : ''}`;
  refreshGemini();
}

async function resolveModel(p) {
  if (settings.model[p] && settings.model[p] !== 'auto') return settings.model[p];
  if (!settings.models[p]?.length) {
    try {
      settings.models[p] = await ai.listModels(p, settings.keys[p]);
      saveSettings();
    } catch {
      /* on tente le modèle par défaut */
    }
  }
  return ai.pickModel(p, settings.models[p] || []);
}

async function toJpeg(img, maxDim) {
  return canvasToBlob(downscale(img, maxDim), 'image/jpeg', 0.9);
}

// Illustration à gauche, photo à droite : pour les modèles qui n'acceptent qu'une image.
async function sideBySide(a, b) {
  const H = 768;
  const da = dims(a);
  const db = dims(b);
  const wa = Math.round((da.w * H) / da.h);
  const wb = Math.round((db.w * H) / db.h);
  const c = makeCanvas(wa + wb, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(a, 0, 0, wa, H);
  ctx.drawImage(b, wa, 0, wb, H);
  return canvasToBlob(c, 'image/jpeg', 0.9);
}

async function freeSpace(signal, skip = []) {
  const wanted = (settings.hfSpace || '').trim();
  const c = settings.hfCtx;
  if (c && c.wanted === wanted && !skip.includes(c.id)) return c;
  const ctx = await hf.resolveSpace(wanted, settings.hfToken, signal, skip);
  settings.hfCtx = { ...ctx, wanted };
  saveSettings();
  return settings.hfCtx;
}

// Génération gratuite ; en mode automatique, si un Space échoue on passe au suivant.
async function generateFree(presetId, src, promptOpts, signal, onPhase) {
  const p = ai.PRESETS[presetId];
  const two = p.usesArt && p.needsPhoto;
  const tried = [];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    onPhase('Connexion au service gratuit…');
    const ctx = await freeSpace(signal, tried);
    try {
      let files = [];
      let layout = 'ordered';
      if (two && ctx.maxImages < 2) {
        files = [toFile(await sideBySide(ed.origArt, src.img), 'references.jpg')];
        layout = 'sideBySide';
      } else {
        if (p.usesArt) files.push(toFile(await toJpeg(ed.origArt, 1024), 'illustration.jpg'));
        if (p.needsPhoto) files.push(toFile(await toJpeg(src.img, 1024), 'photo.jpg'));
      }
      onPhase('Génération gratuite en cours (file d’attente comprise, souvent 30 s à 2 min)…');
      const prompt = ai.buildPrompt(presetId, { ...promptOpts, layout });
      const blob = await hf.generateHF({ ctx, token: settings.hfToken, files, prompt, signal });
      return { blob, via: ctx.id };
    } catch (e) {
      if (e.name === 'AbortError' || e.code === 'quota' || (settings.hfSpace || '').trim()) throw e;
      tried.push(ctx.id);
      settings.hfCtx = null;
      lastErr = e;
    }
  }
  throw lastErr;
}

$('#ai-go').addEventListener('click', async () => {
  if (!ed.base) return;
  const engine = settings.engine;
  if (engine !== 'free' && !settings.keys[engine]) {
    toast('Ajoute ta clé API dans Réglages, ou choisis le moteur gratuit.', 'error');
    return go('settings');
  }
  const preset = ai.PRESETS[ed.aiPreset];
  const src = activeSource();
  if (preset.needsPhoto && !src) return toast('Ajoute d’abord une photo (bouton « Ajouter une photo »).', 'error');
  if (preset.usesArt && !ed.origArt) return toast('Illustration originale indisponible pour cette carte.', 'error');

  const status = $('#ai-status');
  const goBtn = $('#ai-go');
  aiCtrl = new AbortController();
  const { signal } = aiCtrl;
  goBtn.disabled = true;
  $('#ai-cancel').hidden = false;
  const t0 = Date.now();
  let phase = 'Génération en cours (souvent 10 à 60 s)…';
  const tick = () => (status.textContent = `${phase} ${Math.round((Date.now() - t0) / 1000)} s`);
  tick();
  const timer = setInterval(tick, 500);
  try {
    const f = sf.faces(ed.print)[ed.face] || {};
    const ratio = ed.rect.w / ed.rect.h;
    const promptOpts = {
      cardName: f.name || ed.print.name,
      typeLine: f.type_line,
      useTheme: $('#ai-theme').checked,
      extra: $('#ai-extra').value.trim(),
      ratioLabel: ai.closestRatio(ratio),
    };
    let blob;
    let via;
    if (engine === 'free') {
      ({ blob, via } = await generateFree(ed.aiPreset, src, promptOpts, signal, (t) => {
        phase = t;
        tick();
      }));
    } else {
      const model = await resolveModel(engine);
      const images = [];
      if (preset.usesArt) images.push({ label: 'Card illustration', blob: await toJpeg(ed.origArt, 1024) });
      if (preset.needsPhoto) images.push({ label: 'Personal photo', blob: await toJpeg(src.img, 1536) });
      const prompt = ai.buildPrompt(ed.aiPreset, { ...promptOpts, layout: engine === 'gemini' ? 'labeled' : 'ordered' });
      blob = await ai.generate({ provider: engine, key: settings.keys[engine], model, prompt, images, ratio, quality: settings.quality, signal });
      via = model;
    }
    const n = ed.sources.filter((s) => s.label.startsWith('IA')).length + 1;
    await addSource(blob, 'ai', `IA ${n}`);
    clearInterval(timer);
    status.textContent = `Image générée avec ${via} en ${Math.round((Date.now() - t0) / 1000)} s.`;
    toast('Illustration générée ✓', 'ok');
  } catch (e) {
    clearInterval(timer);
    if (e.name === 'AbortError') status.textContent = 'Génération annulée.';
    else if (engine === 'free') {
      status.textContent = `${e.message} En attendant, tu peux passer par l’app Gemini (ci-dessous).`;
      $('#ai-fallback').open = true;
      refreshGemini();
    } else {
      status.textContent = e.message;
      if (e.status === 404) {
        settings.models[engine] = [];
        saveSettings();
        status.textContent += ' — Le modèle semble indisponible : va dans Réglages > « Tester la clé » pour en choisir un autre.';
      }
    }
  } finally {
    clearInterval(timer);
    goBtn.disabled = false;
    $('#ai-cancel').hidden = true;
    aiCtrl = null;
  }
});
$('#ai-cancel').addEventListener('click', () => aiCtrl?.abort());

// ----- Secours : l'utilisateur génère l'image dans l'app Gemini -----
// Les images sont préparées à l'avance : sur iPhone, le partage doit partir
// immédiatement après le toucher, sans attente.

let gmPack = null;

function gmKey() {
  const p = ai.PRESETS[ed.aiPreset];
  return [ed.print?.id, ed.face, ed.origArt ? 1 : 0, p.usesArt, p.needsPhoto && ed.active].join('|');
}

async function prepareGeminiFiles() {
  const key = gmKey();
  if (gmPack?.key === key) return gmPack.files;
  const p = ai.PRESETS[ed.aiPreset];
  const src = activeSource();
  const files = [];
  if (p.usesArt && ed.origArt) files.push(toFile(await toJpeg(ed.origArt, 1024), '1-illustration-originale.jpg'));
  if (p.needsPhoto && src) files.push(toFile(await toJpeg(src.img, 1536), p.usesArt ? '2-ma-photo.jpg' : 'ma-photo.jpg'));
  gmPack = { key, files };
  return files;
}

function geminiPrompt() {
  if (!ed.print) return '';
  const f = sf.faces(ed.print)[ed.face] || {};
  return ai.buildPromptFr(ed.aiPreset, {
    cardName: f.printed_name || f.name || ed.print.name,
    typeLine: f.type_line,
    useTheme: $('#ai-theme').checked,
    extra: $('#ai-extra').value.trim(),
    ratioLabel: ed.rect ? ai.closestRatio(ed.rect.w / ed.rect.h) : '4:3',
  });
}

const prefetchGemini = debounce(() => {
  if ($('#ai-fallback').open && ed.base) prepareGeminiFiles().catch(() => {});
}, 300);

// Ne prépare les images que si le bloc de secours est ouvert.
function refreshGemini() {
  if (!$('#ai-fallback').open) return;
  $('#gm-prompt').value = geminiPrompt();
  prefetchGemini();
}
$('#ai-fallback').addEventListener('toggle', refreshGemini);
$('#ai-theme').addEventListener('change', refreshGemini);
$('#ai-extra').addEventListener('input', debounce(refreshGemini, 200));

// Copie dans le presse-papiers, avec repli pour les navigateurs plus anciens.
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => copyFallback(text));
  return Promise.resolve(copyFallback(text));
}
function copyFallback(text) {
  const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0;top:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

$('#gm-send').addEventListener('click', async () => {
  if (!ed.base) return;
  const p = ai.PRESETS[ed.aiPreset];
  if (p.needsPhoto && !activeSource()) return toast('Ajoute d’abord une photo (bouton « Ajouter une photo »).', 'error');
  if (p.usesArt && !ed.origArt) return toast('Illustration originale indisponible pour cette carte.', 'error');
  const prompt = geminiPrompt();
  $('#gm-prompt').value = prompt;
  const copied = copyText(prompt);
  const files = gmPack?.key === gmKey() ? gmPack.files : await prepareGeminiFiles();
  const r = await offerFiles(files, 'Images pour Gemini');
  const ok = await copied;
  if (r === 'shared' || r === 'downloaded') {
    toast(ok ? 'Consignes copiées ✓ Ouvre Gemini et colle-les avec les images.' : 'Images prêtes. Copie les consignes avec le bouton « Copier les consignes ».', ok ? 'ok' : 'info', 5000);
  }
});

$('#gm-copy').addEventListener('click', async () => {
  const ok = await copyText($('#gm-prompt').value || geminiPrompt());
  toast(ok ? 'Consignes copiées ✓' : 'Copie impossible : sélectionne le texte à la main.', ok ? 'ok' : 'error');
});

$('#gm-import').addEventListener('change', (e) =>
  importImage(e.target, 'ai', 'Gemini', 'Image de Gemini importée ✓ Cadre-la si besoin.'),
);

// ============================================================
// Brouillon : l'éditeur survit à un rechargement de la page
// (iOS recharge parfois l'onglet après le choix d'une photo).
// ============================================================

const saveDraft = debounce(async () => {
  if (!ed.print) return;
  const src = activeSource();
  try {
    await idb.put('meta', {
      card: ed.print,
      face: ed.face,
      lang: ed.lang,
      oracleId: ed.oracleId,
      rect: ed.rect,
      zoom: ed.zoom,
      offX: ed.offX,
      offY: ed.offY,
      adj: ed.adj,
      art: src ? src.blob : null,
      artKind: src ? src.kind : null,
      qty: ed.qty,
      editingId: ed.editingId,
    }, 'draft');
  } catch {
    /* pas de stockage : tant pis pour le brouillon */
  }
}, 800);

async function restoreEditor(st, { editingId = null, qty = 1 } = {}) {
  $('#editor-empty').hidden = true;
  $('#editor').hidden = false;
  ed.editingId = editingId;
  ed.qty = qty;
  $('#ed-qty').textContent = qty;
  updateAddButton();
  ed.oracleId = st.oracleId || sf.oracleIdOf(st.card);
  ed.lang = st.lang || st.card.lang || 'en';
  ed.adj = { b: 0, c: 0, s: 0, harmony: 0, ...(st.adj || {}) };
  ed.outline = st.outline ?? true;
  ed.proxyMark = st.proxyMark ?? settings.proxyMark;
  $('#ed-outline').checked = ed.outline;
  $('#ed-proxy').checked = ed.proxyMark;
  ed.sources = [];
  ed.active = null;
  if (st.art) {
    const img = await blobToImage(st.art);
    const s = { id: uid(), kind: st.artKind || 'photo', blob: st.art, img, label: st.artKind === 'ai' ? 'IA' : 'Photo' };
    ed.sources.push(s);
    ed.active = s.id;
  }
  ed.zoom = st.zoom || 1;
  ed.offX = st.offX || 0;
  ed.offY = st.offY || 0;
  syncSliders();
  ed.prints = [st.card];
  renderLangSelect();
  await selectPrint(st.card, st.face || 0, { rect: st.rect });
  // La liste complète des éditions arrive ensuite, sans bloquer l'affichage.
  sf.prints(ed.oracleId, ed.lang)
    .then((list) => {
      if (list.length && ed.print?.id === st.card.id) {
        ed.prints = list.some((c) => c.id === st.card.id) ? list : [st.card, ...list];
        renderPrints();
      }
    })
    .catch(() => {});
}

// ============================================================
// Planche d'impression
// ============================================================

let sheetUrls = [];

async function getItems() {
  try {
    return (await idb.all('items')).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

async function updateBadge() {
  const items = await getItems();
  const n = items.reduce((a, it) => a + it.qty, 0);
  const b = $('#sheet-badge');
  b.hidden = !n;
  b.textContent = n;
}

async function renderSheet() {
  const items = await getItems();
  sheetUrls.forEach((u) => URL.revokeObjectURL(u));
  sheetUrls = [];
  const n = items.reduce((a, it) => a + it.qty, 0);
  const pages = Math.ceil(n / PER_PAGE);
  $('#sheet-summary').textContent = n ? `${n} carte${n > 1 ? 's' : ''} · ${pages} page${pages > 1 ? 's' : ''} de 9` : '';
  $('#sheet-empty').hidden = !!items.length;
  $('#pdf-panel').hidden = !items.length;
  $('#sheet-clear').hidden = !items.length;
  $('#sheet-list').replaceChildren(
    ...items.map((it) => {
      const url = URL.createObjectURL(it.render);
      sheetUrls.push(url);
      const qtyEl = h('span', {}, it.qty);
      const setQty = async (d) => {
        it.qty = Math.max(1, Math.min(99, it.qty + d));
        qtyEl.textContent = it.qty;
        await idb.put('items', it);
        updateBadge();
        renderSheet();
      };
      return h('div', { class: 'sheet-item' },
        h('img', { src: url, alt: it.name }),
        h('div', { class: 'meta' },
          h('strong', {}, it.name),
          h('span', {}, `${it.sub}${it.state?.art ? ` · ${it.state.artKind === 'ai' ? 'art IA' : 'ta photo'}` : ''}`),
          h('div', { class: 'row' },
            h('div', { class: 'qty' },
              h('button', { type: 'button', 'aria-label': 'Moins', onclick: () => setQty(-1) }, '−'),
              qtyEl,
              h('button', { type: 'button', 'aria-label': 'Plus', onclick: () => setQty(1) }, '+'),
            ),
          ),
        ),
        h('div', { class: 'side' },
          h('button', { type: 'button', class: 'btn small', onclick: () => editItem(it) }, 'Modifier'),
          h('button', {
            type: 'button',
            class: 'btn small danger-ghost',
            onclick: async () => {
              await idb.del('items', it.id);
              updateBadge();
              renderSheet();
            },
          }, 'Retirer'),
        ),
      );
    }),
  );
}

async function editItem(it) {
  go('editor');
  try {
    await restoreEditor(it.state, { editingId: it.id, qty: it.qty });
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('#sheet-clear').addEventListener('click', async () => {
  if (!confirm('Retirer toutes les cartes de la planche ?')) return;
  await idb.clear('items');
  updateBadge();
  renderSheet();
});

$('#pdf-go').addEventListener('click', async () => {
  const btn = $('#pdf-go');
  btn.disabled = true;
  btn.textContent = 'Génération…';
  try {
    const items = await getItems();
    const cards = await Promise.all(
      items.map(async (it) => ({
        jpeg: new Uint8Array(await it.render.arrayBuffer()),
        width: it.w,
        height: it.h,
        qty: it.qty,
      })),
    );
    const pdf = buildPdf(cards, {
      page: $('#pdf-page').value,
      gap: Number($('#pdf-gap').value),
      cutMarks: $('#pdf-marks').checked,
    });
    await offerFiles([toFile(pdf, 'proxies-magic.pdf')], 'Proxies Magic');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Générer le PDF';
  }
});

// ============================================================
// Import de decklist
// ============================================================

const importDialog = $('#import-dialog');
$('#btn-import').addEventListener('click', () => {
  $('#import-lang').replaceChildren(...sf.LANGS.map(([c, n]) => h('option', { value: c, selected: c === settings.lang }, n)));
  $('#import-progress').textContent = '';
  importDialog.showModal();
});
$('#import-cancel').addEventListener('click', () => importDialog.close());

let importing = false;
$('#import-go').addEventListener('click', async () => {
  if (importing) return;
  const entries = parseDecklist($('#import-text').value);
  if (!entries.length) return toast('Aucune carte reconnue dans la liste.', 'error');
  const lang = $('#import-lang').value;
  const skipBasics = $('#import-skip-basics').checked;
  const progress = $('#import-progress');
  const goBtn = $('#import-go');
  importing = true;
  goBtn.disabled = true;
  const notFound = [];
  let added = 0;
  try {
    // 1) Résolution des noms par paquets de 75 (limite de l'API).
    const found = [];
    for (let i = 0; i < entries.length; i += 75) {
      const chunk = entries.slice(i, i + 75);
      progress.textContent = `Recherche des cartes… ${Math.min(i + 75, entries.length)}/${entries.length}`;
      const ids = chunk.map((e) => (e.set && e.cn ? { set: e.set, collector_number: e.cn } : e.set ? { name: e.name, set: e.set } : { name: e.name }));
      const res = await sf.collection(ids);
      const data = res?.data || [];
      for (const e of chunk) {
        let card = matchEntry(e, data);
        if (!card) {
          // Peut-être un nom en français (ou autre langue) ?
          const loc = await sf.searchLocalized(`"${e.name}"`, lang === 'en' ? 'fr' : lang).catch(() => []);
          card = loc.find((c) => norm(c.printed_name) === norm(e.name)) || loc[0];
        }
        if (card) found.push({ entry: e, card });
        else notFound.push(e.name);
      }
    }

    // 2) Choix de l'édition et de la langue, rendu et ajout à la planche.
    const list = skipBasics ? found.filter(({ card }) => !/basic/i.test(card.type_line || '')) : found;
    let i = 0;
    for (const { entry, card } of list) {
      i++;
      progress.textContent = `Ajout ${i}/${list.length} : ${card.name}`;
      let pick = card;
      const keepGiven = entry.set && card.lang === lang;
      if (!keepGiven) {
        const prints = await sf.prints(sf.oracleIdOf(card), lang).catch(() => []);
        const sameSet = entry.set && prints.filter((c) => c.set === entry.set);
        pick = (sameSet?.length ? sf.bestPrint(sameSet) : sf.bestPrint(prints)) || card;
      }
      try {
        await addPlainItem(pick, entry.qty);
        added++;
      } catch (e) {
        notFound.push(`${card.name} (${e.message})`);
      }
    }
    updateBadge();
    progress.textContent = `${added} carte${added > 1 ? 's' : ''} ajoutée${added > 1 ? 's' : ''} à la planche.${notFound.length ? ` Introuvables : ${notFound.join(', ')}` : ''}`;
    toast(`${added} carte${added > 1 ? 's' : ''} importée${added > 1 ? 's' : ''} ✓`, 'ok');
  } catch (e) {
    progress.textContent = e.message;
  } finally {
    importing = false;
    goBtn.disabled = false;
  }
});

// Carte avec son illustration d'origine (import de liste). On prend le JPEG « large »
// (~670 px, ~270 dpi une fois imprimé) : bien plus léger que le PNG pour un deck entier.
async function addPlainItem(card, qty) {
  const f = sf.faces(card)[0];
  const { img } = await fetchImage(f.image_uris.large || f.image_uris.png);
  const borderColor = sampleBorderColor(img);
  const canvas = renderCard(makeCanvas(1, 1), { base: img, proxyMark: settings.proxyMark, borderColor }, { fillCorners: true });
  const render = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  await idb.put('items', {
    id: uid(),
    createdAt: Date.now(),
    qty,
    name: f.printed_name || f.name,
    sub: `${card.set.toUpperCase()} · ${(card.lang || 'en').toUpperCase()} · #${card.collector_number}`,
    render,
    w: canvas.width,
    h: canvas.height,
    state: { card, face: 0, lang: card.lang, oracleId: sf.oracleIdOf(card), proxyMark: settings.proxyMark, art: null },
  });
}

// ============================================================
// Réglages
// ============================================================

const apiProvider = () => (settings.engine === 'openai' ? 'openai' : 'gemini');

function renderSettings() {
  $('#set-engine').value = settings.engine;
  $('#set-free').hidden = settings.engine !== 'free';
  $('#set-api').hidden = settings.engine === 'free';
  $('#set-hf-token').value = settings.hfToken || '';
  $('#set-hf-space').value = settings.hfSpace || '';
  const p = apiProvider();
  $('#set-key').value = settings.keys[p] || '';
  $('#set-key-link').href = ai.PROVIDERS[p].keyUrl;
  $('#set-key-link').textContent = `Obtenir une clé ${ai.PROVIDERS[p].label}`;
  $('#set-quality-wrap').hidden = p !== 'openai';
  $('#set-quality').value = settings.quality;
  const models = settings.models[p] || [];
  const current = settings.model[p] || 'auto';
  const auto = models.length ? ai.pickModel(p, models) : ai.PROVIDERS[p].fallbackModel;
  const opts = [h('option', { value: 'auto' }, `Automatique (${auto})`)];
  for (const m of models) opts.push(h('option', { value: m.id }, m.id));
  if (current !== 'auto' && !models.some((m) => m.id === current)) opts.push(h('option', { value: current }, current));
  $('#set-model').replaceChildren(...opts);
  $('#set-model').value = current;
  $('#set-lang').replaceChildren(...sf.LANGS.map(([c, n]) => h('option', { value: c, selected: c === settings.lang }, n)));
  $('#set-proxy').checked = settings.proxyMark;
}

$('#set-engine').addEventListener('change', (e) => {
  settings.engine = e.target.value;
  saveSettings();
  $('#set-test-status').textContent = '';
  $('#set-hf-status').textContent = '';
  renderSettings();
  refreshAiPanel();
});
$('#set-hf-token').addEventListener('change', (e) => {
  settings.hfToken = e.target.value.trim();
  saveSettings();
});
$('#set-hf-toggle').addEventListener('click', (e) => {
  const input = $('#set-hf-token');
  input.type = input.type === 'password' ? 'text' : 'password';
  e.target.textContent = input.type === 'password' ? 'Voir' : 'Masquer';
});
$('#set-hf-space').addEventListener('change', (e) => {
  settings.hfSpace = e.target.value.trim();
  settings.hfCtx = null;
  saveSettings();
});
$('#set-hf-test').addEventListener('click', async () => {
  settings.hfToken = $('#set-hf-token').value.trim();
  settings.hfSpace = $('#set-hf-space').value.trim();
  settings.hfCtx = null;
  saveSettings();
  const st = $('#set-hf-status');
  st.textContent = 'Recherche d’un modèle disponible…';
  try {
    const ctx = await freeSpace();
    st.textContent = `Service gratuit prêt ✓ Modèle : ${ctx.id}.${settings.hfToken ? '' : ' Sans jeton, le quota est très réduit.'}`;
  } catch (e) {
    st.textContent = e.message;
  }
});
$('#set-key').addEventListener('change', (e) => {
  settings.keys[apiProvider()] = e.target.value.trim();
  settings.models[apiProvider()] = [];
  saveSettings();
  renderSettings();
  refreshAiPanel();
});
$('#set-key-toggle').addEventListener('click', (e) => {
  const input = $('#set-key');
  input.type = input.type === 'password' ? 'text' : 'password';
  e.target.textContent = input.type === 'password' ? 'Voir' : 'Masquer';
});
$('#set-test').addEventListener('click', async () => {
  const p = apiProvider();
  settings.keys[p] = $('#set-key').value.trim();
  saveSettings();
  const st = $('#set-test-status');
  if (!settings.keys[p]) return (st.textContent = 'Colle d’abord ta clé.');
  st.textContent = 'Vérification…';
  try {
    const models = await ai.listModels(p, settings.keys[p]);
    settings.models[p] = models;
    saveSettings();
    renderSettings();
    st.textContent = models.length
      ? `Clé valide ✓ ${models.length} modèle${models.length > 1 ? 's' : ''} d’image disponible${models.length > 1 ? 's' : ''}.`
      : 'Clé valide, mais aucun modèle d’image n’est listé pour ce compte.';
  } catch (e) {
    st.textContent = e.message;
  }
  refreshAiPanel();
});
$('#set-model').addEventListener('change', (e) => {
  settings.model[apiProvider()] = e.target.value;
  saveSettings();
  refreshAiPanel();
});
$('#set-quality').addEventListener('change', (e) => {
  settings.quality = e.target.value;
  saveSettings();
});
$('#set-lang').addEventListener('change', (e) => {
  settings.lang = e.target.value;
  saveSettings();
});
$('#set-proxy').addEventListener('change', (e) => {
  settings.proxyMark = e.target.checked;
  saveSettings();
  ed.proxyMark = settings.proxyMark;
  $('#ed-proxy').checked = ed.proxyMark;
  draw();
});
$('#set-wipe').addEventListener('click', async () => {
  if (!confirm('Effacer la planche, le brouillon, les clés et les réglages de cet appareil ?')) return;
  storage.remove('pf-settings');
  try {
    await idb.clear('items');
    await idb.clear('meta');
  } catch {
    /* rien à effacer */
  }
  location.reload();
});

// ============================================================
// Démarrage
// ============================================================

async function init() {
  renderSettings();
  renderPresets();
  refreshAiPanel();
  $('#ed-proxy').checked = ed.proxyMark;
  show(location.hash.slice(1) || 'search');
  updateBadge();
  try {
    const draft = await idb.get('meta', 'draft');
    if (draft?.card) {
      await restoreEditor(draft, { editingId: draft.editingId || null, qty: draft.qty || 1 });
    }
  } catch (e) {
    console.warn('Brouillon illisible', e);
  }
}

init();
