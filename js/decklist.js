// Lecture d'une decklist collée (Moxfield, Archidekt, MTG Arena, liste simple…).
// Formats reconnus par ligne : « Sol Ring », « 1 Sol Ring », « 1x Sol Ring »,
// « 1 Sol Ring (C21) 263 », « 1 Sol Ring (C21) 263 *F* [Ramp] ».

const HEADER_RE =
  /^(commander|commandant|deck|main ?deck|mainboard|sideboard|maybeboard|companion|lands|creatures|instants|sorceries|artifacts|enchantments|planeswalkers|battles|other|terrains|créatures)\s*(\(\d+\))?:?$/i;

export function parseDecklist(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^(\/\/|#)/.test(line) || HEADER_RE.test(line)) continue;
    line = line
      .replace(/\s+\[[^\]]*\]\s*$/, '') // catégories Archidekt : [Ramp]
      .replace(/\s+\*[A-Z]+\*/g, '') // *F*, *CMDR*, *E*
      .replace(/\s+\^[^^]*\^/g, '') // étiquettes ^Tag^
      .trim();
    const m = line.match(/^(?:(\d+)\s*[xX]?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([A-Za-z0-9★-]+))?)?$/);
    if (!m) continue;
    const qty = Math.max(1, parseInt(m[1] || '1', 10));
    // Cartes doubles : on garde le nom de la face avant.
    const name = m[2].split(/\s+\/\/?\s+/)[0].trim();
    if (!name) continue;
    const set = m[3]?.toLowerCase();
    const cn = m[4];
    const key = `${name.toLowerCase()}|${set || ''}|${cn || ''}`;
    if (out.has(key)) out.get(key).qty += qty;
    else out.set(key, { qty, name, set, cn });
  }
  return [...out.values()];
}

export const norm = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

// Retrouve, parmi les cartes renvoyées par Scryfall, celle qui correspond à une ligne.
export function matchEntry(entry, cards) {
  return cards.find(
    (c) =>
      (entry.cn && entry.set && c.set === entry.set && c.collector_number === entry.cn) ||
      norm(c.name) === norm(entry.name) ||
      norm(c.card_faces?.[0]?.name) === norm(entry.name),
  );
}
