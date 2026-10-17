// Thin Gemini wrapper. Works with a Google AI Studio key (GEMINI_API_KEY) or
// with Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT +
// GOOGLE_CLOUD_LOCATION). Every caller has a deterministic fallback so the
// app still runs with no model configured.
//
// Default model is Gemini 3 Flash. If a call fails or times out it is retried
// once on GEMINI_FALLBACK_MODEL (Gemini 2.5 Flash), so a capacity blip on a
// preview model never stalls a checkout.

let client = null;
let disabledReason = null;

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
export const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';

export function geminiStatus() {
  const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
  const configured = Boolean(process.env.GEMINI_API_KEY) || (useVertex && process.env.GOOGLE_CLOUD_PROJECT);
  return { configured: Boolean(configured), model: GEMINI_MODEL, fallback_model: GEMINI_FALLBACK_MODEL, vertex: useVertex, disabledReason };
}

export async function getGemini() {
  if (client) return client;
  if (!geminiStatus().configured) return null;
  try {
    const { GoogleGenAI } = await import('@google/genai');
    if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
      client = new GoogleGenAI({
        vertexai: true,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        // Gemini 3 models are served from the global endpoint.
        location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
      });
    } else {
      client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    return client;
  } catch (err) {
    disabledReason = err.message;
    return null;
  }
}

const isGemini3 = (model) => /^gemini-3/.test(model);

// Per-model config. thinking 'none' is for short, well-specified tasks
// (explanations, extraction, voice) and cuts seconds of latency; 'low' is for
// the buyer agent's multi-step tool use. Gemini 3 takes a thinking level
// instead of a budget and is meant to run at its default temperature; 2.5
// keeps the temperature asked for.
export function modelConfig(model, { temperature, thinking = 'none' } = {}) {
  if (isGemini3(model)) {
    const none = model === 'gemini-3-flash-preview' ? 'MINIMAL' : 'LOW';
    return { thinkingConfig: { thinkingLevel: thinking === 'none' ? none : 'LOW' } };
  }
  return {
    thinkingConfig: { thinkingBudget: thinking === 'none' ? 0 : 1024 },
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

// generateContent on the primary model, then once on the fallback. Each
// attempt gets its own timeout. Returns { res, model } or throws the last error.
export async function generateWithFallback({ contents, config = {}, timeoutMs = 8000, temperature, thinking = 'none', models }) {
  const ai = await getGemini();
  if (!ai) throw new Error('Gemini not configured');
  const order = models ?? (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL ? [GEMINI_MODEL, GEMINI_FALLBACK_MODEL] : [GEMINI_MODEL]);
  let lastErr;
  for (const model of order) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await ai.models.generateContent({
        model,
        contents,
        config: { ...config, ...modelConfig(model, { temperature, thinking }), abortSignal: ctrl.signal },
      });
      return { res, model };
    } catch (err) {
      lastErr = err;
      disabledReason = `${model}: ${err.message}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Plain text generation. Returns null on any failure.
export async function generateText(prompt, { timeoutMs = 8000, temperature = 0.2, system } = {}) {
  try {
    const { res } = await generateWithFallback({ contents: prompt, config: { systemInstruction: system }, timeoutMs, temperature });
    return res.text?.trim() || null;
  } catch {
    return null;
  }
}

// JSON generation. Returns parsed object or null.
export async function generateJson(prompt, { schema, timeoutMs = 10000, temperature = 0.1, system } = {}) {
  try {
    const { res } = await generateWithFallback({
      contents: prompt,
      config: { systemInstruction: system, responseMimeType: 'application/json', responseSchema: schema },
      timeoutMs,
      temperature,
    });
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}
