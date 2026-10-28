// Faux Scryfall + faux Gemini pour tester l'app sans réseau.
const fs = require('fs');
const path = require('path');
const path_ = path;
const A = path.join(__dirname, 'assets');

const imgs = (n) => ({
  small: `https://cards.scryfall.io/small/front/${n}.jpg`,
  normal: `https://cards.scryfall.io/normal/front/${n}.jpg`,
  large: `https://cards.scryfall.io/large/front/${n}.jpg`,
  png: `https://cards.scryfall.io/png/front/${n}.png`,
  art_crop: `https://cards.scryfall.io/art_crop/front/${n}.jpg`,
});
const card = (id, o) => ({
  object: 'card', id, oracle_id: o.oracle || 'oracle-sol', name: o.name || 'Sol Ring', printed_name: o.printed,
  lang: o.lang || 'en', set: o.set, set_name: o.setName, collector_number: o.cn || '1', released_at: o.date,
  frame: o.frame || '2015', border_color: o.border || 'black', full_art: !!o.full, image_status: 'highres_scan',
  digital: false, type_line: o.type || 'Artifact', layout: 'normal', image_uris: imgs(o.img),
});
const EN = [
  card('bless-1', { set: 'sld', setName: 'Secret Lair', date: '2024-05-01', border: 'borderless', img: 'bless', cn: '9' }),
  card('m15-1', { set: 'c21', setName: 'Commander 2021', date: '2021-04-23', img: 'm15', cn: '263' }),
  card('old-1', { set: '5ed', setName: 'Fifth Edition', date: '1997-03-24', frame: '1997', img: 'old', cn: '399' }),
];
const FR = [card('m15fr-1', { set: 'c21', setName: 'Commander 2021', date: '2021-04-23', img: 'm15fr', lang: 'fr', printed: 'Anneau solaire', cn: '263' })];
const SIGNET = card('signet-1', { oracle: 'oracle-signet', name: 'Arcane Signet', set: 'cmr', setName: 'Commander Legends', date: '2020-11-20', img: 'm15', cn: '297' });
const FOREST = card('forest-1', { oracle: 'oracle-forest', name: 'Forest', set: 'dmu', setName: 'Dominaria United', date: '2022-09-09', img: 'old', type: 'Basic Land — Forest' });

const log = { gemini: [], scryfall: [], hf: [] };
const flags = { hfQuota: false };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const list = (data) => ({ object: 'list', total_cards: data.length, has_more: false, data });

async function install(context) {
  await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/css' }, body: '' }));
  await context.route('https://svgs.scryfall.io/**', (r) => r.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#c9a227"/></svg>' }));
  await context.route('https://cards.scryfall.io/**', (r) => {
    const u = new URL(r.request().url());
    const [, kind, , file] = u.pathname.split('/');
    const name = file.replace(/\.\w+$/, '');
    const f = kind === 'png' ? `${name}.png` : kind === 'art_crop' ? `${name}_art.jpg` : `${name}.jpg`;
    r.fulfill({ status: 200, headers: { ...cors, 'Content-Type': f.endsWith('png') ? 'image/png' : 'image/jpeg' }, body: fs.readFileSync(path.join(A, f)) });
  });
  await context.route('https://api.scryfall.com/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const q = u.searchParams.get('q') || '';
    log.scryfall.push(`${req.method()} ${u.pathname} ${q}`);
    if (u.pathname === '/cards/autocomplete') return json(r, { object: 'catalog', data: ['Sol Ring', 'Solemn Simulacrum'] });
    if (u.pathname === '/cards/named') return json(r, EN[1]);
    if (u.pathname === '/cards/random') return json(r, EN[2]);
    if (u.pathname === '/cards/collection') {
      const ids = JSON.parse(req.postData()).identifiers;
      const data = [];
      const not_found = [];
      for (const id of ids) {
        const n = (id.name || '').toLowerCase();
        if (n === 'sol ring' || (id.set === 'c21' && id.collector_number === '263')) data.push(EN[1]);
        else if (n === 'arcane signet') data.push(SIGNET);
        else if (n === 'forest') data.push(FOREST);
        else not_found.push(id);
      }
      return json(r, { object: 'list', data, not_found });
    }
    if (u.pathname === '/cards/search') {
      if (q.includes('oracleid:oracle-sol') && q.includes('lang:fr')) return json(r, list(FR));
      if (q.includes('oracleid:oracle-sol')) return json(r, list(EN));
      if (q.includes('oracleid:oracle-signet')) return q.includes('lang:en') ? json(r, list([SIGNET])) : json(r, { object: 'error', code: 'not_found' }, 404);
      if (q.includes('oracleid:')) return json(r, { object: 'error', code: 'not_found' }, 404);
      if (q.includes('lang:fr')) return /sol|anneau/i.test(q) ? json(r, list(FR)) : json(r, { object: 'error', code: 'not_found' }, 404);
      return json(r, list([EN[1], SIGNET]));
    }
    return json(r, { object: 'error', code: 'not_found' }, 404);
  });
  // --- Faux Hugging Face : un Space multi-images (Gallery) et un Space à image unique.
  const SPACES = {
    'Qwen/Qwen-Image-Edit-2509': {
      host: 'https://qwen-qwen-image-edit-2509.hf.space',
      endpoints: {
        '/infer': {
          parameters: [
            { label: 'Input images', parameter_name: 'images', component: 'Gallery', parameter_has_default: false },
            { label: 'Prompt', parameter_name: 'prompt', component: 'Textbox', parameter_has_default: false },
            { label: 'Seed', parameter_name: 'seed', component: 'Slider', parameter_has_default: true, parameter_default: 0 },
            { label: 'Randomize seed', parameter_name: 'randomize_seed', component: 'Checkbox', parameter_has_default: true, parameter_default: false },
            { label: 'Steps', parameter_name: 'num_inference_steps', component: 'Slider', parameter_has_default: true, parameter_default: 40 },
          ],
          returns: [{ label: 'Result', component: 'Gallery' }, { label: 'Seed', component: 'Number' }],
        },
        '/lambda': { parameters: [], returns: [] },
      },
    },
    'black-forest-labs/FLUX.1-Kontext-Dev': {
      host: 'https://black-forest-labs-flux-1-kontext-dev.hf.space',
      endpoints: {
        '/infer': {
          parameters: [
            { label: 'Upload the image for editing', parameter_name: 'input_image', component: 'Image', parameter_has_default: true, parameter_default: null },
            { label: 'Prompt', parameter_name: 'prompt', component: 'Textbox', parameter_has_default: false },
            { label: 'Seed', parameter_name: 'seed', component: 'Slider', parameter_has_default: true, parameter_default: 42 },
            { label: 'Randomize seed', parameter_name: 'randomize_seed', component: 'Checkbox', parameter_has_default: true, parameter_default: false },
          ],
          returns: [{ label: 'Result', component: 'Image' }, { label: 'Seed', component: 'Number' }],
        },
      },
    },
  };
  await context.route('https://huggingface.co/api/spaces/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const id = decodeURIComponent(new URL(r.request().url()).pathname.replace('/api/spaces/', ''));
    const sp = SPACES[id];
    if (!sp) return json(r, { error: 'Repository not found' }, 404);
    return json(r, { id, host: sp.host, runtime: { stage: 'RUNNING' } });
  });
  for (const [id, sp] of Object.entries(SPACES)) {
    await context.route(`${sp.host}/**`, async (r) => {
      const req = r.request();
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      const u = new URL(req.url());
      const path = u.pathname;
      if (path === '/gradio_api/info') return json(r, { named_endpoints: sp.endpoints, unnamed_endpoints: {} });
      if (path === '/gradio_api/upload') {
        const n = log.hf.filter((l) => l.type === 'upload').length;
        log.hf.push({ type: 'upload', id, size: (req.postDataBuffer() || []).length });
        return json(r, [`/tmp/gradio/up${n}/file.jpg`]);
      }
      if (path === '/gradio_api/call/infer' && req.method() === 'POST') {
        log.hf.push({ type: 'call', id, body: JSON.parse(req.postData()), auth: req.headers().authorization || '' });
        return json(r, { event_id: 'ev1' });
      }
      if (path === '/gradio_api/call/infer/ev1') {
        await new Promise((res) => setTimeout(res, 800));
        const body = flags.hfQuota
          ? 'event: error\ndata: "You have exceeded your free GPU quota (60s requested vs. 12s left). Try again in 20:12:05"\n\n'
          : `event: generating\ndata: null\n\nevent: complete\ndata: ${JSON.stringify(
              id.startsWith('Qwen')
                ? [[{ image: { path: '/tmp/gradio/out.png', url: `${sp.host}/gradio_api/file=/tmp/gradio/out.png` }, caption: null }], 123]
                : [{ path: '/tmp/gradio/out.png', url: null }, 123],
            )}\n\n`;
        return r.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'text/event-stream' }, body });
      }
      if (path.startsWith('/gradio_api/file=')) {
        return r.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'image/png' }, body: fs.readFileSync(path_.join(A, 'ai.png')) });
      }
      return json(r, { detail: 'Not Found' }, 404);
    });
  }
  await context.route('https://generativelanguage.googleapis.com/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    if (req.headers()['x-goog-api-key'] !== 'TEST-KEY') return json(r, { error: { code: 400, message: 'API key not valid.' } }, 400);
    if (u.pathname.endsWith('/models')) {
      return json(r, { models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-image', displayName: 'Nano Banana', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3-pro-image-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
      ] });
    }
    const body = JSON.parse(req.postData());
    log.gemini.push({ url: u.pathname, body });
    await new Promise((res) => setTimeout(res, 1200));
    return json(r, { candidates: [{ content: { parts: [{ text: 'Voici.' }, { inlineData: { mimeType: 'image/png', data: fs.readFileSync(path.join(A, 'ai.png')).toString('base64') } }] } }] });
  });
}
module.exports = { install, log, flags };
