// /api/upload-image.js — now requires an authenticated session (guest,
// owner, or admin) before accepting an upload. Keeps the same IP rate
// limit, 5MB cap, and MIME whitelist. Same response shape on success.
//
// [THIS REVISION]
// The Cloudinary target folder is now configurable via an optional
// `folder` form field. It is validated against a whitelist of known
// folders so a malicious caller cannot push files into arbitrary
// Cloudinary paths under our account. If `folder` is missing or
// unrecognised, the file lands in the default `kundasang-homestay/rooms`
// folder — which is what every existing caller already assumes.
//
// New folder added:
//   - kundasang-homestay/payout-receipts  — bank transfer receipts
//     uploaded by admin when recording a manual host payout. These are
//     the "proof of payment" evidence CHIP asks for during the Send
//     API compliance review.
import {
  corsHeaders,
  getClientIP,
  checkRateLimit,
  recordRateLimit,
  getGuestSession,
  getOwnerSession,
  verifyAdminAuth
} from './_utils.js';

const DEFAULT_FOLDER = 'kundasang-homestay/rooms';
const ALLOWED_FOLDERS = new Set([
  'kundasang-homestay/rooms',
  'kundasang-homestay/verification',
  'kundasang-homestay/payout-receipts'
]);

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export async function onRequestPost({ request, env }) {
  try {
    const guest = await getGuestSession(request, env);
    const owner = guest ? null : await getOwnerSession(request, env);
    const isAdmin = (guest || owner) ? false : await verifyAdminAuth(request, env);

    if (!guest && !owner && !isAdmin) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const clientIP = getClientIP(request);
    const db = env.DB;

    if (db) {
      const rateOk = await checkRateLimit(db, clientIP, 'upload_image', 20, 60 * 60);
      if (!rateOk) {
        return new Response(
          JSON.stringify({ error: 'Too many uploads. Please wait an hour.' }),
          { status: 429, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
        );
      }
      await recordRateLimit(db, clientIP, 'upload_image');
    }

    const formData = await request.formData();
    const file = formData.get('image');
    const requestedFolder = String(formData.get('folder') || '').trim();

    // Validate folder against the whitelist. Anything unexpected falls
    // back to the default. This prevents a caller from writing files
    // into arbitrary Cloudinary paths under our account.
    const folder = ALLOWED_FOLDERS.has(requestedFolder) ? requestedFolder : DEFAULT_FOLDER;

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      return new Response(
        JSON.stringify({ error: 'Invalid file type. Only JPEG, PNG, WEBP, and GIF are allowed.' }),
        { status: 400, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    if (file.size > 5 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: 'File too large. Maximum size is 5MB.' }),
        { status: 400, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    const cloudName = env.CLOUDINARY_CLOUD_NAME;
    const apiKey = env.CLOUDINARY_API_KEY;
    const apiSecret = env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      console.error('Cloudinary credentials missing');
      return new Response(
        JSON.stringify({ error: 'Server configuration error – missing credentials' }),
        { status: 500, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    let buffer;
    try {
      buffer = await new Response(file).arrayBuffer();
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Invalid file data' }),
        { status: 400, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    const base64 = arrayBufferToBase64(buffer);

    const timestamp = Math.floor(Date.now() / 1000);
    const signatureString = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = await sha256(signatureString);

    const uploadData = new URLSearchParams({
      file: `data:image/jpeg;base64,${base64}`,
      folder: folder,
      api_key: apiKey,
      timestamp: String(timestamp),
      signature: signature,
      signature_algorithm: 'sha256'
    });

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: uploadData
      }
    );

    const data = await response.json();

    if (!response.ok || !data.secure_url) {
      console.error('Cloudinary upload error:', data);
      return new Response(
        JSON.stringify({ error: data.error?.message || 'Upload failed' }),
        { status: 500, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        url: data.secure_url,
        publicId: data.public_id,
        folder: folder
      }),
      { headers: { ...corsHeaders(request), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    console.error('Upload error:', e.message);
    return new Response(
      JSON.stringify({ error: e.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
    );
  }
}

export async function onRequestGet({ request }) {
  return new Response(
    JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    {
      status: 405,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    }
  );
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
