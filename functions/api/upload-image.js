// /api/upload-image.js – Secure & robust with file type validation
import { corsHeaders } from './_utils.js';

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function onRequestPost({ request, env }) {
  try {
    const formData = await request.formData();
    const file = formData.get('image');

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400 });
    }

    // ============================================================
    // 🔒 NEW: Validate file type
    // ============================================================
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      return new Response(JSON.stringify({ error: 'Invalid file type. Only JPEG, PNG, WEBP, and GIF are allowed.' }), { status: 400 });
    }

    // Optional: file size limit (e.g., 5MB)
    if (file.size > 5 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'File too large. Maximum size is 5MB.' }), { status: 400 });
    }

    // 1. Read credentials from environment
    const cloudName = env.CLOUDINARY_CLOUD_NAME;
    const apiKey = env.CLOUDINARY_API_KEY;
    const apiSecret = env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      console.error('❌ Cloudinary credentials missing');
      return new Response(
        JSON.stringify({ error: 'Server configuration error – missing credentials' }),
        { status: 500 }
      );
    }

    // 2. Get binary data
    let buffer;
    try {
      buffer = await new Response(file).arrayBuffer();
    } catch (e) {
      console.error('Failed to read file:', e.message);
      return new Response(JSON.stringify({ error: 'Invalid file data: ' + e.message }), { status: 400 });
    }

    // 3. Convert to base64
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'kundasang-homestay/rooms';

    // 4. Generate SHA‑256 signature
    const signatureString = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = await sha256(signatureString);

    // 5. Build Cloudinary upload payload
    const uploadData = new URLSearchParams({
      file: `data:image/jpeg;base64,${base64}`,
      folder: folder,
      api_key: apiKey,
      timestamp: String(timestamp),
      signature: signature,
      signature_algorithm: 'sha256'
    });

    // 6. Upload to Cloudinary
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
      console.error('❌ Cloudinary upload error:', data);
      return new Response(
        JSON.stringify({ error: data.error?.message || 'Upload failed' }),
        { status: 500 }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        url: data.secure_url,
        publicId: data.public_id
      }),
      {
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      }
    );
  } catch (e) {
    console.error('❌ Upload error:', e.message);
    return new Response(
      JSON.stringify({ error: 'Upload failed. Please try again later.' }),
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
