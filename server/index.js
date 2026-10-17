import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from './store/index.js';
import { listSellers, getSeller, publicCatalog } from './sellers/catalog.js';
import {
  manifest,
  baseUrl,
  createCheckout,
  getCheckout,
  updateCheckout,
  completeCheckout,
  cancelCheckout,
  UcpError,
} from './ucp/checkout.js';
import { resolveReview } from './guard/index.js';
import { policyFor, savePolicy, DEFAULT_POLICY } from './guard/policy.js';
import { startRun } from './agent/runner.js';
import { SCENARIOS } from './agent/scenarios.js';
import { geminiStatus } from './gemini.js';
import { voiceStatus, speak, writePrompt, hear, voiceOutcome, VOICE_LANGUAGES } from './voice.js';
import { keySource, publicKeys } from './ap2/keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, ucp-agent, request-id, idempotency-key, request-signature, x-admin-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- health and status ---------------------------------------------------
  // Cloud Run's frontend reserves /healthz, so health lives under /api.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get(
    '/api/status',
    wrap(async (req, res) => {
      res.json({
        service: 'agent-checkout-guard',
        store: getStore().kind,
        gemini: geminiStatus(),
        voice: voiceStatus(),
        ap2: { version: '0.2', ucp_extension: 'dev.ucp.shopping.ap2_mandate', keys: keySource() },
        ucp_version: '2026-01-11',
        sellers: listSellers().map((s) => s.id),
      });
    })
  );

  // ---- sellers: UCP discovery, catalog, checkout REST binding --------------
  app.get('/api/sellers', (req, res) => res.json(listSellers()));
  // Public verification keys: the platform Trusted Surface and each seller.
  app.get('/api/ap2/keys', (req, res) => res.json(publicKeys()));

  app.get('/sellers/:sellerId/.well-known/ucp', (req, res) => {
    const seller = getSeller(req.params.sellerId);
    if (!seller) return res.status(404).json({ error: { code: 'unknown_seller' } });
    res.json(manifest(seller, baseUrl(req)));
  });

  app.get('/sellers/:sellerId/catalog', (req, res) => {
    const cat = publicCatalog(req.params.sellerId);
    if (!cat) return res.status(404).json({ error: { code: 'unknown_seller' } });
    res.json(cat);
  });

  app.post('/sellers/:sellerId/checkout-sessions', wrap(async (req, res) => {
    res.status(201).json(await createCheckout(req, req.params.sellerId, req.body ?? {}));
  }));
  app.get('/sellers/:sellerId/checkout-sessions/:id', wrap(async (req, res) => {
    res.json(await getCheckout(req.params.sellerId, req.params.id));
  }));
  app.put('/sellers/:sellerId/checkout-sessions/:id', wrap(async (req, res) => {
    res.json(await updateCheckout(req, req.params.sellerId, req.params.id, req.body ?? {}));
  }));
  app.post('/sellers/:sellerId/checkout-sessions/:id/complete', wrap(async (req, res) => {
    res.json(await completeCheckout(req, req.params.sellerId, req.params.id, req.body ?? {}));
  }));
  app.post('/sellers/:sellerId/checkout-sessions/:id/cancel', wrap(async (req, res) => {
    res.json(await cancelCheckout(req.params.sellerId, req.params.id));
  }));

  app.get('/sellers/:sellerId/legal/:doc', (req, res) => {
    const seller = getSeller(req.params.sellerId);
    if (!seller) return res.sendStatus(404);
    res.type('text/plain').send(`${seller.name}\n${req.params.doc}\n\nIllustrative ${req.params.doc === 'privacy' ? 'privacy policy' : 'terms of service'} for a simulated seller in this agent-commerce workflow.`);
  });
  app.get('/sellers/:sellerId/orders/:orderId', (req, res) => {
    res.redirect(`/#order=${encodeURIComponent(req.params.orderId)}`);
  });
  app.get('/review/:checkoutId', (req, res) => {
    res.redirect(`/#review=${encodeURIComponent(req.params.checkoutId)}`);
  });

  // ---- buyer agent runs ----------------------------------------------------
  app.get('/api/scenarios', (req, res) =>
    res.json(SCENARIOS.map(({ plan, ...s }) => ({ ...s, purchases: plan.length * (s.repeat ?? 1) })))
  );
  app.post('/api/runs', wrap(async (req, res) => {
    const origin = process.env.SELF_ORIGIN || baseUrl(req);
    const run = await startRun({ scenarioId: req.body?.scenario_id, origin, mode: req.body?.mode });
    res.status(202).json(run);
  }));
  app.get('/api/runs', wrap(async (req, res) => {
    res.json(await getStore().query('runs', [], { orderBy: 'started_at', limit: 50 }));
  }));
  app.get('/api/runs/:id', wrap(async (req, res) => {
    const run = await getStore().get('runs', req.params.id);
    if (!run) return res.status(404).json({ error: { code: 'not_found' } });
    res.json(run);
  }));

  // ---- guard data for the dashboard ---------------------------------------
  app.get('/api/decisions', wrap(async (req, res) => {
    res.json(await getStore().query('decisions', [], { orderBy: 'at', limit: Number(req.query.limit) || 100 }));
  }));
  app.get('/api/decisions/:id', wrap(async (req, res) => {
    const d = await getStore().get('decisions', req.params.id);
    if (!d) return res.status(404).json({ error: { code: 'not_found' } });
    res.json(d);
  }));
  app.post('/api/decisions/:id/review', wrap(async (req, res) => {
    const action = req.body?.action === 'approve' ? 'approve' : 'reject';
    const d = await resolveReview(req.params.id, action, req.body?.reviewer);
    if (!d) return res.status(404).json({ error: { code: 'not_found' } });
    res.json(d);
  }));
  // ---- voice step-up -------------------------------------------------------
  // Only a pending step-up can be confirmed by voice.
  async function pendingStepUp(req, res) {
    const d = await getStore().get('decisions', req.params.id);
    if (!d) {
      res.status(404).json({ error: { code: 'not_found' } });
      return null;
    }
    if (d.outcome !== 'step_up' || d.review) {
      res.status(409).json({ error: { code: 'not_pending', message: 'This purchase is not waiting for review.' } });
      return null;
    }
    return d;
  }
  const knownLanguage = (code) => VOICE_LANGUAGES.some((l) => l.code === code);
  app.post('/api/decisions/:id/voice/prompt', wrap(async (req, res) => {
    const language = String(req.body?.language ?? '');
    if (!knownLanguage(language)) return res.status(400).json({ error: { code: 'unsupported_language' } });
    const d = await pendingStepUp(req, res);
    if (!d) return;
    const prompt = await writePrompt(d, language);
    const audio = await speak(prompt.text, language);
    res.json({ language, text: prompt.text, text_source: prompt.source, ...audio });
  }));
  app.post(
    '/api/decisions/:id/voice/answer',
    express.raw({ type: ['audio/wav', 'audio/x-wav'], limit: '4mb' }),
    wrap(async (req, res) => {
      const language = String(req.query.language ?? '');
      if (!knownLanguage(language)) return res.status(400).json({ error: { code: 'unsupported_language' } });
      if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: { code: 'no_audio', message: 'No recording received.' } });
      const d = await pendingStepUp(req, res);
      if (!d) return;
      const answer = await hear(req.body, language, d);
      const outcome = voiceOutcome(answer, d.total);
      const evidence = { channel: 'voice', language, transcript: answer.transcript, spoken_amount: answer.spoken_amount, heard_by: answer.heard_by };
      const review = outcome.action ? await resolveReview(d.id, outcome.action, `voice:${language}`, evidence) : null;
      await getStore().add('events', { type: 'review.voice_attempt', at: new Date().toISOString(), decision_id: d.id, checkout_id: d.checkout_id, agent_profile: d.agent_profile, ...evidence, decision: answer.decision, action: outcome.action });
      res.json({ ...answer, action: outcome.action, reason: outcome.reason, review: review?.review ?? null });
    })
  );

  app.get('/api/events', wrap(async (req, res) => {
    res.json(await getStore().query('events', [], { orderBy: 'at', limit: Number(req.query.limit) || 200 }));
  }));
  app.get('/api/sessions', wrap(async (req, res) => {
    const rows = await getStore().query('sessions', [], { orderBy: 'updated_at', limit: Number(req.query.limit) || 100 });
    res.json(rows);
  }));
  app.get('/api/policy', wrap(async (req, res) => {
    if (!req.query.profile) return res.json({ defaults: DEFAULT_POLICY });
    res.json(await policyFor(String(req.query.profile)));
  }));
  app.post('/api/policy', wrap(async (req, res) => {
    const { profile, policy, display_name } = req.body ?? {};
    if (!profile || !policy) return res.status(400).json({ error: { code: 'missing_fields' } });
    res.json(await savePolicy(profile, policy, display_name));
  }));
  app.post('/api/reset', wrap(async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    if (token && req.headers['x-admin-token'] !== token) return res.status(403).json({ error: { code: 'forbidden' } });
    await getStore().clear();
    res.json({ ok: true });
  }));

  // ---- dashboard (also served by Firebase Hosting in production) -----------
  app.use(express.static(WEB_DIR, { extensions: ['html'] }));

  // ---- errors --------------------------------------------------------------
  app.use((err, req, res, next) => {
    if (err instanceof UcpError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message },
        messages: [{ type: 'error', code: err.code, content: err.message, severity: 'recoverable' }],
      });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: err.message } });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => {
    console.log(`agent-checkout-guard listening on :${port} (store=${getStore().kind}, gemini=${geminiStatus().configured})`);
  });
}
