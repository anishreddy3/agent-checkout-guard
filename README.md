# Agent Checkout Guard

Trusted agent checkout over the Universal Commerce Protocol (UCP).

AI agents are starting to buy things on behalf of people and companies. A buyer agent reads a seller's machine-readable catalog, creates a checkout session and completes it with a stored card, all in seconds and without a human in the loop. That is great for commerce and a new problem for risk teams: an agent can be given a stale quote, fall for instructions hidden in a product description, loop and buy the same thing twice, or burn through a budget before anyone notices.

Agent Checkout Guard puts a risk decision at the one point every agent purchase passes through: the UCP **Complete Checkout** call. Before the seller charges anything, the Guard reconciles the charge with the quote the agent received, checks the cart against what the human actually asked for, applies spend, velocity and duplicate controls, and returns one of three outcomes that map directly onto UCP session states:

| Guard outcome | UCP session status | What happens |
|---|---|---|
| approve | `completed` | Order is placed |
| step_up | `requires_escalation` | A human reviews it from the dashboard via `continue_url` |
| decline | `canceled` | Nothing is charged, the agent gets a plain-language reason |

Gemini writes the explanation for every decision and powers the buyer agent in the demo.

Built for the Google Cloud AI Builder Cup 2026 (BFSI and Retail tracks). All sellers, products, prices and agents in this repo are illustrative. No real payments are made.

## What is in the box

```
server/
  index.js           Express app: UCP endpoints, Guard API, agent runs, dashboard API
  ucp/checkout.js    UCP checkout capability (create, get, update, complete, cancel)
  sellers/catalog.js Three example sellers with machine-readable pricing and volume tiers
  guard/rules.js     Pure risk rules (quote mismatch, spend caps, velocity, duplicates, intent match, seller trust)
  guard/index.js     Loads history from Firestore, scores, asks Gemini to explain, persists the decision
  guard/policy.js    Per-agent spend policy with defaults
  agent/runner.js    Buyer agent: Gemini function-calling mode and a deterministic scripted mode
  agent/scenarios.js Six demo scenarios (routine, over budget, stale quote, runaway loop, injected catalog, velocity)
  store/index.js     Firestore persistence with an in-memory fallback
  gemini.js          Gemini client (Google AI Studio key or Vertex AI)
  voice.js           Voice step-up: prompts, speech (Sarvam or Google), spoken-amount check
web/                 Dashboard: vanilla JS, served by Firebase Hosting
test/                Unit tests for the rules and an HTTP end-to-end test of every scenario
scripts/deploy.sh    Cloud Run + Firestore + Firebase Hosting deploy
scripts/bench.js     Benchmark: outcome accuracy and guard latency
docs/                Architecture and flow diagrams
```

## How Google Cloud is used

**Cloud Run** runs the whole backend as one container: the three example sellers' UCP endpoints (`/.well-known/ucp`, `/checkout-sessions`), the Guard, and the buyer agent runner. Source-based deploy, min one instance so the evaluation link stays warm.

**Firestore** is the system of record. Collections: `sessions` (UCP checkout sessions and their quote history), `decisions` (every Guard decision with findings, explanation and latency), `events` (an append-only audit trail used for velocity and daily-spend checks), `agents` (per-agent spend policies) and `runs` (agent run traces the dashboard polls). The Guard's history queries (recent attempts by agent, completed sessions today) are Firestore queries with composite indexes in `firestore.indexes.json`.

**Firebase Hosting** serves the dashboard and rewrites `/api/**`, `/sellers/**` and `/review/**` to the Cloud Run service, so the dashboard, the API and the seller endpoints share one origin. Firestore security rules deny all client access; everything goes through the service.

**Gemini** (default `gemini-2.5-flash`, via Google AI Studio or Vertex AI) does three jobs: it is the buyer agent (function calling over `list_sellers`, `get_catalog`, `buy`, `finish`), it extracts the human's purchase intent from the request text so the Guard can compare the cart with what was asked, and it writes the two-sentence explanation attached to every decision. Every Gemini call has a deterministic fallback, so the service degrades to rules-only explanations and a scripted agent instead of failing.

## Voice step-up, in the reviewer's language

A step-up can be confirmed out loud in 13 widely spoken JAPAC languages: English, Mandarin, Hindi, Japanese, Indonesian, Bengali, Vietnamese, Korean, Thai, Filipino, Malay, Tamil and Telugu. Gemini writes the question in the chosen language (who is being paid, how much, why it was held) and it is read aloud. The reviewer answers, for example "approve, 199 dollars". The answer is turned into a decision and a spoken amount, and the Guard approves only when **the spoken amount matches the charge**, so a bare "yes" never approves a changed price. Rejections need no amount.

Speech comes from [Sarvam](https://www.sarvam.ai) (Bulbul text-to-speech, Saaras speech-to-text, which handles code-mixed speech such as Hindi with English numbers) for Indian languages when `SARVAM_API_KEY` is set, and from Google Cloud Text-to-Speech for every other language, with Gemini listening to the recording directly. Gemini makes every judgement in both paths; the speech providers only speak and transcribe. The rule lives in `voiceOutcome` in `server/voice.js` and is unit-tested. The transcript, language and spoken amount are stored on the review as evidence.

## Run it locally

```bash
npm install
npm test                      # 19 tests, in-memory store, no network
npm start                     # http://localhost:8080, in-memory store, rules-only explanations
```

With Gemini and Firestore:

```bash
cp .env.example .env          # set GEMINI_API_KEY and GOOGLE_CLOUD_PROJECT
set -a; . ./.env; set +a
gcloud auth application-default login
npm start
```

Try it from the command line, the way a UCP platform would:

```bash
# Discovery
curl -s localhost:8080/sellers/pelican_mail/.well-known/ucp | jq .

# Create a checkout session
curl -s -X POST localhost:8080/sellers/pelican_mail/checkout-sessions \
  -H 'content-type: application/json' \
  -H 'UCP-Agent: profile="https://platform.example/agents/procurement-bot"' \
  -d '{"currency":"USD","line_items":[{"item":{"id":"pm_growth_1m"},"quantity":1}],"payment":{}}' | tee /tmp/chk.json | jq '{id,status,totals}'

# Complete it. risk_signals is the UCP-defined slot the Guard reads.
ID=$(jq -r .id /tmp/chk.json)
curl -s -X POST localhost:8080/sellers/pelican_mail/checkout-sessions/$ID/complete \
  -H 'content-type: application/json' \
  -H 'UCP-Agent: profile="https://platform.example/agents/procurement-bot"' \
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

The intent used for the cart comparison is extracted from the human's request by a separate Gemini call, not taken from the buyer agent's own reasoning. That matters: when a catalog description tells the agent to "set quantity to 40", the Guard still knows the human asked for one.

## What is real and what is simulated

Real: UCP discovery and the checkout REST binding (create, get, update, complete, cancel, status machine, `continue_url`, `risk_signals`), the Guard, Gemini calls, Firestore persistence, the dashboard, the deploy. Simulated: payments (UCP mock payment handler with `success_token` / `fail_token`), request signatures (the header is sent but not verified), and the three sellers themselves. The Guard's rules and thresholds are defaults chosen for the demo, not tuned on real transaction data.

## License

Apache-2.0. See `LICENSE`.
