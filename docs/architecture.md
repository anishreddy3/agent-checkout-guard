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
    S[Example sellers<br/>UCP /.well-known/ucp<br/>checkout-sessions REST]
    G[Guard<br/>rules + Gemini explanation]
  end
  subgraph Google
    GM[Gemini 2.5 Flash]
    FS[(Firestore<br/>sessions, decisions,<br/>events, agents, runs)]
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
```

## Purchase flow

```mermaid
sequenceDiagram
  participant H as Human
  participant A as Buyer agent (Gemini)
  participant S as Seller (UCP)
  participant G as Guard
  participant F as Firestore
  H->>A: "Buy one Growth email plan"
  A->>S: GET /.well-known/ucp
  A->>S: GET /catalog (machine-readable pricing)
  A->>S: POST /checkout-sessions {line_items}
  S->>F: save session + quote
  S-->>A: ready_for_complete, totals
  A->>S: POST /checkout-sessions/{id}/complete {payment_data, risk_signals{expected_total, intent}}
  S->>G: evaluate(session, risk_signals)
  G->>F: load recent attempts, today's spend, recent completed carts
  G->>G: run rules, score
  G->>F: save decision (+ Gemini explanation)
  alt approve
    S-->>A: completed + order
  else step_up
    S-->>A: requires_escalation + continue_url
    H->>G: approve / reject from dashboard
  else decline
    S-->>A: canceled + reason
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
| `decisions` | outcome, risk score, findings, explanation, latency, policy snapshot | Guard | dashboard, reviewer |
| `events` | append-only: created, updated, complete_attempt, canceled, review.resolved | sellers, reviewer | Guard (velocity) |
| `agents` | per-agent policy (caps, limits, threshold) | dashboard | Guard |
| `runs` | agent run trace (steps, outcomes) | agent runner | dashboard |

## Why the Guard sits at Complete Checkout

UCP already defines `risk_signals` as an input to Complete Checkout and defines `requires_escalation` with `continue_url` as a session state. That gives a risk layer a standard place to receive context from the platform and a standard way to hand a purchase to a human, without inventing a side channel. The same Guard can run inside a seller's UCP implementation (as here), as a platform-side pre-check before the platform calls the seller, or as a hosted service that issuers and buyer platforms call.
