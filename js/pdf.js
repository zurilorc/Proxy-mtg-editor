// Générateur PDF minimal, sans dépendance : pages A4 (ou Letter) de 3 x 3 cartes au format
// réel 63 x 88 mm, avec traits de coupe. Les cartes sont intégrées telles quelles en JPEG
// (filtre DCTDecode), donc aucune recompression.

const MM = 72 / 25.4;
export const PAGE_SIZES = {
  a4: { w: 210, h: 297, label: 'A4' },
  letter: { w: 215.9, h: 279.4, label: 'US Letter' },
};
export const CARD_W = 63;
export const CARD_H = 88;
export const PER_PAGE = 9;

const f = (n) => (Math.round(n * 1000) / 1000).toString();

/**
 * cards : [{ jpeg: Uint8Array, width, height, qty }]
 * opts : { page: 'a4'|'letter', gap: mm, cutMarks: bool }
 */
export function buildPdf(cards, { page = 'a4', gap = 0, cutMarks = true } = {}) {
  const P = PAGE_SIZES[page] || PAGE_SIZES.a4;
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    offset += b.length;
  };

  // Emplacements : une entrée par exemplaire.
  const slots = [];
  cards.forEach((c, i) => {
    for (let q = 0; q < (c.qty || 1); q++) slots.push(i);
  });
  const pages = [];
  for (let i = 0; i < slots.length; i += PER_PAGE) pages.push(slots.slice(i, i + PER_PAGE));
  if (!pages.length) throw new Error('Aucune carte à imprimer.');

  // Numérotation des objets : 1 catalogue, 2 arbre des pages, puis images, puis pages + contenus.
  const imgObj = (i) => 3 + i;
  const pageObj = (p) => 3 + cards.length + p * 2;
  const contentObj = (p) => pageObj(p) + 1;
  const total = 2 + cards.length + pages.length * 2;

  const obj = (num, dict, stream) => {
    offsets[num] = offset;
    push(`${num} 0 obj\n${dict}`);
    if (stream) {
      push('\nstream\n');
      push(stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, p) => `${pageObj(p)} 0 R`).join(' ')}] >>`);
  cards.forEach((c, i) => {
    obj(
      imgObj(i),
      `<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${c.jpeg.length} >>`,
      c.jpeg,
    );
  });

  const pw = P.w * MM;
  const ph = P.h * MM;
  const cw = CARD_W * MM;
  const ch = CARD_H * MM;
  const g = gap * MM;
  const gridW = 3 * cw + 2 * g;
  const gridH = 3 * ch + 2 * g;
  const x0 = (pw - gridW) / 2;
  const yTop = (ph - gridH) / 2; // depuis le haut de la page

  pages.forEach((slotsOnPage, p) => {
    const used = [...new Set(slotsOnPage)];
    let content = '';
    slotsOnPage.forEach((cardIdx, k) => {
      const col = k % 3;
      const row = Math.floor(k / 3);
      const x = x0 + col * (cw + g);
      const y = ph - (yTop + row * (ch + g)) - ch;
      content += `q ${f(cw)} 0 0 ${f(ch)} ${f(x)} ${f(y)} cm /Im${cardIdx} Do Q\n`;
    });
    if (cutMarks) content += cutMarksOps(x0, yTop, cw, ch, g, pw, ph);
    const data = enc.encode(content);
    obj(
      pageObj(p),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << ${used
        .map((i) => `/Im${i} ${imgObj(i)} 0 R`)
        .join(' ')} >> >> /Contents ${contentObj(p)} 0 R >>`,
    );
    obj(contentObj(p), `<< /Length ${data.length} >>`, data);
  });

  const xref = offset;
  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}

// Petits traits dans les marges, alignés sur les bords de chaque carte.
function cutMarksOps(x0, yTop, cw, ch, g, pw, ph) {
  const gridW = 3 * cw + 2 * g;
  const gridH = 3 * ch + 2 * g;
  const marginX = x0;
  const marginY = yTop;
  const off = 1.5 * MM;
  const lenX = Math.max(2 * MM, Math.min(6 * MM, marginX - off - 1.5 * MM));
  const lenY = Math.max(2 * MM, Math.min(6 * MM, marginY - off - 1.5 * MM));
  const xs = new Set();
  const ys = new Set();
  for (let i = 0; i < 3; i++) {
    xs.add(x0 + i * (cw + g));
    xs.add(x0 + i * (cw + g) + cw);
    ys.add(yTop + i * (ch + g));
    ys.add(yTop + i * (ch + g) + ch);
  }
  let s = '0.35 w 0 G\n';
  const top = ph - yTop;
  const bottom = ph - (yTop + gridH);
  for (const x of xs) {
    s += `${f(x)} ${f(top + off)} m ${f(x)} ${f(top + off + lenY)} l S\n`;
    s += `${f(x)} ${f(bottom - off)} m ${f(x)} ${f(bottom - off - lenY)} l S\n`;
  }
  for (const yy of ys) {
    const y = ph - yy;
    s += `${f(x0 - off)} ${f(y)} m ${f(x0 - off - lenX)} ${f(y)} l S\n`;
    s += `${f(x0 + gridW + off)} ${f(y)} m ${f(x0 + gridW + off + lenX)} ${f(y)} l S\n`;
  }
  return s;
}
