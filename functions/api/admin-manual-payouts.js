// /api/admin-manual-payouts.js
//
// Admin-only. Backs /admin-payouts.html, the queue where you record manual
// bank transfers to hosts during the 3-month CHIP Send onboarding probation
// period.
//
// GET  — list pending payouts + recent history.
// POST — mark a booking as paid. Records the transfer reference, the
//        payment method (bank QR or manual transfer), fires the host
//        Payout Statement email, updates the booking status, logs
//        the action. Idempotent.
//
// [THIS REVISION]
// POST now accepts an optional `paymentMethod` field, either
// 'bank_qr' or 'manual_transfer'. It's stored on the booking as
// `manualPayoutMethod` and returned in the payout history so the CSV
// export shows which method was used for each transfer. This helps
// match payouts against bank statement lines during CHIP's compliance
// review (DuitNow QR transfers look different on a bank statement
// than manual transfers).
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  verifyAdminAuth,
  jsonResponse,
  parseJSONSafely,
  withLock,
  sendHostPayoutEmail
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';
const HISTORY_LIMIT = 200;

// Whitelist of accepted payment methods. Anything else gets coerced
// to 'manual_transfer' so the field is never empty.
const VALID_PAYMENT_METHODS = new Set(['bank_qr', 'manual_transfer']);
const DEFAULT_PAYMENT_METHOD = 'manual_transfer';

async function requireAdmin(request, env) {
  const ok = await verifyAdminAuth(request, env);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401, request);
  return null;
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

  const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}

  // ---- Pending queue: anything queued for manual payout ----
  const pendingRaw = bookings.filter(b => b && b.manualPayoutPending === true);

  const pending = pendingRaw.map(b => {
    const queuedAt = b.manualPayoutQueuedAt || b.checkedInAt || '';
    let daysWaiting = 0;
    if (queuedAt) {
      try { daysWaiting = Math.max(0, Math.floor((Date.now() - new Date(queuedAt).getTime()) / 86400000)); } catch (_) {}
    }
    return {
      bookingId: b.id,
      homestayId: b.homestayId,
      homestayName: b.manualPayoutHomestayName || b.homestay || '',
      guestName: b.guestName || '',
      guestEmail: b.guestEmail || '',
      checkin: b.checkin || '',
      checkout: b.checkout || '',
      nights: b.nights || 1,
      amount: Number(b.manualPayoutAmount || b.base || 0),
      hostName: b.manualPayoutHostName || '',
      hostEmail: b.manualPayoutHostEmail || '',
      bankName: b.manualPayoutBankName || '',
      bankCode: b.manualPayoutBankCode || '',
      accountNumber: b.manualPayoutAccountNumber || '',
      accountHolder: b.manualPayoutAccountHolder || '',
      queuedAt,
      daysWaiting
    };
  }).sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime()); // oldest first

  // ---- History: bookings that already have a manual payout reference ----
  const historyRaw = bookings.filter(b => b && b.manualPayoutReference);

  const history = historyRaw.map(b => ({
    bookingId: b.id,
    homestayName: b.manualPayoutHomestayName || b.homestay || '',
    hostName: b.manualPayoutHostName || '',
    hostEmail: b.manualPayoutHostEmail || '',
    amount: Number(b.manualPayoutAmount || b.base || 0),
    reference: b.manualPayoutReference || '',
    method: VALID_PAYMENT_METHODS.has(b.manualPayoutMethod)
      ? b.manualPayoutMethod
      : DEFAULT_PAYMENT_METHOD,
    notes: b.manualPayoutNotes || '',
    paidAt: b.manualPayoutCompletedAt || '',
    paidBy: b.manualPayoutCompletedBy || 'admin'
  })).sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime()).slice(0, HISTORY_LIMIT);

  // ---- Summary ----
  const now = Date.now();
  const oneDayAgo = now - 86400000;
  const sevenDaysAgo = now - 7 * 86400000;

  const totalPendingAmount = pending.reduce((s, p) => s + p.amount, 0);
  const paidTodayCount = history.filter(h => h.paidAt && new Date(h.paidAt).getTime() >= oneDayAgo).length;
  const paidWeekAmount = history
    .filter(h => h.paidAt && new Date(h.paidAt).getTime() >= sevenDaysAgo)
    .reduce((s, h) => s + h.amount, 0);

  return jsonResponse({
    success: true,
    summary: {
      pendingCount: pending.length,
      pendingAmount: Math.round(totalPendingAmount * 100) / 100,
      paidToday: paidTodayCount,
      paidWeekAmount: Math.round(paidWeekAmount * 100) / 100
    },
    pending,
    history
  }, 200, request, { 'Cache-Control': 'no-store' });
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

  let body;
  try { body = await parseJSONSafely(request); } catch (_) {
    return jsonResponse({ error: 'Invalid JSON' }, 400, request);
  }

  const bookingId = String(body.bookingId || '').trim();
  const reference = String(body.reference || '').trim().slice(0, 100);
  const notes = String(body.notes || '').trim().slice(0, 300);
  const rawMethod = String(body.paymentMethod || '').toLowerCase().trim();
  const paymentMethod = VALID_PAYMENT_METHODS.has(rawMethod) ? rawMethod : DEFAULT_PAYMENT_METHOD;

  if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);
  if (!reference) return jsonResponse({ error: 'Transfer reference is required' }, 400, request);

  const clientIP = getClientIP(request);

  let result;
  try {
    result = await withLock(db, BOOKINGS_LOCK, async (db) => {
      const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let bookings = [];
      try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
      const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
      if (idx === -1) return { error: 'Booking not found', status: 404 };

      const booking = bookings[idx];

      if (!booking.manualPayoutPending) {
        if (booking.manualPayoutReference) {
          return {
            alreadyPaid: true,
            message: `This booking was already paid out on ${booking.manualPayoutCompletedAt || 'unknown date'} (reference ${booking.manualPayoutReference}).`,
            bookingId,
            reference: booking.manualPayoutReference
          };
        }
        return { error: 'This booking is not in the manual payout queue.', status: 400 };
      }

      const nowIso = new Date().toISOString();
      const ownerAmount = Number(booking.manualPayoutAmount || booking.base || 0);

      bookings[idx] = {
        ...booking,
        status: 'Completed - Payout Success (Manual)',
        manualPayoutPending: false,
        manualPayoutCompletedAt: nowIso,
        manualPayoutCompletedBy: 'admin',
        manualPayoutMethod: paymentMethod,
        manualPayoutReference: reference,
        manualPayoutNotes: notes,
        payoutSuccess: true,
        payoutSuccessDate: nowIso,
        payoutAmount: ownerAmount,
        payoutMethod: 'Manual bank transfer',
        ownerPayoutId: reference
      };

      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      return { success: true, booking: bookings[idx], ownerAmount, nowIso };
    }, 30000);
  } catch (lockErr) {
    if (lockErr.message && lockErr.message.includes('in progress')) {
      return jsonResponse({ error: 'Another operation is in progress. Please try again.' }, 429, request);
    }
    throw lockErr;
  }

  if (result.error) {
    return jsonResponse({ error: result.error }, result.status || 400, request);
  }
  if (result.alreadyPaid) {
    return jsonResponse({ success: true, alreadyPaid: true, message: result.message }, 200, request);
  }

  // ---- Fire the Payout Statement email ----
  const b = result.booking;
  const homestayForEmail = {
    ownerEmail: b.manualPayoutHostEmail || '',
    ownerName: b.manualPayoutHostName || 'Host',
    name: b.manualPayoutHomestayName || b.homestay || 'your property',
    ownerBank: b.manualPayoutBankName || '',
    ownerBankAccount: b.manualPayoutAccountNumber || ''
  };

  let emailReport = { sent: false, error: 'not attempted' };
  try {
    emailReport = await sendHostPayoutEmail(
      b,
      homestayForEmail,
      {
        amount: result.ownerAmount,
        payoutId: reference,
        reference,
        paidAt: result.nowIso,
        isManual: true
      },
      env
    );
  } catch (mailErr) {
    console.error('Manual payout email error:', mailErr.message);
    emailReport = { sent: false, error: mailErr.message };
  }

  const methodLabel = paymentMethod === 'bank_qr' ? 'Bank QR (DuitNow)' : 'Manual bank transfer';

  await logAction({
    db,
    action: 'manual_payout_recorded',
    admin: 'admin',
    details: `Manual payout for ${bookingId} recorded. RM${result.ownerAmount.toFixed(2)} → ${homestayForEmail.ownerName} (${homestayForEmail.ownerBank}). Method: ${methodLabel}. Reference: ${reference}${notes ? '. Notes: ' + notes : ''}. Email: ${emailReport.sent ? 'sent' : 'failed — ' + (emailReport.error || 'unknown')}.`,
    ip: clientIP,
    userId: homestayForEmail.ownerEmail,
    homestayId: b.homestayId
  });

  return jsonResponse({
    success: true,
    bookingId,
    reference,
    method: paymentMethod,
    amount: result.ownerAmount,
    paidAt: result.nowIso,
    emailSent: emailReport.sent,
    emailError: emailReport.sent ? undefined : emailReport.error
  }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
