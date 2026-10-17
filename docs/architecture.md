# Architecture

## Components

```mermaid
flowchart LR
  subgraph Human
    U[Buyer / finance reviewer]
  end
  subgraph FirebaseHosting[Firebase Hosting]
    D[Dashboard<br/>vanilla JS]
  end
  subgraph CloudRun[Cloud Run: agent-checkout-guard]
    A[Buyer agent runner<br/>Gemini function calling]
    TS[Platform Trusted Surface<br/>signs AP2 open mandates]
    S[Example sellers<br/>UCP /.well-known/ucp<br/>checkout-sessions REST<br/>sign checkouts]
    G[Guard<br/>AP2 verification + rules<br/>+ Gemini explanation]
  end
  subgraph Google
    GM[Gemini 3 Flash<br/>2.5 Flash fallback]
    FS[(Firestore<br/>sessions, decisions,<br/>events, agents, runs)]
    SM[(Secret Manager<br/>AP2 signing keys)]
  end
  U -- picks a scenario, reviews step-ups --> D
  D -- /api/** rewrites --> A
  D -- /api/decisions, /api/runs --> FS
  A -- UCP over HTTP --> S
  S -- Complete Checkout --> G
  A -- plan, intent --> GM
  G -- explain --> GM
  S --> FS
  G --> FS
  A -- human approval --> TS
  TS -. platform key .- SM
  S -. seller keys .- SM
```

## Purchase flow (AP2 Human Not Present over UCP)

```mermaid
sequenceDiagram
  participant H as Human
  participant T as Trusted Surface (platform key)
  participant A as Buyer agent (Gemini, own key)
  participant S as Seller (UCP, seller key)
  participant G as Guard
  participant F as Firestore
  H->>A: "Buy one Growth email plan"
  A->>T: proposed open mandates (items, max amount, seller)
  H->>T: approve
  T-->>A: open Checkout + Payment Mandates (SD-JWT, agent key in cnf)
  A->>S: GET /.well-known/ucp (AP2 capability, signing_keys)
  A->>S: POST /checkout-sessions {line_items}
  S-->>A: checkout + ap2.merchant_authorization (detached JWS)
  A->>A: verify seller signature, sign closed mandates (kb+sd-jwt: sd_hash, aud, nonce)
  A->>S: POST /complete {ap2.checkout_mandate, payment_data.token, risk_signals}
  S->>G: verify AP2 chains + constraints, then evaluate(session, risk_signals, ap2)
  G->>F: load recent attempts, today's spend, recent carts, used mandates
  G->>F: save decision (+ AP2 result, Gemini explanation)
  alt approve
    S-->>A: completed + order + ap2.checkout_receipt (Success)
  else step_up (e.g. charge above the signed amount)
    S-->>A: requires_escalation + continue_url + receipt (Error)
    H->>T: approve on the dashboard or by voice
    T->>S: Human Present closed Checkout Mandate
    S-->>H: verified, order placed, receipt (Success)
  else decline (forged, out of scope, outside the mandate, policy)
    S-->>A: canceled + reason + receipt (Error)
  end
```

## Guard decision

```mermaid
flowchart TD
  C[Complete Checkout] --> R1[quote mismatch]
  C --> R2[spend caps]
  C --> R3[velocity]
  C --> R4[duplicate cart]
  C --> R5[intent match]
  C --> R6[seller trust]
  R1 & R2 & R3 & R4 & R5 & R6 --> SC{any block?}
  SC -- yes --> DEC[decline -> canceled]
  SC -- no --> TH{score >= threshold?}
  TH -- yes --> SU[step_up -> requires_escalation]
  TH -- no --> AP[approve -> completed]
```

## Data model (Firestore)

| Collection | Document | Written by | Read by |
|---|---|---|---|
| `sessions` | UCP checkout session plus `seller_id`, `agent_profile`, `quote_history`, `guard` | sellers, reviewer | sellers, Guard (duplicates, daily spend), dashboard |
| `decisions` | outcome, risk score, findings, explanation, timings, policy snapshot, AP2 result (status, mode, codes, approved limits), review (with voice evidence and Human Present mandate receipt) | Guard, reviewer | dashboard |
| `events` | append-only: created, updated, complete_attempt, canceled, review.resolved, review.voice_attempt, ap2.mandate_used | sellers, reviewer | Guard (velocity, AP2 mandate reuse) |
| `agents` | per-agent policy (caps, limits, threshold) | dashboard | Guard |
| `runs` | agent run trace (steps, outcomes) | agent runner | dashboard |

## Why the Guard sits at Complete Checkout

UCP already defines `risk_signals` as an input to Complete Checkout and defines `requires_escalation` with `continue_url` as a session state. UCP's AP2 extension makes the same call carry cryptographic proof of what the human authorised, so the Guard can check signed facts (merchant, items, maximum amount, this exact checkout) before it weighs behavioural signals. That gives a risk layer a standard place to receive context from the platform and a standard way to hand a purchase to a human, without inventing a side channel. The same Guard can run inside a seller's UCP implementation (as here), as a platform-side pre-check before the platform calls the seller, or as a hosted service that issuers and buyer platforms call.
