const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const { install, log } = require('./mocks');
const BASE = process.env.BASE || 'http://localhost:8765/';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets/meta.json')));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  await install(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404 \(Not Found\)/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE);
  await page.screenshot({ path: `${OUT}/01-home.png` });

  // --- Autocomplétion FR + EN
  await page.fill('#q', 'sol');
  await page.waitForSelector('#suggestions li');
  const sugg = await page.$$eval('#suggestions li', (els) => els.map((e) => e.textContent));
  check(sugg[0].includes('Anneau solaire') && sugg[0].includes('fr'), `suggestion FR en tête (${sugg[0]})`);
  check(sugg.some((s) => s.startsWith('Solemn')), 'suggestions EN présentes');
  await page.screenshot({ path: `${OUT}/02-suggest.png` });

  // --- Ouvre la version FR
  await page.click('#suggestions li:first-child button');
  await page.waitForFunction(() => document.querySelector('#preview-loading').hidden && document.querySelector('#ed-name').textContent);
  check((await page.textContent('#ed-name')) === 'Anneau solaire', 'titre FR dans l’éditeur');
  check((await page.inputValue('#ed-lang')) === 'fr', 'langue = fr');
  await page.screenshot({ path: `${OUT}/03-editor-fr.png`, fullPage: true });

  // --- Passage en anglais : doit choisir l'édition classique (pas la borderless)
  await page.selectOption('#ed-lang', 'en');
  await page.waitForFunction(() => document.querySelector('#ed-sub').textContent.includes('Commander 2021') && document.querySelector('#preview-loading').hidden);
  check((await page.$$('#ed-prints .pr')).length === 3, '3 éditions EN listées');
  check((await page.textContent('#ed-sub')).includes('EN'), 'édition EN sélectionnée');

  // Zone détectée
  const zoneRect = async () => page.evaluate(() => {
    document.querySelector('#mode-seg [data-mode="zone"]').click();
    const z = document.querySelector('#zone');
    const c = document.querySelector('#preview').getBoundingClientRect();
    const r = z.getBoundingClientRect();
    const k = 745 / c.width;
    const out = [(r.left - c.left) * k, (r.top - c.top) * k, r.width * k, r.height * k].map(Math.round);
    document.querySelector('#mode-seg [data-mode="image"]').click();
    return out;
  });
  const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  let zr = await zoneRect();
  check(near(zr, meta.m15.rect, 4), `zone M15 détectée ${zr} ≈ ${meta.m15.rect}`);

  // Vieux cadre (art_crop à une autre échelle)
  await page.click('#ed-prints .pr:nth-child(3)');
  await page.waitForFunction(() => document.querySelector('#ed-sub').textContent.includes('Fifth') && document.querySelector('#preview-loading').hidden);
  zr = await zoneRect();
  check(near(zr, meta.old.rect, 5), `zone cadre 1997 détectée ${zr} ≈ ${meta.old.rect}`);
  await page.click('#ed-prints .pr:nth-child(1)');
  await page.waitForFunction(() => document.querySelector('#ed-sub').textContent.includes('Secret') && document.querySelector('#preview-loading').hidden);
  check(!(await page.isHidden('#ed-warning')), 'avertissement borderless affiché');
  await page.click('#ed-prints .pr:nth-child(2)');
  await page.waitForFunction(() => document.querySelector('#ed-sub').textContent.includes('Commander 2021') && document.querySelector('#preview-loading').hidden);

  // --- Photo
  await page.setInputFiles('#ed-file', path.join(__dirname, 'assets/photo.jpg'));
  await page.waitForSelector('#ed-sources .src:nth-child(2).on');
  check(!(await page.isHidden('#art-controls')), 'réglages de l’illustration visibles');
  const px = async (x, y) => page.evaluate(([x, y]) => [...document.querySelector('#preview').getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
  let center = await px(372, 350);
  check(center[0] > 180 && center[1] < 80, `centre de l’art = rouge de la photo (${center})`);
  const textBox = await px(300, 820);
  check(textBox[0] > 200 && textBox[1] > 200, `boîte de texte d’origine intacte (${textBox})`);
  await page.screenshot({ path: `${OUT}/04-photo.png`, fullPage: true });

  // Glisser pour décaler l'image (après zoom, pour avoir de la marge)
  await page.fill('#ed-zoom', '2');
  await page.dispatchEvent('#ed-zoom', 'input');
  await page.waitForTimeout(100);
  center = await px(372, 350);
  await page.$eval('#preview', (c) => c.scrollIntoView({ block: 'center' }));
  const box = await page.$eval('#preview', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
  await page.mouse.move(box.x + box.w / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2 + 120, box.y + 120, { steps: 6 });
  await page.mouse.up();
  const after = await px(372, 350);
  check(JSON.stringify(after) !== JSON.stringify(center), `glisser déplace l’image (${after})`);

  // Harmonie
  await page.fill('#ed-harmony', '80');
  await page.dispatchEvent('#ed-harmony', 'input');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/05-adjust.png` });

  // --- Mode gratuit : app Gemini (par défaut)
  check(!(await page.isHidden('#ai-app')) && (await page.isHidden('#ai-api')), 'mode gratuit app Gemini affiché par défaut');
  const gmPrompt = await page.inputValue('#gm-prompt');
  check(gmPrompt.includes('Repeins ma photo') && gmPrompt.includes('Sol Ring'), 'consignes en français avec le nom de la carte');
  await page.fill('#ai-extra', 'ciel étoilé');
  await page.waitForTimeout(400);
  check((await page.inputValue('#gm-prompt')).includes('ciel étoilé'), 'consignes mises à jour avec les instructions');
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.click('#gm-send');
  await page.waitForTimeout(1500);
  check(downloads.includes('1-illustration-originale.jpg') && downloads.includes('2-ma-photo.jpg'), `2 images envoyées (${downloads.join(', ')})`);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('ciel étoilé') && clip.includes('Aucun texte'), 'consignes copiées dans le presse-papiers');
  await page.setInputFiles('#gm-import', path.join(__dirname, 'assets/ai.png'));
  await page.waitForFunction(() => [...document.querySelectorAll('#ed-sources .src.on span')].some((s) => s.textContent === 'Gemini'));
  check(true, 'résultat Gemini importé et sélectionné');
  await page.screenshot({ path: `${OUT}/05b-gemini-app.png`, fullPage: true });
  await page.fill('#ai-extra', '');

  // --- Réglages IA
  await page.click('a[data-tab="settings"]');
  await page.fill('#set-key', 'TEST-KEY');
  await page.click('#set-test');
  await page.waitForFunction(() => document.querySelector('#set-test-status').textContent.includes('valide'));
  const opts = await page.$$eval('#set-model option', (o) => o.map((x) => x.textContent));
  check(opts[0].includes('gemini-2.5-flash-image') && opts.length === 3, `modèles d’image listés : ${opts.join(' | ')}`);
  await page.screenshot({ path: `${OUT}/06-settings.png`, fullPage: true });

  // --- Génération IA (mode clé API)
  await page.click('a[data-tab="editor"]');
  await page.click('#ai-mode [data-mode="api"]');
  check(!(await page.isDisabled('#ai-go')), 'bouton Générer actif');
  await page.fill('#ai-extra', 'ambiance nocturne');
  await page.click('#ai-go');
  await page.waitForFunction(() => [...document.querySelectorAll('#ed-sources .src.on span')].some((s) => s.textContent.startsWith('IA')), null, { timeout: 15000 });
  const g = log.gemini[0];
  check(g && g.url.endsWith('gemini-2.5-flash-image:generateContent'), `appel Gemini sur le bon modèle (${g?.url})`);
  const parts = g.body.contents[0].parts;
  check(parts.filter((p) => p.inline_data).length === 2, '2 images envoyées (art + photo)');
  check(parts.at(-1).text.includes('ambiance nocturne') && parts.at(-1).text.includes('Sol Ring'), 'prompt avec thème et instructions');
  check(g.body.generationConfig.imageConfig.aspectRatio === '4:3', `ratio demandé ${g.body.generationConfig.imageConfig.aspectRatio}`);
  const aiPx = await px(372, 350);
  check(aiPx[0] > 200 && aiPx[1] > 200 && aiPx[2] < 80, `image IA affichée sans les anciens réglages (${aiPx})`);
  check((await page.inputValue('#ed-harmony')) === '0', 'réglages remis à zéro pour la nouvelle image');
  await page.screenshot({ path: `${OUT}/07-ai.png`, fullPage: true });

  // --- Ajout à la planche (x2)
  await page.click('.action-bar .qty button[data-d="1"]');
  await page.click('#ed-add');
  await page.waitForFunction(() => document.querySelector('#sheet-badge').textContent === '2');
  check(true, 'badge planche = 2');

  // --- Import de decklist
  await page.click('a[data-tab="search"]');
  await page.click('#btn-import');
  await page.fill('#import-text', 'Commander\n1 Sol Ring (C21) 263\n1x Arcane Signet [Ramp]\n10 Forest\n1 Nonexistent Card');
  await page.selectOption('#import-lang', 'en');
  await page.click('#import-go');
  await page.waitForFunction(() => document.querySelector('#import-progress').textContent.includes('ajoutée'), null, { timeout: 20000 });
  const prog = await page.textContent('#import-progress');
  check(prog.startsWith('2 cartes') && prog.includes('Nonexistent'), `import : ${prog}`);
  await page.screenshot({ path: `${OUT}/08-import.png` });
  await page.click('#import-cancel');

  // --- Planche + PDF
  await page.click('a[data-tab="sheet"]');
  await page.waitForSelector('.sheet-item');
  check((await page.$$('.sheet-item')).length === 3, '3 lignes sur la planche');
  check((await page.textContent('#sheet-summary')).startsWith('4 cartes'), `résumé : ${await page.textContent('#sheet-summary')}`);
  await page.screenshot({ path: `${OUT}/09-sheet.png`, fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pdf-go')]);
  await dl.saveAs(`${OUT}/proxies.pdf`);
  check(fs.statSync(`${OUT}/proxies.pdf`).size > 50000, 'PDF téléchargé');

  // --- Modifier une carte depuis la planche
  await page.click('.sheet-item:first-child .side .btn');
  await page.waitForFunction(() => document.querySelector('#ed-add').textContent.includes('Mettre à jour') && document.querySelector('#preview-loading').hidden);
  check(true, 'édition depuis la planche');

  // --- Rechargement : le brouillon revient
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#editor').hidden && document.querySelector('#preview-loading').hidden && document.querySelector('#ed-name').textContent);
  check((await page.textContent('#ed-name')) === 'Sol Ring', 'brouillon restauré après rechargement');

  // --- Recherche par filtres
  await page.click('a[data-tab="search"]');
  await page.click('#btn-filters');
  await page.click('#f-colors .mana[data-c="g"]');
  await page.selectOption('#f-type', 'creature');
  await page.click('#filters button[type="submit"]');
  await page.waitForSelector('#results .card-tile');
  const lastQ = log.scryfall.filter((l) => l.startsWith('GET /cards/search')).at(-1);
  check(lastQ.includes('c>=g') && lastQ.includes('t:creature'), `requête filtres : ${lastQ}`);
  await page.screenshot({ path: `${OUT}/10-filters.png`, fullPage: true });

  // Mode sombre + grand écran
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('a[data-tab="editor"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/11-dark.png` });
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await install(desk);
  const dp = await desk.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  await dp.goto(BASE + '#search');
  await dp.fill('#q', 'sol');
  await dp.press('#q', 'Enter');
  await dp.waitForSelector('#results .card-tile');
  await dp.click('#results .card-tile');
  await dp.waitForFunction(() => document.querySelector('#preview-loading').hidden && document.querySelector('#ed-name').textContent);
  await dp.screenshot({ path: `${OUT}/12-desktop.png` });
  await desk.close();

  check(errors.length === 0, `aucune erreur JS (${errors.join(' / ')})`);
  await browser.close();
  console.log(failures ? `\n${failures} échec(s)` : '\nTout est OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
