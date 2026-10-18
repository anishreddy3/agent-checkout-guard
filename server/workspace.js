// Per-browser workspaces. The dashboard creates a random workspace id, keeps it
// in the browser and sends it as X-ACG-Workspace. Everything a visitor does is
// scoped to it, so two people using the demo at once never see or affect each
// other's runs, decisions, policies or risk history.
//
// The id travels inside the buyer agent's UCP-Agent profile ("...?ws=<id>"), so
// every check keyed by agent (velocity, duplicates, daily spend, spend policy)
// is per workspace without extra plumbing. Calls without a valid id (curl,
// other UCP platforms) share the "public" workspace.

const WS_RE = /^[a-z0-9-]{8,48}$/;
export const PUBLIC_WS = 'public';

export function workspaceFrom(req) {
  const h = String(req.headers['x-acg-workspace'] ?? '').toLowerCase();
  return WS_RE.test(h) ? h : PUBLIC_WS;
}

export function profileFor(baseProfile, ws) {
  return ws === PUBLIC_WS ? baseProfile : `${baseProfile}?ws=${ws}`;
}

export function workspaceOfProfile(profile) {
  try {
    const ws = new URL(String(profile)).searchParams.get('ws');
    return ws && WS_RE.test(ws) ? ws : PUBLIC_WS;
  } catch {
    return PUBLIC_WS;
  }
}

export function baseProfile(profile) {
  return String(profile ?? '').split('?')[0];
}
