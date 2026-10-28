// Génération gratuite via un « Space » Hugging Face (application Gradio hébergée gratuitement
// sur des GPU partagés, avec un quota quotidien par compte).
//
// Les Spaces changent souvent d'interface : plutôt que de coder en dur les paramètres, on lit
// la description de l'API (/info) et on remplit automatiquement images, consignes et options.

const HUB = 'https://huggingface.co/api/spaces/';

// Essayés dans l'ordre jusqu'à en trouver un qui répond (modèles d'édition d'image ouverts).
export const DEFAULT_SPACES = [
  'Qwen/Qwen-Image-Edit-2511',
  'Qwen/Qwen-Image-Edit-2509',
  'Qwen/Qwen-Image-Edit',
  'black-forest-labs/FLUX.1-Kontext-Dev',
];

const BROKEN_STAGES = ['PAUSED', 'STOPPED', 'RUNTIME_ERROR', 'BUILD_ERROR', 'CONFIG_ERROR', 'NO_APP_FILE', 'DELETING'];

const authHeaders = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const comp = (p) => String(p?.component || '').toLowerCase();
const text = (p) => `${p?.label || ''} ${p?.parameter_name || ''}`.toLowerCase();

function hfError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// Adresse *.hf.space d'un Space (« Owner/Nom_Du.Space » -> owner-nom-du-space.hf.space).
export function spaceHost(id) {
  return `https://${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.hf.space`;
}

async function lookupSpace(id, token, signal) {
  try {
    const r = await fetch(HUB + id, { headers: authHeaders(token), signal });
    if (r.status === 404 || r.status === 401) return { missing: true };
    if (r.ok) {
      const d = await r.json();
      const stage = d.runtime?.stage;
      if (BROKEN_STAGES.includes(stage)) return { broken: stage };
      if (d.host) return { host: d.host };
      if (d.subdomain) return { host: `https://${d.subdomain}.hf.space` };
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    /* annuaire injoignable : on tente l'adresse calculée */
  }
  return { host: spaceHost(id) };
}

async function readInfo(host, token, signal) {
  for (const prefix of ['/gradio_api', '']) {
    try {
      const r = await fetch(`${host}${prefix}/info`, { headers: authHeaders(token), signal });
      if (!r.ok) continue;
      const info = await r.json();
      if (info?.named_endpoints) return { info, prefix };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  return null;
}

const isImage = (p) => comp(p) === 'image';
const isGallery = (p) => comp(p) === 'gallery';
const isTextbox = (p) => comp(p) === 'textbox';
const isPrompt = (p) => isTextbox(p) && /prompt|instruction|edit|text/.test(text(p)) && !/negative/.test(text(p));

// Choisit l'endpoint qui prend des images + une consigne et rend une image.
export function pickEndpoint(info) {
  let best = null;
  for (const [name, ep] of Object.entries(info.named_endpoints || {})) {
    const ps = ep.parameters || [];
    const imgs = ps.filter(isImage).length;
    const gallery = ps.some(isGallery);
    const prompt = ps.some(isPrompt) || ps.some(isTextbox);
    const outImage = (ep.returns || []).some((r) => ['image', 'gallery'].includes(comp(r)));
    if (!(imgs || gallery) || !prompt || !outImage) continue;
    const score = (gallery ? 3 : 0) + imgs + (/infer|edit|generate|run|predict/.test(name) ? 1 : 0);
    if (!best || score > best.score) best = { name, ep, score, maxImages: gallery ? 3 : imgs };
  }
  return best;
}

/**
 * Trouve un Space utilisable. Retourne { id, host, prefix, endpoint, maxImages }.
 * spaceId vide = on essaie la liste par défaut ; skip = Spaces déjà essayés sans succès.
 */
export async function resolveSpace(spaceId, token, signal, skip = []) {
  const candidates = (spaceId ? [spaceId] : DEFAULT_SPACES).filter((id) => !skip.includes(id));
  const problems = [];
  for (const id of candidates) {
    const look = await lookupSpace(id, token, signal);
    if (look.missing) {
      problems.push(`${id} : introuvable`);
      continue;
    }
    if (look.broken) {
      problems.push(`${id} : indisponible (${look.broken})`);
      continue;
    }
    const got = await readInfo(look.host, token, signal);
    if (!got) {
      problems.push(`${id} : ne répond pas (il démarre peut-être)`);
      continue;
    }
    const ep = pickEndpoint(got.info);
    if (!ep) {
      problems.push(`${id} : interface non reconnue`);
      continue;
    }
    return { id, host: look.host, prefix: got.prefix, endpoint: ep.name, maxImages: ep.maxImages, params: ep.ep.parameters };
  }
  throw hfError(`Aucun service gratuit disponible pour le moment. ${problems.join(' · ')}`, { code: 'no_space' });
}

async function upload(ctx, file, token, signal) {
  const fd = new FormData();
  fd.append('files', file, file.name);
  const r = await fetch(`${ctx.host}${ctx.prefix}/upload`, { method: 'POST', body: fd, headers: authHeaders(token), signal });
  if (!r.ok) throw hfError(`Envoi de l'image refusé (${r.status}).`, { status: r.status });
  const paths = await r.json();
  return { path: paths[0], orig_name: file.name, size: file.size, mime_type: file.type, meta: { _type: 'gradio.FileData' } };
}

// Remplit les paramètres de l'endpoint à partir de leur type et de leur libellé.
export function buildData(params, files, prompt) {
  const queue = [...files];
  let promptUsed = false;
  const firstText = params.findIndex(isPrompt) >= 0 ? params.findIndex(isPrompt) : params.findIndex(isTextbox);
  return params.map((p, i) => {
    if (isGallery(p)) {
      const all = queue.splice(0);
      return all.map((f) => ({ image: f, caption: null }));
    }
    if (isImage(p)) return queue.shift() || null;
    if (i === firstText && !promptUsed) {
      promptUsed = true;
      return prompt;
    }
    if (/random/.test(text(p)) && /seed/.test(text(p))) return true;
    if (p.parameter_has_default) return p.parameter_default;
    if (comp(p) === 'checkbox') return false;
    return null;
  });
}

function parseEvents(raw) {
  const events = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) current = { event: line.slice(6).trim(), data: '' };
    else if (line.startsWith('data:') && current) {
      current.data = line.slice(5).trim();
      events.push(current);
      current = null;
    }
  }
  return events;
}

function findFile(x) {
  if (!x) return null;
  if (Array.isArray(x)) {
    for (const v of x) {
      const f = findFile(v);
      if (f) return f;
    }
    return null;
  }
  if (typeof x === 'object') {
    if (x.image) return findFile(x.image);
    if (x.url || x.path) return x;
    if (x.value) return findFile(x.value);
  }
  if (typeof x === 'string' && /\.(png|jpe?g|webp)(\?|$)/i.test(x)) return { path: x };
  return null;
}

/**
 * Génère une image. files : [File] dans l'ordre illustration puis photo.
 */
export async function generateHF({ ctx, token, files, prompt, signal }) {
  const uploaded = [];
  for (const f of files) uploaded.push(await upload(ctx, f, token, signal));
  const data = buildData(ctx.params, uploaded, prompt);
  const name = ctx.endpoint.replace(/^\//, '');
  const r = await fetch(`${ctx.host}${ctx.prefix}/call/${name}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal,
  });
  if (!r.ok) throw hfError(`Le service a refusé la demande (${r.status}).`, { status: r.status });
  const { event_id: eventId } = await r.json();
  const stream = await fetch(`${ctx.host}${ctx.prefix}/call/${name}/${eventId}`, { headers: authHeaders(token), signal });
  if (!stream.ok) throw hfError(`Résultat indisponible (${stream.status}).`, { status: stream.status });
  const events = parseEvents(await stream.text());
  const err = events.find((e) => e.event === 'error');
  if (err) {
    let msg = '';
    try {
      msg = JSON.parse(err.data) || '';
    } catch {
      msg = err.data || '';
    }
    const quota = /quota|exceeded|limit/i.test(String(msg));
    throw hfError(
      quota
        ? `Quota gratuit du jour atteint sur Hugging Face. ${msg}`
        : `Le service gratuit a échoué${msg && msg !== 'null' ? ` : ${msg}` : ' (il est peut-être surchargé, réessaie dans un moment)'}.`,
      { code: quota ? 'quota' : 'failed' },
    );
  }
  const done = events.filter((e) => e.event === 'complete').pop();
  if (!done) throw hfError('Pas de résultat reçu du service gratuit.', { code: 'failed' });
  const file = findFile(JSON.parse(done.data));
  if (!file) throw hfError('Le service a répondu sans image.', { code: 'failed' });
  const url = file.url || `${ctx.host}${ctx.prefix}/file=${file.path}`;
  const img = await fetch(url, { signal });
  if (!img.ok) throw hfError(`Image générée introuvable (${img.status}).`, { code: 'failed' });
  return img.blob();
}
