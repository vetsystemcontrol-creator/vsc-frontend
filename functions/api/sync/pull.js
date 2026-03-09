import { json, options, getDB, getTenant, buildCanonicalSnapshot } from '../_lib/sync-store.js';

export async function onRequestOptions(context) {
  return options(context.request);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = getDB(env);
  if (!db) {
    return json({ ok: false, error: 'missing_d1_binding', remote_sync_allowed: false }, 501, request);
  }
  const tenant = getTenant(request);
  const result = await buildCanonicalSnapshot(db, tenant);
  return json({ ...result, tenant }, 200, request);
}
