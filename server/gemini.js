// Thin Gemini wrapper. Works with a Google AI Studio key (GEMINI_API_KEY) or
// with Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT +
// GOOGLE_CLOUD_LOCATION). Every caller has a deterministic fallback so the
// app still runs with no model configured.

let client = null;
let disabledReason = null;

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export function geminiStatus() {
  const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
  const configured = Boolean(process.env.GEMINI_API_KEY) || (useVertex && process.env.GOOGLE_CLOUD_PROJECT);
  return { configured: Boolean(configured), model: GEMINI_MODEL, vertex: useVertex, disabledReason };
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
        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
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

// Short, well-specified tasks (explanations, extraction) don't need Gemini
// 2.5's thinking step; turning it off cuts latency by seconds.
const NO_THINKING = { thinkingBudget: 0 };

// Plain text generation with a timeout. Returns null on any failure.
export async function generateText(prompt, { timeoutMs = 8000, temperature = 0.2, system } = {}) {
  const ai = await getGemini();
  if (!ai) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { temperature, systemInstruction: system, thinkingConfig: NO_THINKING, abortSignal: ctrl.signal },
    });
    return res.text?.trim() || null;
  } catch (err) {
    disabledReason = err.message;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// JSON generation. Returns parsed object or null.
export async function generateJson(prompt, { schema, timeoutMs = 10000, temperature = 0.1, system } = {}) {
  const ai = await getGemini();
  if (!ai) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        temperature,
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseSchema: schema,
        thinkingConfig: NO_THINKING,
        abortSignal: ctrl.signal,
      },
    });
    return JSON.parse(res.text);
  } catch (err) {
    disabledReason = err.message;
    return null;
  } finally {
    clearTimeout(timer);
  }
}
