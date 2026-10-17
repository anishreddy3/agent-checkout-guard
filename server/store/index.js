// Persistence layer.
// Uses Firestore when GOOGLE_CLOUD_PROJECT (or FIRESTORE_PROJECT_ID) is set,
// otherwise an in-memory store with the same interface so the app and tests
// run anywhere. Collections: sessions, decisions, events, policies, agents.

import { randomUUID } from 'node:crypto';

const COLLECTIONS = ['sessions', 'decisions', 'events', 'policies', 'agents', 'runs'];

function nowIso() {
  return new Date().toISOString();
}

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
  }
  async get(col, id) {
    return this.data[col].get(id) ?? null;
  }
  async set(col, id, doc) {
    const full = { ...doc, id, updated_at: nowIso() };
    if (!full.created_at) full.created_at = full.updated_at;
    this.data[col].set(id, full);
    return full;
  }
  async add(col, doc) {
    return this.set(col, doc.id ?? randomUUID(), doc);
  }
  // filters: array of [field, op, value] with op in ==, >=, <=
  async query(col, filters = [], { orderBy, desc = true, limit = 100 } = {}) {
    let rows = [...this.data[col].values()].filter((row) =>
      filters.every(([f, op, v]) => {
        const x = row[f];
        if (op === '==') return x === v;
        if (op === '>=') return x >= v;
        if (op === '<=') return x <= v;
        return false;
      })
    );
    if (orderBy) {
      rows.sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : a[orderBy] > b[orderBy] ? 1 : 0));
      if (desc) rows.reverse();
    }
    return rows.slice(0, limit);
  }
  async clear() {
    for (const c of COLLECTIONS) this.data[c].clear();
  }
}

class FirestoreStore {
  constructor(projectId) {
    this.kind = 'firestore';
    this.ready = import('@google-cloud/firestore').then(({ Firestore }) => {
      this.db = new Firestore({ projectId, ignoreUndefinedProperties: true });
    });
  }
  async get(col, id) {
    await this.ready;
    const snap = await this.db.collection(col).doc(id).get();
    return snap.exists ? snap.data() : null;
  }
  async set(col, id, doc) {
    await this.ready;
    const ref = this.db.collection(col).doc(id);
    const existing = await ref.get();
    const full = {
      ...doc,
      id,
      updated_at: nowIso(),
      created_at: existing.exists ? existing.data().created_at : doc.created_at ?? nowIso(),
    };
    await ref.set(full);
    return full;
  }
  async add(col, doc) {
    return this.set(col, doc.id ?? randomUUID(), doc);
  }
  async query(col, filters = [], { orderBy, desc = true, limit = 100 } = {}) {
    await this.ready;
    let q = this.db.collection(col);
    for (const [f, op, v] of filters) q = q.where(f, op, v);
    if (orderBy) q = q.orderBy(orderBy, desc ? 'desc' : 'asc');
    q = q.limit(limit);
    try {
      const snap = await q.get();
      return snap.docs.map((d) => d.data());
    } catch (err) {
      // Composite index missing: fall back to an unordered query and sort here.
      if (String(err.message).includes('index')) {
        let q2 = this.db.collection(col);
        for (const [f, op, v] of filters) q2 = q2.where(f, op, v);
        const snap = await q2.limit(500).get();
        let rows = snap.docs.map((d) => d.data());
        if (orderBy) {
          rows.sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : a[orderBy] > b[orderBy] ? 1 : 0));
          if (desc) rows.reverse();
        }
        return rows.slice(0, limit);
      }
      throw err;
    }
  }
  async clear() {
    await this.ready;
    for (const c of COLLECTIONS) {
      const snap = await this.db.collection(c).limit(500).get();
      const batch = this.db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

let instance;
export function getStore() {
  if (instance) return instance;
  const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId && process.env.STORE !== 'memory') {
    instance = new FirestoreStore(projectId);
  } else {
    instance = new MemoryStore();
  }
  return instance;
}

export function resetStoreForTests() {
  instance = new MemoryStore();
  return instance;
}
