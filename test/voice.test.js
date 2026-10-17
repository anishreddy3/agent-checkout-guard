// The dynamic-linking rule for voice step-up: approval needs the amount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceOutcome, VOICE_LANGUAGES } from '../server/voice.js';

const total = 19900; // $199.00

test('approve with the matching amount approves', () => {
  assert.equal(voiceOutcome({ decision: 'approve', spoken_amount: 199 }, total).action, 'approve');
  assert.equal(voiceOutcome({ decision: 'approve', spoken_amount: 199.4 }, total).action, 'approve');
});

test('approve without an amount, or with the wrong amount, does nothing', () => {
  assert.equal(voiceOutcome({ decision: 'approve', spoken_amount: null }, total).action, null);
  assert.equal(voiceOutcome({ decision: 'approve', spoken_amount: 179 }, total).action, null);
  assert.match(voiceOutcome({ decision: 'approve', spoken_amount: 179 }, total).reason, /179\.00.*199\.00/);
  assert.equal(voiceOutcome({ decision: 'approve', spoken_amount: 'abc' }, total).action, null);
});

test('reject needs no amount; unclear does nothing', () => {
  assert.equal(voiceOutcome({ decision: 'reject', spoken_amount: null }, total).action, 'reject');
  assert.equal(voiceOutcome({ decision: 'unclear', spoken_amount: 199 }, total).action, null);
});

test('language list covers major JAPAC languages, Indic ones marked for Sarvam', () => {
  const codes = VOICE_LANGUAGES.map((l) => l.code);
  for (const c of ['en-US', 'cmn-CN', 'hi-IN', 'ja-JP', 'id-ID', 'ko-KR', 'vi-VN', 'th-TH']) assert.ok(codes.includes(c), c);
  assert.ok(VOICE_LANGUAGES.filter((l) => l.indic).every((l) => l.code.endsWith('-IN')));
});
