// Client minimal pour l'API Scryfall (https://scryfall.com/docs/api).
// Scryfall demande d'espacer les requêtes de 50 à 100 ms : toutes les requêtes passent par une file.

import { sleep } from './util.js';

const API = 'https://api.scryfall.com';
const MIN_GAP_MS = 110;

let lastCall = 0;
let queue = Promise.resolve();

function throttle() {
  const turn = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  });
  queue = turn.catch(() => {});
  return turn;
}

async function api(path, { method = 'GET', body, signal } = {}) {
  await throttle();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = path.startsWith('http') ? path : API + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Scryfall est injoignable. Vérifie ta connexion.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse vide */
  }
  if (!res.ok) {
    // 404 = « aucune carte trouvée » pour la recherche : ce n'est pas une erreur pour nous.
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('Trop de requêtes vers Scryfall, patiente quelques secondes.');
    throw new Error(data?.details || `Erreur Scryfall (${res.status})`);
  }
  return data;
}

const enc = encodeURIComponent;

export const LANGS = [
  ['fr', 'Français'],
  ['en', 'English'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
  ['es', 'Español'],
  ['pt', 'Português'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['ru', 'Русский'],
  ['zhs', '简体中文'],
  ['zht', '繁體中文'],
];

export async function autocomplete(q, signal) {
  const d = await api(`/cards/autocomplete?q=${enc(q)}`, { signal });
  return d?.data || [];
}

// Recherche par nom imprimé dans une autre langue (ex. « Éclair » en français).
export async function searchLocalized(q, lang, signal) {
  const d = await api(`/cards/search?q=${enc(`${q} lang:${lang}`)}&unique=cards&order=name`, { signal });
  return d?.data || [];
}

export async function search(q, { order = 'name', unique = 'cards', signal } = {}) {
  const d = await api(`/cards/search?q=${enc(q)}&unique=${unique}&order=${order}`, { signal });
  return d || { data: [], has_more: false, total_cards: 0 };
}

export function nextPage(url, signal) {
  return api(url, { signal });
}

export function named(name, signal) {
  return api(`/cards/named?exact=${enc(name)}`, { signal });
}

export function random(q) {
  return api(`/cards/random${q ? `?q=${enc(q)}` : ''}`);
}

export function collection(identifiers) {
  return api('/cards/collection', { method: 'POST', body: { identifiers } });
}

export function oracleIdOf(card) {
  return card.oracle_id || card.card_faces?.[0]?.oracle_id;
}

// Toutes les impressions d'une carte dans une langue donnée, les plus récentes d'abord.
export async function prints(oracleId, lang, signal) {
  const q = `oracleid:${oracleId} lang:${lang}`;
  let d = await api(`/cards/search?q=${enc(q)}&unique=prints&order=released&dir=desc`, { signal });
  const out = [];
  while (d) {
    out.push(...d.data);
    if (!d.has_more || out.length >= 350) break;
    d = await api(d.next_page, { signal });
  }
  return out.filter(
    (c) => !c.digital && c.image_status !== 'missing' && c.image_status !== 'placeholder' && faces(c).length,
  );
}

// Faces imprimables d'une carte : 1 pour une carte normale, 2 pour une carte recto-verso.
export function faces(card) {
  if (card.image_uris) {
    return [
      {
        name: card.name,
        printed_name: card.printed_name,
        type_line: card.printed_type_line || card.type_line,
        image_uris: card.image_uris,
      },
    ];
  }
  return (card.card_faces || [])
    .filter((f) => f.image_uris)
    .map((f) => ({
      name: f.name,
      printed_name: f.printed_name,
      type_line: f.printed_type_line || f.type_line,
      image_uris: f.image_uris,
    }));
}

export function displayName(card) {
  if (card.printed_name) return card.printed_name;
  if (card.card_faces?.some((f) => f.printed_name)) {
    return card.card_faces.map((f) => f.printed_name || f.name).join(' // ');
  }
  return card.name;
}

// Plus le score est haut, plus l'impression convient à un proxy « classique » :
// scan HD, cadre moderne, bordure noire, pas de full art / showcase.
export function printScore(c) {
  let s = 0;
  if (c.image_status === 'highres_scan') s += 40;
  else if (c.image_status === 'lowres') s += 10;
  if (c.frame === '2015') s += 25;
  else if (c.frame === '2003') s += 12;
  else if (c.frame === 'future') s += 6;
  if (c.border_color === 'black') s += 10;
  if (c.border_color === 'borderless') s -= 30;
  if (c.full_art) s -= 25;
  if (c.textless) s -= 25;
  if (c.promo) s -= 8;
  const fx = c.frame_effects || [];
  if (fx.some((f) => ['showcase', 'extendedart', 'inverted', 'etched', 'shatteredglass', 'textured'].includes(f))) s -= 15;
  if (['memorabilia', 'funny', 'token'].includes(c.set_type)) s -= 30;
  return s;
}

export function bestPrint(list) {
  // Les listes arrivent triées de la plus récente à la plus ancienne : à score égal, la plus récente gagne.
  let best = null;
  let bestScore = -Infinity;
  for (const c of list) {
    const s = printScore(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

// Cadre qui risque de mal se prêter au remplacement de l'illustration.
export function isRiskyFrame(c) {
  return c.border_color === 'borderless' || c.full_art || (c.frame_effects || []).includes('extendedart');
}
