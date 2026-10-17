// Voice step-up: a human confirms (or rejects) a held purchase by speaking,
// in their own language, across the most widely spoken JAPAC languages.
//
//   Gemini  writes the spoken prompt in the reviewer's language and reads the
//           answer back into { decision, spoken amount }. For non-Indic
//           languages Gemini listens to the audio directly.
//   Sarvam  speech for Indian languages: Bulbul text-to-speech and Saaras
//           speech-to-text (handles code-mixed speech such as Hindi with
//           English numbers). Used when SARVAM_API_KEY is set.
//   Google  Cloud Text-to-Speech for every other language, and for Indian
//           languages when no Sarvam key is configured.
//
// The approval is tied to the amount (dynamic linking): the Guard only
// approves when the amount the human says matches the amount about to be
// charged. A bare "yes" is not enough.

import { GoogleAuth } from 'google-auth-library';
import { generateJson } from './gemini.js';
import { money } from './guard/rules.js';

const SARVAM = 'https://api.sarvam.ai';
const GOOGLE_TTS = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// code: BCP-47 used by the browser and Google TTS. indic: Sarvam can serve it.
export const VOICE_LANGUAGES = [
  { code: 'en-US', name: 'English', label: 'English' },
  { code: 'cmn-CN', name: 'Mandarin Chinese', label: '中文' },
  { code: 'hi-IN', name: 'Hindi', label: 'हिन्दी', indic: true },
  { code: 'ja-JP', name: 'Japanese', label: '日本語' },
  { code: 'id-ID', name: 'Indonesian', label: 'Bahasa Indonesia' },
  { code: 'bn-IN', name: 'Bengali', label: 'বাংলা', indic: true },
  { code: 'vi-VN', name: 'Vietnamese', label: 'Tiếng Việt' },
  { code: 'ko-KR', name: 'Korean', label: '한국어' },
  { code: 'th-TH', name: 'Thai', label: 'ไทย' },
  { code: 'fil-PH', name: 'Filipino', label: 'Filipino' },
  { code: 'ms-MY', name: 'Malay', label: 'Bahasa Melayu' },
  { code: 'ta-IN', name: 'Tamil', label: 'தமிழ்', indic: true },
  { code: 'te-IN', name: 'Telugu', label: 'తెలుగు', indic: true },
];

// Trimmed: a key pasted into Secret Manager often carries a trailing newline.
const sarvamKey = () => (process.env.SARVAM_API_KEY ?? '').trim();
const sarvamOn = () => Boolean(sarvamKey());
const lang = (code) => VOICE_LANGUAGES.find((l) => l.code === code) ?? null;
const useSarvam = (l) => Boolean(l?.indic && sarvamOn());

export function voiceStatus() {
  return {
    sarvam: sarvamOn(),
    languages: VOICE_LANGUAGES.map((l) => ({ code: l.code, name: l.name, label: l.label, speech: useSarvam(l) ? 'sarvam' : 'google' })),
  };
}

async function fetchJson(url, init, timeoutMs, name) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${name} ${res.status}: ${body?.error?.message ?? body?.message ?? 'request failed'}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ---- speech out --------------------------------------------------------------

let auth = null;
async function googleToken() {
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return auth.getAccessToken();
}

async function speakGoogle(text, code) {
  const token = await googleToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (project) headers['x-goog-user-project'] = project;
  const out = await fetchJson(
    GOOGLE_TTS,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: { text: text.slice(0, 4500) }, voice: { languageCode: code }, audioConfig: { audioEncoding: 'MP3' } }),
    },
    15000,
    'Cloud Text-to-Speech'
  );
  return { audio: out.audioContent, mime: 'audio/mpeg', engine: 'google' };
}

async function speakSarvam(text, code) {
  const out = await fetchJson(
    `${SARVAM}/text-to-speech`,
    {
      method: 'POST',
      headers: { 'api-subscription-key': sarvamKey(), 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 2400), language_code: code, model: 'bulbul:v3' }),
    },
    15000,
    'Sarvam text-to-speech'
  );
  return { audio: (out.audios ?? []).join(''), mime: 'audio/wav', engine: 'sarvam' };
}

export async function speak(text, code) {
  const l = lang(code);
  if (!l) throw new Error(`unsupported language ${code}`);
  return useSarvam(l) ? speakSarvam(text, code) : speakGoogle(text, code);
}

// ---- prompt, written by Gemini ------------------------------------------------

const sellerShort = (name) => String(name);

function fallbackPrompt(decision) {
  return `A buyer agent wants to pay ${money(decision.total, decision.currency)} to ${sellerShort(decision.seller_name)}. It was held for review. ${decision.explanation} To approve, say approve and the amount. To stop it, say reject.`;
}

export async function writePrompt(decision, code) {
  const l = lang(code);
  const out = await generateJson(
    [
      `Write a short spoken prompt, in ${l.name}, for a finance approver who must confirm a purchase made by an AI agent.`,
      `Two or three short sentences of natural spoken ${l.name}. Write it in the language's usual script.`,
      `Say who is being paid and the exact amount in US dollars, give the reason it was held in plain words, then ask them to say "approve" together with the amount, or "reject".`,
      `Seller: ${sellerShort(decision.seller_name)}. Amount: ${money(decision.total, decision.currency)}.`,
      `Cart: ${decision.cart.map((c) => `${c.quantity} x ${c.title}`).join('; ')}.`,
      `Why it was held: ${decision.explanation}`,
    ].join('\n'),
    { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, timeoutMs: 9000, temperature: 0.3 }
  );
  return out?.text ? { text: out.text, source: 'gemini' } : { text: fallbackPrompt(decision), source: 'template' };
}

// ---- speech in ---------------------------------------------------------------

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'What the person said, verbatim, in the script they spoke' },
    decision: { type: 'string', enum: ['approve', 'reject', 'unclear'] },
    spoken_amount: { type: 'number', nullable: true, description: 'Amount the person said, in major units (199 for $199), or null if they said none' },
    summary: { type: 'string', description: 'One short English sentence of what the person said' },
  },
  required: ['transcript', 'decision', 'spoken_amount', 'summary'],
};

function answerInstructions(decision, l) {
  return [
    `A finance approver was asked, in ${l.name}, whether to approve a purchase of ${money(decision.total, decision.currency)}.`,
    `Classify their decision (approve, reject or unclear) and extract the amount they said as a number in major units.`,
    `Numbers may be spoken as words in any language, or mixed with English. If they did not say an amount, spoken_amount is null.`,
    `Never fill in the amount from this instruction; only use what they actually said.`,
  ].join('\n');
}

async function transcribeSarvam(wav, code) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'answer.wav');
  form.append('model', 'saaras:v3');
  form.append('mode', 'codemix');
  form.append('language_code', code);
  const out = await fetchJson(
    `${SARVAM}/speech-to-text`,
    { method: 'POST', headers: { 'api-subscription-key': sarvamKey() }, body: form },
    20000,
    'Sarvam speech-to-text'
  );
  return out.transcript ?? '';
}

const UNCLEAR = (summary, transcript = '') => ({ transcript, decision: 'unclear', spoken_amount: null, summary });

// Returns { transcript, decision, spoken_amount, summary, heard_by }.
export async function hear(wav, code, decision) {
  const l = lang(code);
  if (!l) throw new Error(`unsupported language ${code}`);
  if (useSarvam(l)) {
    const transcript = await transcribeSarvam(wav, code);
    if (!transcript.trim()) return { ...UNCLEAR('Nothing was heard.'), heard_by: 'sarvam' };
    const out = await generateJson(`${answerInstructions(decision, l)}\n\nTheir answer, transcribed:\n"${transcript}"\n\nReturn the transcript unchanged.`, {
      schema: ANSWER_SCHEMA,
      timeoutMs: 9000,
      temperature: 0,
    });
    return { ...(out ?? UNCLEAR('Could not read the answer.', transcript)), transcript, heard_by: 'sarvam+gemini' };
  }
  // Gemini listens to the recording itself.
  const out = await generateJson(
    [{ text: `${answerInstructions(decision, l)}\n\nThe attached audio is their answer. Transcribe it, then classify.` }, { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } }],
    { schema: ANSWER_SCHEMA, timeoutMs: 15000, temperature: 0 }
  );
  return { ...(out ?? UNCLEAR('Could not read the answer.')), heard_by: 'gemini' };
}

// ---- the dynamic-linking rule ------------------------------------------------

// Pure: decides what a spoken answer is allowed to do. Approval requires the
// spoken amount to match the charge to within one whole unit.
export function voiceOutcome(answer, totalMinor) {
  if (answer.decision === 'reject') return { action: 'reject', reason: 'The reviewer rejected the purchase.' };
  if (answer.decision !== 'approve') return { action: null, reason: 'The answer was not a clear approve or reject. Try again or use the buttons.' };
  const spoken = Number(answer.spoken_amount);
  if (answer.spoken_amount == null || !Number.isFinite(spoken)) {
    return { action: null, reason: 'Approval needs the amount said out loud. Say approve and the amount.' };
  }
  const spokenMinor = Math.round(spoken * 100);
  if (Math.abs(spokenMinor - totalMinor) >= 100) {
    return { action: null, reason: `Heard ${(spokenMinor / 100).toFixed(2)}, but the charge is ${(totalMinor / 100).toFixed(2)}. Not approved.` };
  }
  return { action: 'approve', reason: 'Approved by voice. The spoken amount matches the charge.' };
}
