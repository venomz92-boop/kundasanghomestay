// /api/admin-manual-payouts.js
//
// Admin-only. Backs /admin-payouts.html, the queue where you record manual
// bank transfers to hosts during the 3-month CHIP Send onboarding probation
// period.
//
// GET  — list pending payouts + recent history.
// POST — mark a booking as paid. Records the transfer reference, the
//        payment method (bank QR or manual transfer), and the URL of
//        the uploaded bank receipt. Fires the host Payout Statement
//        email. Updates the booking status. Idempotent.
//
// [THIS REVISION — 16 Sept 2026]
//   (1) GET now exposes `hostWhatsapp` on every pending item and every
//       history row. The admin panel uses this to render a "Notify Host
//       on WhatsApp" button, so non-technical hosts who miss the email
//       still get told about their payout.
//   (2) POST now fires a second email — a [PAYOUT-RECORD] message to
//       support@kundasanghomestay.my — after the payout statement goes
//       out. A Google Apps Script watches that inbox and auto-files the
//       receipt + metadata into Google Drive, which is our audit trail
//       for CHIP's 3-month manual-payout review. Fire-and-forget: a
//       failure here never blocks the payout record.

import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  verifyAdminAuth,
  jsonResponse,
  parseJSONSafely,
  withLock,
  sendHostPayoutEmail,
  sendPayoutRecordEmail
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';
const HISTORY_LIMIT = 200;

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
      // [NEW] Host WhatsApp — for the "Notify Host on WhatsApp" button
      // in the admin panel. Prefers the snapshot taken when the booking
      // entered the queue, falls back to the booking's own ownerWhatsapp.
      hostWhatsapp: b.manualPayoutHostWhatsapp || b.ownerWhatsapp || '',
      bankName: b.manualPayoutBankName || '',
      bankCode: b.manualPayoutBankCode || '',
      accountNumber: b.manualPayoutAccountNumber || '',
      accountHolder: b.manualPayoutAccountHolder || '',
      queuedAt,
      daysWaiting
    };
  }).sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());

  const historyRaw = bookings.filter(b => b && b.manualPayoutReference);

  const history = historyRaw.map(b => ({
    bookingId: b.id,
    homestayName: b.manualPayoutHomestayName || b.homestay || '',
    hostName: b.manualPayoutHostName || '',
    hostEmail: b.manualPayoutHostEmail || '',
    hostWhatsapp: b.manualPayoutHostWhatsapp || b.ownerWhatsapp || '',
    hostBank: b.manualPayoutBankName || '',
    hostAccount: b.manualPayoutAccountNumber || '',
    amount: Number(b.manualPayoutAmount || b.base || 0),
    reference: b.manualPayoutReference || '',
    method: VALID_PAYMENT_METHODS.has(b.manualPayoutMethod)
      ? b.manualPayoutMethod
      : DEFAULT_PAYMENT_METHOD,
    receiptUrl: b.manualPayoutReceiptUrl || '',
    receiptPublicId: b.manualPayoutReceiptPublicId || '',
    emailSent: b.manualPayoutEmailSent === true,
    emailSentAt: b.manualPayoutEmailSentAt || '',
    emailError: b.manualPayoutEmailError || '',
    driveRecordSent: b.manualPayoutDriveRecordSent === true,
    driveRecordError: b.manualPayoutDriveRecordError || '',
    notes: b.manualPayoutNotes || '',
    paidAt: b.manualPayoutCompletedAt || '',
    paidBy: b.manualPayoutCompletedBy || 'admin'
  })).sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime()).slice(0, HISTORY_LIMIT);

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
  const receiptUrl = String(body.receiptUrl || '').trim();
  const receiptPublicId = String(body.receiptPublicId || '').trim();

  if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);
  if (!reference) return jsonResponse({ error: 'Transfer reference is required' }, 400, request);
  if (!receiptUrl) {
    return jsonResponse({
      error: 'Bank receipt is required. Please upload the transfer receipt from your bank app before confirming.',
      code: 'RECEIPT_REQUIRED'
    }, 400, request);
  }

  const looksLikeCloudinary = /^https:\/\/res\.cloudinary\.com\//.test(receiptUrl);
  if (!looksLikeCloudinary) {
    console.warn('admin-manual-payouts: receiptUrl does not look like a Cloudinary URL:', receiptUrl.slice(0, 120));
  }

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

      const updatedBooking = {
        ...booking,
        status: 'Completed - Payout Success (Manual)',
        manualPayoutPending: false,
        manualPayoutCompletedAt: nowIso,
        manualPayoutCompletedBy: 'admin',
        manualPayoutMethod: paymentMethod,
        manualPayoutReference: reference,
        manualPayoutReceiptUrl: receiptUrl,
        manualPayoutReceiptPublicId: receiptPublicId || null,
        manualPayoutNotes: notes,
        payoutSuccess: true,
        payoutSuccessDate: nowIso,
        payoutAmount: ownerAmount,
        payoutMethod: 'Manual bank transfer',
        ownerPayoutId: reference
      };

      // Send the Payout Statement email INSIDE the lock so the email
      // result is saved in the same write as the payment details.
      const homestayForEmail = {
        ownerEmail: updatedBooking.manualPayoutHostEmail || '',
        ownerName: updatedBooking.manualPayoutHostName || 'Host',
        name: updatedBooking.manualPayoutHomestayName || updatedBooking.homestay || 'your property',
        ownerBank: updatedBooking.manualPayoutBankName || '',
        ownerBankAccount: updatedBooking.manualPayoutAccountNumber || ''
      };

      let emailReport = { sent: false, error: 'not attempted' };
      try {
        emailReport = await sendHostPayoutEmail(
          updatedBooking,
          homestayForEmail,
          {
            amount: ownerAmount,
            payoutId: reference,
            reference,
            paidAt: nowIso,
            isManual: true,
            receiptUrl: receiptUrl
          },
          env
        );
      } catch (mailErr) {
        console.error('Manual payout email error:', mailErr.message);
        emailReport = { sent: false, error: mailErr.message };
      }

      if (emailReport.sent) {
        updatedBooking.manualPayoutEmailSent = true;
        updatedBooking.manualPayoutEmailSentAt = nowIso;
        delete updatedBooking.manualPayoutEmailError;
      } else {
        updatedBooking.manualPayoutEmailSent = false;
        updatedBooking.manualPayoutEmailSentAt = null;
        updatedBooking.manualPayoutEmailError = emailReport.error || 'unknown';
      }

      // [NEW] Fire the [PAYOUT-RECORD] email so the Drive automation
      // can file it. Fire-and-forget: if this fails, the payout record
      // is still saved and the host is still paid. The failure only
      // shows up in the admin panel (driveRecordSent=false) so you can
      // re-file manually if needed.
      let driveRecordReport = { sent: false, error: 'not attempted' };
      try {
        driveRecordReport = await sendPayoutRecordEmail(
          updatedBooking,
          {
            amount: ownerAmount,
            reference,
            paidAt: nowIso,
            method: paymentMethod,
            receiptUrl,
            hostName: updatedBooking.manualPayoutHostName || '',
            hostEmail: updatedBooking.manualPayoutHostEmail || '',
            hostWhatsapp: updatedBooking.manualPayoutHostWhatsapp || updatedBooking.ownerWhatsapp || '',
            homestayName: updatedBooking.manualPayoutHomestayName || updatedBooking.homestay || ''
          },
          env
        );
      } catch (driveErr) {
        console.error('Payout record email error:', driveErr.message);
        driveRecordReport = { sent: false, error: driveErr.message };
      }

      if (driveRecordReport.sent) {
        updatedBooking.manualPayoutDriveRecordSent = true;
        updatedBooking.manualPayoutDriveRecordSentAt = nowIso;
        delete updatedBooking.manualPayoutDriveRecordError;
      } else {
        updatedBooking.manualPayoutDriveRecordSent = false;
        updatedBooking.manualPayoutDriveRecordError = driveRecordReport.error || 'unknown';
      }

      bookings[idx] = updatedBooking;

      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      return {
        success: true,
        booking: updatedBooking,
        ownerAmount,
        nowIso,
        emailReport,
        driveRecordReport
      };
    }, 60000);
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

  const methodLabel = paymentMethod === 'bank_qr' ? 'Bank QR (DuitNow)' : 'Manual bank transfer';

  await logAction({
    db,
    action: 'manual_payout_recorded',
    admin: 'admin',
    details: `Manual payout for ${bookingId} recorded. RM${result.ownerAmount.toFixed(2)} → ${result.booking.manualPayoutHostName || 'host'} (${result.booking.manualPayoutBankName || ''}). Method: ${methodLabel}. Reference: ${reference}. Receipt: ${receiptPublicId || 'uploaded (no public id returned)'}${notes ? '. Notes: ' + notes : ''}. Host email: ${result.emailReport.sent ? 'sent' : 'failed — ' + (result.emailReport.error || 'unknown')}. Drive record: ${result.driveRecordReport.sent ? 'sent' : 'failed — ' + (result.driveRecordReport.error || 'unknown')}.`,
    ip: clientIP,
    userId: result.booking.manualPayoutHostEmail || '',
    homestayId: result.booking.homestayId
  });

  return jsonResponse({
    success: true,
    bookingId,
    reference,
    method: paymentMethod,
    amount: result.ownerAmount,
    paidAt: result.nowIso,
    receiptUrl,
    hostEmail: result.booking.manualPayoutHostEmail || '',
    emailSent: result.emailReport.sent,
    emailError: result.emailReport.sent ? undefined : result.emailReport.error,
    driveRecordSent: result.driveRecordReport.sent,
    driveRecordError: result.driveRecordReport.sent ? undefined : result.driveRecordReport.error
  }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
