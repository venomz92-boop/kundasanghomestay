// /api/upload-image.js
import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const formData = await request.formData();
    const file = formData.get('image');
    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400 });
    }

    const cloudName = env.CLOUDINARY_CLOUD_NAME || 'lk3qg08g';
    const uploadPreset = 'homestay_uploads'; // <-- Your unsigned preset name

    // Convert file to base64
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    const uploadData = new URLSearchParams({
      file: `data:${file.type};base64,${base64}`,
      upload_preset: uploadPreset
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
      return new Response(JSON.stringify({ 
        error: data.error?.message || 'Upload failed',
        details: data
      }), { status: 500 });
    }

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
