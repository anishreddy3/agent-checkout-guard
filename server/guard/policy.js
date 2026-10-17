// Spend and behaviour policy for a buyer agent, keyed by its UCP-Agent
// profile URI. Stored in the `agents` collection; defaults apply when the
// agent has no stored policy. Amounts are minor units (cents).

import { getStore } from '../store/index.js';

export const DEFAULT_POLICY = {
  per_transaction_cap: 100000, // $1,000
  daily_cap: 250000, // $2,500
  max_quantity_per_line: 5,
  allowed_categories: ['messaging', 'data', 'geo'],
  velocity: { window_minutes: 10, max_complete_attempts: 6 },
  duplicate: { window_minutes: 30 },
  require_verified_seller: false,
  step_up_threshold: 40, // risk score at or above this escalates to a human
};

export function agentIdFromProfile(profile) {
  return String(profile || 'unknown').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120);
}

export async function policyFor(profile) {
  const id = agentIdFromProfile(profile);
  const stored = await getStore().get('agents', id);
  return {
    ...DEFAULT_POLICY,
    ...(stored?.policy ?? {}),
    velocity: { ...DEFAULT_POLICY.velocity, ...(stored?.policy?.velocity ?? {}) },
    duplicate: { ...DEFAULT_POLICY.duplicate, ...(stored?.policy?.duplicate ?? {}) },
    agent_id: id,
    display_name: stored?.display_name ?? profile,
  };
}

export async function savePolicy(profile, policy, display_name) {
  const id = agentIdFromProfile(profile);
  return getStore().set('agents', id, { profile, display_name: display_name ?? profile, policy });
}
