// /api/owner-session.js — always 200, returns auth status + homestays
import {
  corsHeaders,
  enforceHttps,
  getOwnerSession,
  jsonResponse
} from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const owner = await getOwnerSession(request, env);
    if (!owner || owner.type !== 'owner') {
      return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
    }
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const cleanWa = String(owner.whatsapp || owner.ownerId || '').replace(/[^0-9]/g, '');

    // Load homestays owned by this whatsapp
    let homes = [];
    for (const key of ['kd_approved', 'kd_pending']) {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
      if (!r?.data) continue;
      try {
        const arr = JSON.parse(r.data);
        homes = homes.concat(arr.filter(h =>
          String(h.whatsapp || '').replace(/[^0-9]/g, '') === cleanWa
        ));
      } catch (_) {}
    }

    // Load owner account for pre-fill info
    let ownerAccount = null;
    const ownersRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_owners').first();
    if (ownersRes?.data) {
      try {
        const owners = JSON.parse(ownersRes.data);
        ownerAccount = owners.find(o => String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanWa) || null;
      } catch (_) {}
    }

    const safeHomes = homes.map(h => {
      const {
        ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm,
        ownerPasswordVersion, ownerSessionVersion,
        icImage, icOriginalName, bankQRImage, bankQROriginalName, pbtLicense,
        ...rest
      } = h;
      return rest;
    });

    return jsonResponse({
      authenticated: true,
      ownerId: cleanWa,
      ownerName: ownerAccount?.ownerName || owner.ownerName || null,
      ownerEmail: ownerAccount?.ownerEmail || null,
      whatsapp: cleanWa,
      hasOwnerAccount: !!ownerAccount,
      homestays: safeHomes
    }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
