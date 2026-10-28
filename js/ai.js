// Génération d'illustrations par IA avec la clé API de l'utilisateur.
// Les appels partent directement du téléphone vers Google ou OpenAI : la clé ne transite
// par aucun autre serveur.

import { base64ToBlob, blobToBase64 } from './util.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    fallbackModel: 'gemini-2.5-flash-image',
  },
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    fallbackModel: 'gpt-image-1',
  },
};

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI = 'https://api.openai.com/v1';

async function readError(res) {
  let msg = `Erreur ${res.status}`;
  try {
    const d = await res.json();
    msg = d?.error?.message || msg;
  } catch {
    /* corps vide */
  }
  if (res.status === 401 || res.status === 403) msg = `Clé API refusée : ${msg}`;
  if (res.status === 429) msg = `Quota ou limite atteint : ${msg}`;
  const e = new Error(msg);
  e.status = res.status;
  return e;
}

// ---------- Modèles disponibles ----------

export async function listModels(provider, key) {
  if (provider === 'gemini') {
    const res = await fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await readError(res);
    const d = await res.json();
    return (d.models || [])
      .filter((m) => /image/i.test(m.name) && !/imagen/i.test(m.name))
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
  }
  const res = await fetch(`${OPENAI}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw await readError(res);
  const d = await res.json();
  return (d.data || []).filter((m) => /^gpt-image/.test(m.id)).map((m) => ({ id: m.id, label: m.id }));
}

const versionOf = (id) => {
  const m = id.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

// Choix automatique : pour Gemini on privilégie la gamme « flash » (rapide et moins chère),
// la version la plus récente, et une version stable plutôt qu'une « preview ».
export function pickModel(provider, models) {
  if (!models.length) return PROVIDERS[provider].fallbackModel;
  const ids = models.map((m) => m.id);
  const dated = (id) => /\d{4}-\d{2}-\d{2}|\d{2}-\d{4}$/.test(id);
  if (provider === 'gemini') {
    return ids
      .slice()
      .sort((a, b) => {
        const fa = /flash/.test(a) ? 0 : 1;
        const fb = /flash/.test(b) ? 0 : 1;
        if (fa !== fb) return fa - fb;
        const lite = (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0);
        if (lite) return lite;
        const v = versionOf(b) - versionOf(a);
        if (v) return v;
        const pa = /preview|exp/.test(a) || dated(a) ? 1 : 0;
        const pb = /preview|exp/.test(b) || dated(b) ? 1 : 0;
        return pa - pb;
      })[0];
  }
  const versionOfImg = (id) => versionOf(id.replace(/^gpt-image-?/, '')) || 1;
  return ids
    .slice()
    .sort((a, b) => {
      const ma = /mini/.test(a) ? 1 : 0;
      const mb = /mini/.test(b) ? 1 : 0;
      if (ma !== mb) return ma - mb;
      const v = versionOfImg(b) - versionOfImg(a);
      if (v) return v;
      return (dated(a) ? 1 : 0) - (dated(b) ? 1 : 0);
    })[0];
}

// ---------- Prompts ----------

export const PRESETS = {
  style: {
    label: 'Ta photo, style de l’original',
    hint: 'Ta photo est repeinte avec la technique, les couleurs et l’ambiance de l’illustration officielle.',
    needsPhoto: true,
    usesArt: true,
  },
  fusion: {
    label: 'Ta photo dans la scène',
    hint: 'Le sujet de ta photo est intégré dans la scène de l’illustration officielle.',
    needsPhoto: true,
    usesArt: true,
  },
  fantasy: {
    label: 'Ta photo en art fantasy',
    hint: 'Ta photo devient une illustration de fantasy épique, sans s’appuyer sur l’art original.',
    needsPhoto: true,
    usesArt: false,
  },
  remix: {
    label: 'Original revisité',
    hint: 'L’illustration officielle est réinterprétée selon tes instructions (ex. « style estampe japonaise »).',
    needsPhoto: false,
    usesArt: true,
  },
};

export function buildPrompt(preset, { cardName, typeLine, useTheme, extra, ratioLabel }) {
  const lines = [];
  if (preset === 'style') {
    lines.push(
      'IMAGE A is an official fantasy trading-card illustration: use it ONLY as the style reference.',
      'IMAGE B is a personal photo: it defines the content.',
      'Repaint IMAGE B as a brand-new fantasy trading-card illustration in the exact artistic style of IMAGE A: same medium and brushwork, color palette, lighting, contrast, level of detail and atmosphere.',
      'Keep the subjects, poses and overall composition of IMAGE B clearly recognizable (people, animals, vehicles and objects must stay identifiable). Do not copy the content of IMAGE A, only its style.',
    );
  } else if (preset === 'fusion') {
    lines.push(
      'IMAGE A is an official fantasy trading-card illustration. IMAGE B is a personal photo.',
      'Take the main subject of IMAGE B and integrate it into the scene of IMAGE A as the central figure, as if the original artist had painted it there.',
      "Keep IMAGE A's setting, composition, lighting and painting style. Adapt the subject's lighting, outfit and pose so it belongs naturally in the scene, while keeping it recognizable.",
    );
  } else if (preset === 'fantasy') {
    lines.push(
      'The image is a personal photo.',
      'Transform it into an epic fantasy trading-card illustration: painterly digital painting, dramatic cinematic lighting, rich details, in the tradition of classic fantasy card game artwork.',
      'Keep the subjects recognizable.',
    );
  } else {
    lines.push(
      'IMAGE A is an official fantasy trading-card illustration.',
      'Re-imagine it as a new illustration: keep its subject and composition recognizable, but change the artistic treatment according to the instructions below.',
    );
    if (!extra) lines.push('Use a fresh, painterly style.');
  }
  if (useTheme && cardName) {
    lines.push(`The card is "${cardName}"${typeLine ? ` (${typeLine})` : ''}. Let the mood and any added elements evoke this card's theme.`);
  }
  if (extra) lines.push(`Additional instructions from the user (they may be written in French): ${extra}`);
  lines.push(
    `Output one finished illustration in landscape orientation (about ${ratioLabel} width:height) that fills the entire frame edge to edge.`,
    'Absolutely no text, letters, numbers, logos, signatures, watermarks, card frames or borders.',
  );
  return lines.join('\n');
}

// ---------- Génération ----------

const GEMINI_RATIOS = ['1:1', '5:4', '4:3', '3:2', '16:9', '21:9', '4:5', '3:4', '2:3', '9:16'];

export function closestRatio(r, list = GEMINI_RATIOS) {
  let best = list[0];
  let err = Infinity;
  for (const s of list) {
    const [a, b] = s.split(':').map(Number);
    const e = Math.abs(Math.log(a / b / r));
    if (e < err) {
      err = e;
      best = s;
    }
  }
  return best;
}

/**
 * images : [{ label: 'IMAGE A', blob }] dans l'ordre où le prompt les cite.
 * Retourne un Blob image.
 */
export async function generate({ provider, key, model, prompt, images, ratio, quality = 'medium', signal }) {
  if (provider === 'gemini') return generateGemini({ key, model, prompt, images, ratio, signal });
  return generateOpenAI({ key, model, prompt, images, ratio, quality, signal });
}

async function generateGemini({ key, model, prompt, images, ratio, signal }) {
  const parts = [];
  for (const im of images) {
    parts.push({ text: `${im.label}:` });
    parts.push({ inline_data: { mime_type: im.blob.type || 'image/jpeg', data: await blobToBase64(im.blob) } });
  }
  parts.push({ text: prompt });
  const body = (withRatio) => ({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(withRatio ? { imageConfig: { aspectRatio: closestRatio(ratio) } } : {}),
    },
  });
  const call = (withRatio) =>
    fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body(withRatio)),
    });

  let res = await call(true);
  if (res.status === 400) {
    // Certains modèles n'acceptent pas imageConfig : on réessaie sans.
    const err = await readError(res);
    if (!/imageConfig|aspect/i.test(err.message)) throw err;
    res = await call(false);
  }
  if (!res.ok) throw await readError(res);
  const d = await res.json();
  const cand = d.candidates?.[0];
  const partsOut = cand?.content?.parts || [];
  const img = partsOut.find((p) => (p.inlineData || p.inline_data)?.data);
  if (!img) {
    const text = partsOut.map((p) => p.text).filter(Boolean).join(' ').trim();
    const reason = d.promptFeedback?.blockReason || cand?.finishReason;
    throw new Error(
      `Aucune image renvoyée${reason ? ` (${reason})` : ''}.${text ? ` Réponse du modèle : « ${text.slice(0, 300)} »` : ''}`,
    );
  }
  const data = img.inlineData || img.inline_data;
  return base64ToBlob(data.data, data.mimeType || data.mime_type || 'image/png');
}

async function generateOpenAI({ key, model, prompt, images, ratio, quality, signal }) {
  const fd = new FormData();
  fd.append('model', model);
  const labels = images.map((im, i) => `${im.label} is the ${['first', 'second', 'third'][i]} image`).join('; ');
  fd.append('prompt', images.length ? `${labels}.\n${prompt}` : prompt);
  images.forEach((im, i) => fd.append('image[]', im.blob, `image-${i + 1}.jpg`));
  fd.append('size', ratio >= 1.2 ? '1536x1024' : ratio <= 0.83 ? '1024x1536' : '1024x1024');
  fd.append('quality', quality);
  fd.append('n', '1');
  const res = await fetch(`${OPENAI}/images/edits`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  if (!res.ok) throw await readError(res);
  const d = await res.json();
  const item = d.data?.[0];
  if (item?.b64_json) return base64ToBlob(item.b64_json, 'image/png');
  if (item?.url) {
    const r = await fetch(item.url);
    return r.blob();
  }
  throw new Error('Aucune image renvoyée par OpenAI.');
}
