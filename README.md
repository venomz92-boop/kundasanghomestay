
# Kundasang Homestays - Cloud Sync Setup (Cloudflare KV)

Your bookings now sync across all phones because they are stored in Cloudflare KV, not localStorage.

## Files added:
- `functions/api/bookings.js` - Main API: GET all bookings, POST new booking, DELETE booking, POST action=updateDates (Change Date)
- `functions/api/availability.js` - Availability map

## Updated files:
- `index.html` - Now on booking: saves locally + POST to /api/bookings, on load: fetches from /api/bookings
- `admin.html` - Now on load: fetches from /api/bookings, Remove/Delete and Change Date also sync to cloud

## How to deploy on Cloudflare Pages:

1. **Create KV Namespace:**
   - Go to Cloudflare Dashboard > Workers & Pages > KV
   - Create namespace: Name = `KD_DATA`
   - Note the ID

2. **Bind KV to your Pages project:**
   - Go to your Pages project > Settings > Functions > KV namespace bindings
   - Add binding:
     - Variable name: `KD_DATA`
     - KV namespace: select `KD_DATA` you created

3. **Push files:**
   - Your project structure should be:
     ```
     /
     - index.html
     - admin.html
     - functions/
       - api/
         - bookings.js
         - availability.js
     ```
   - Commit & push to GitHub, Cloudflare Pages will auto-deploy

4. **Test:**
   - Open your site on Phone A: https://your-site.pages.dev - make a booking
   - Open admin on Phone B: https://your-site.pages.dev/admin.html - you should see Bookings (1) instantly
   - The alert will say "☁️ Synced to cloud - admin will see it"

## Local testing (without cloud):
In both index.html and admin.html, set:
```js
const CLOUD_ENABLED = false;
```
Then it falls back to localStorage only (old behavior).

## How it works:
- `GET /api/bookings` returns { bookings: [...], availability: {...} } from KV
- `POST /api/bookings` with { booking, bookedDates } adds booking and blocks dates
- `DELETE /api/bookings?id=KDH-123456` removes booking and unblocks dates
- `POST /api/bookings` with { action: "updateDates", id, checkin, checkout, ... } changes dates

No database needed, KV is free for small projects.

## Troubleshooting:
- If you see "KV not bound" error: you forgot to bind KD_DATA in Pages settings
- If bookings still don't show: check browser console (F12) for "☁️ Cloud bookings loaded: X"
- Old local bookings? They are merged - cloud is source of truth after first fetch
