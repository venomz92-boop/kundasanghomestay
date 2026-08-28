// /api/upload-image.js
import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const formData = await request.formData();
    const file = formData.get('image');
    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400 });
    }

    const cloudName = env.CLOUDINARY_CLOUD_NAME || '';
    const apiKey = env.CLOUDINARY_API_KEY || '';
    const apiSecret = env.CLOUDINARY_API_SECRET;

    if (!apiSecret) {
      console.error('❌ CLOUDINARY_API_SECRET not set');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), { status: 500 });
    }

    // Convert file to base64
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    // Upload to Cloudinary
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'kundasang-homestay/rooms';

    // Generate signature (Cloudinary requires signature for authenticated uploads)
    const signatureString = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = await sha256(signatureString);

    const uploadData = new URLSearchParams({
      file: `data:${file.type};base64,${base64}`,
      folder: folder,
      api_key: apiKey,
      timestamp: String(timestamp),
      signature: signature
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
      console.error('❌ Cloudinary upload error:', data);
      return new Response(JSON.stringify({ error: data.error?.message || 'Upload failed' }), { status: 500 });
    }

    // Return the secure URL
    return new Response(JSON.stringify({
      success: true,
      url: data.secure_url,
      publicId: data.public_id
    }), {
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('❌ Upload error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

// ===== SHA1 helper for Cloudinary signature =====
async function sha1(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
