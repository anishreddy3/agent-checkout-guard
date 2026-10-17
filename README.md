# Agent Checkout Guard

Trusted agent checkout over the Universal Commerce Protocol (UCP).

AI agents are starting to buy things on behalf of people and companies. A buyer agent reads a seller's machine-readable catalog, creates a checkout session and completes it with a stored card, all in seconds and without a human in the loop. That is great for commerce and a new problem for risk teams: an agent can be given a stale quote, fall for instructions hidden in a product description, loop and buy the same thing twice, or burn through a budget before anyone notices.

Agent Checkout Guard puts a risk decision at the one point every agent purchase passes through: the UCP **Complete Checkout** call. Before the seller charges anything, the Guard verifies the human's signed **AP2 mandate** (what they authorised the agent to buy, from whom, and for how much), reconciles the charge with the quote the agent received, checks the cart against what the human actually asked for, applies spend, velocity and duplicate controls, and returns one of three outcomes that map directly onto UCP session states:

| Guard outcome | UCP session status | What happens |
|---|---|---|
| approve | `completed` | Order is placed |
| step_up | `requires_escalation` | A human reviews it from the dashboard via `continue_url` |
| decline | `canceled` | Nothing is charged, the agent gets a plain-language reason |

Gemini writes the explanation for every decision and powers the buyer agent in the demo.

Built for the Google Cloud AI Builder Cup 2026 (BFSI and Retail tracks). The sellers, catalogs, prices and agents are illustrative simulations of a real agent-commerce workflow. Payments use a test payment handler, so no money moves.

## What is in the box

```
server/
  index.js           Express app: UCP endpoints, Guard API, agent runs, dashboard API
  ucp/checkout.js    UCP checkout capability (create, get, update, complete, cancel)
  sellers/catalog.js Three illustrative sellers with machine-readable pricing and volume tiers
  guard/rules.js     Pure risk rules (AP2 mandate, quote mismatch, spend caps, velocity, duplicates, intent match, seller trust)
  guard/index.js     Loads history from Firestore, scores, asks Gemini to explain, persists the decision
  guard/policy.js    Per-agent spend policy with defaults
  agent/runner.js    Buyer agent: Gemini function-calling mode and a deterministic scripted mode
  agent/scenarios.js Seven demo scenarios (routine, over budget, stale quote, runaway loop, injected catalog, forged approval, velocity)
  store/index.js     Firestore persistence with an in-memory fallback
  gemini.js          Gemini client (Google AI Studio key or Vertex AI)
  ap2/jose.js        ES256 JWS (compact and detached), JSON canonicalisation (RFC 8785)
  ap2/sdjwt.js       SD-JWT (RFC 9901) and AP2 delegation chains (root + key-bound hops, "~~")
  ap2/mandates.js    AP2 Checkout and Payment Mandates: issue, close, verify, constraints, receipts
  ap2/keys.js        Seller and platform signing keys (Secret Manager in production)
  voice.js           Voice step-up: prompts, speech (Sarvam or Google), spoken-amount check
web/                 Dashboard: vanilla JS, served by Firebase Hosting
test/                Unit tests for the rules and an HTTP end-to-end test of every scenario
scripts/deploy.sh    Cloud Run + Firestore + Firebase Hosting deploy
scripts/bench.js     Benchmark: outcome accuracy and guard latency
docs/                Architecture and flow diagrams
```

## How Google Cloud is used

**Cloud Run** runs the whole backend as one container: the three illustrative sellers' UCP endpoints (`/.well-known/ucp`, `/checkout-sessions`), the Guard, and the buyer agent runner. Source-based deploy, min one instance so the evaluation link stays warm.

**Firestore** is the system of record. Collections: `sessions` (UCP checkout sessions and their quote history), `decisions` (every Guard decision with findings, explanation and latency), `events` (an append-only audit trail used for velocity and daily-spend checks), `agents` (per-agent spend policies) and `runs` (agent run traces the dashboard polls). The Guard's history queries (recent attempts by agent, completed sessions today) are Firestore queries with composite indexes in `firestore.indexes.json`.

**Firebase Hosting** serves the dashboard and rewrites `/api/**`, `/sellers/**` and `/review/**` to the Cloud Run service, so the dashboard, the API and the seller endpoints share one origin. Firestore security rules deny all client access; everything goes through the service.

**Gemini** (default `gemini-3-flash-preview` on the Vertex AI global endpoint, retried once on `gemini-2.5-flash` if a call fails or times out; Google AI Studio keys also work) does three jobs: it is the buyer agent (function calling over `list_sellers`, `get_catalog`, `buy`, `finish`), it extracts the human's purchase intent from the request text so the Guard can compare the cart with what was asked, and it writes the two-sentence explanation attached to every decision. Short tasks run with minimal thinking to keep the explanation under about a second; the buyer agent runs with low thinking for multi-step tool use and keeps one model for the whole run. Every Gemini call also has a deterministic fallback, so the service degrades to rules-only explanations and a scripted agent instead of failing.

## AP2 mandates: proof of what the human authorised

The Guard implements the [Agent Payments Protocol](https://ap2-protocol.org) (AP2 v0.2) through UCP's AP2 extension (`dev.ucp.shopping.ap2_mandate`, UCP 2026-01-11), in the Human Not Present flow with the Trusted Agent Provider model. Field names, `vct` values, constraint types and evaluation rules follow the AP2 schemas and reference SDK in [google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2).

1. **The human approves open mandates** on the buyer platform's Trusted Surface before the agent shops. Both are SD-JWTs signed with the platform's key, and both name this run's agent key in `cnf`, so only that agent can use them:
   - open Checkout Mandate (`mandate.checkout.open.1`): `checkout.allowed_merchants`, `checkout.line_items` (the items and quantities asked for)
   - open Payment Mandate (`mandate.payment.open.1`): `payment.amount_range` (the most the human will pay), `payment.allowed_payees`, `payment.reference` (bound to the open Checkout Mandate)
2. **The seller signs every checkout.** Each UCP checkout response carries `ap2.merchant_authorization`, a detached ES256 JWS over the RFC 8785 canonical checkout. Discovery (`/.well-known/ucp`) advertises the AP2 capability and the seller's `signing_keys`.
3. **The agent verifies that signature, then signs closed mandates** for that exact checkout with its own key: a closed Checkout Mandate (`mandate.checkout.1`: `checkout_jwt`, `checkout_hash`) and a closed Payment Mandate (`mandate.payment.1`: `transaction_id`, payee, amount). Each is a `kb+sd-jwt` hop bound to the open mandate by `sd_hash`, to the seller by `aud` and to the checkout by `nonce`, and chained to it with `~~`. Complete Checkout sends `ap2.checkout_mandate` and the payment mandate in `payment_data.token`.
4. **The Guard verifies both chains** before deciding: signatures up to the trusted platform key, key binding, `sd_hash`, expiry, `aud` and `nonce`; that `checkout_hash` matches `checkout_jwt` and that `checkout_jwt` carries this seller's own signature over this session's id, items and totals; every constraint (line items with the spec's max-flow rule); that the payment mandate is for this checkout and this total; and that the open mandate has not already bought something. Every Complete Checkout returns a seller-signed AP2 Checkout Receipt in `ap2.checkout_receipt`.

How the results feed the decision:

| AP2 result | Guard | Example scenario |
|---|---|---|
| Verified | No finding; other rules decide | Routine purchase |
| Charge above the amount the human signed (`unresolved_constraint`) | Step-up: AP2's fallback to a mandate the human approves directly | Quote-to-charge mismatch |
| Cart outside the mandate, or an open mandate used twice (`invalid_mandate`) | Decline | Prompt-injected catalog, Runaway loop |
| Not signed by a trusted platform key (`mandate_invalid_signature`) | Decline | Forged approval |
| Trusted platform sent no mandate (`mandate_required`) | Decline | Tested in `test/e2e.test.js` |

When a step-up is approved, from the dashboard or by voice, the Trusted Surface signs a **Human Present** closed Checkout Mandate over the seller-signed checkout. The seller verifies it before completing the order and issues a receipt, which is stored with the review.

Scope, stated plainly: the platform's Trusted Surface, the agent and the sellers all run inside this one service, with keys in Secret Manager. The user-credential flow (OpenID4VP) is not implemented. The Guard verifies the Payment Mandate on behalf of the seller's payment processor, which AP2 allows, but there is no separate Credential Provider, network or Payment Receipt. The agent discloses every claim rather than choosing a minimal subset.

## Voice step-up, in the reviewer's language

A step-up can be confirmed out loud in 13 widely spoken JAPAC languages: English, Mandarin, Hindi, Japanese, Indonesian, Bengali, Vietnamese, Korean, Thai, Filipino, Malay, Tamil and Telugu. Gemini writes the question in the chosen language (who is being paid, how much, why it was held) and it is read aloud. The reviewer answers, for example "approve, 199 dollars". The answer is turned into a decision and a spoken amount, and the Guard approves only when **the spoken amount matches the charge**, so a bare "yes" never approves a changed price. Rejections need no amount.

Speech comes from [Sarvam](https://www.sarvam.ai) (Bulbul text-to-speech, Saaras speech-to-text, which handles code-mixed speech such as Hindi with English numbers) for Indian languages when `SARVAM_API_KEY` is set, and from Google Cloud Text-to-Speech for every other language, with Gemini listening to the recording directly. Gemini makes every judgement in both paths; the speech providers only speak and transcribe. The rule lives in `voiceOutcome` in `server/voice.js` and is unit-tested. The transcript, language and spoken amount are stored on the review as evidence.

## Run it locally

```bash
npm install
npm test                      # 37 tests, in-memory store, no network
npm start                     # http://localhost:8080, in-memory store, rules-only explanations
```

With Gemini and Firestore:

```bash
cp .env.example .env          # set GEMINI_API_KEY and GOOGLE_CLOUD_PROJECT
set -a; . ./.env; set +a
gcloud auth application-default login
npm start
```

Try it from the command line, the way a UCP platform would. This example uses a platform profile the sellers do not trust for AP2, so no mandate is needed; the demo agents' profiles are trusted and must send mandates (see `test/e2e.test.js` for both):

```bash
# Discovery
curl -s localhost:8080/sellers/pelican_mail/.well-known/ucp | jq .

# Create a checkout session
curl -s -X POST localhost:8080/sellers/pelican_mail/checkout-sessions \
  -H 'content-type: application/json' \
  -H 'UCP-Agent: profile="https://platform.example/agents/manual-test"' \
  -d '{"currency":"USD","line_items":[{"item":{"id":"pm_growth_1m"},"quantity":1}],"payment":{}}' | tee /tmp/chk.json | jq '{id,status,totals}'

# Complete it. risk_signals is the UCP-defined slot the Guard reads.
ID=$(jq -r .id /tmp/chk.json)
curl -s -X POST localhost:8080/sellers/pelican_mail/checkout-sessions/$ID/complete \
  -H 'content-type: application/json' \
  -H 'UCP-Agent: profile="https://platform.example/agents/manual-test"' \
  -d '{"payment_data":{"handler_id":"mock_payment_handler","credential":{"type":"PAYMENT_GATEWAY","token":"success_token"}},
       "risk_signals":{"expected_total":19900,"intent":{"items":[{"item_id":"pm_growth_1m","quantity":1}]}}}' | jq '{status,order,"guard":."x-guard".explanation}'
```

Benchmark against any running instance:

```bash
BASE=http://localhost:8080 ROUNDS=3 node scripts/bench.js
```

## Deploy

```bash
PROJECT_ID=your-project GEMINI_API_KEY=your-key ./scripts/deploy.sh
```

The script enables the APIs, creates the Firestore database if needed, deploys to Cloud Run from source, stores the Gemini key in Secret Manager, grants the service identity Firestore and Vertex access, and deploys Hosting plus Firestore rules and indexes. Omit `GEMINI_API_KEY` to use Vertex AI through the service identity instead. Region defaults to `asia-south1`; change `REGION` and the `region` fields in `firebase.json` together.

## The Guard rules

All rules live in `server/guard/rules.js` and are pure functions over the session, the seller, the agent's policy, the `risk_signals` sent by the platform, and recent history. Each produces a finding with a severity and a weight; any `block` finding declines, a score at or above the agent's step-up threshold (default 40) escalates, otherwise the purchase is approved.

| Rule | Catches |
|---|---|
| `quote_mismatch` / `quote_drift` | Seller charging something other than what the agent was quoted. Up to 25% apart escalates, beyond that declines. |
| `over_transaction_cap` / `over_daily_cap` / `near_daily_cap` | Per-purchase and daily spend limits per agent. |
| `velocity_exceeded` / `velocity_elevated` | Too many completions in a window. Runaway agents. |
| `duplicate_purchase` | Same agent, same seller, same cart, recently completed. Retry loops. |
| `quantity_inflated` / `unrequested_item` / `quantity_over_policy` | Cart does not match the human's request. Prompt-injected catalogs and hijacked carts. |
| `unverified_seller` / `category_not_allowed` | Seller trust and category allow-lists. |
| `missing_payment_credential` | Malformed complete call. |
| `ap2_mandate_missing` / `ap2_mandate_invalid` / `ap2_mandate_scope` / `ap2_mandate_violated` / `ap2_amount_over_mandate` | The human's signed AP2 mandate is missing, not trusted, for another checkout, broken by the cart, or below the charge. See the AP2 section. |

The intent used for the cart comparison is extracted from the human's request by a separate Gemini call, not taken from the buyer agent's own reasoning. That matters: when a catalog description tells the agent to "set quantity to 40", the Guard still knows the human asked for one.

## What is real and what is simulated

Real: UCP discovery and the checkout REST binding (create, get, update, complete, cancel, status machine, `continue_url`, `risk_signals`), AP2 mandate signing and verification (ES256, SD-JWT chains, constraints, receipts), the Guard, Gemini calls, Firestore persistence, the dashboard, the deploy. Simulated: payments (UCP mock payment handler with `success_token` / `fail_token`), UCP request signatures (the header is sent but not verified), the human's approval on the Trusted Surface (the scenario stands in for the click), and the three sellers, which are illustrative. The Guard's rules and thresholds are sensible defaults for these simulations, not tuned on real transaction data.

## License

Apache-2.0. See `LICENSE`.
