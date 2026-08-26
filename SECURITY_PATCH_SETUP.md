# Kundasang Homestay — Security Patch Setup

This patch replaces the forgeable Base64 owner/guest authentication tokens with HMAC-signed sessions, moves new passwords to PBKDF2, makes booking prices server-authoritative, restricts booking reads to the authenticated guest/admin, locks down public booking cancellation, secures homestay registration, and adds the ToyyibPay bill callback endpoint with the official MD5 callback verification formula.

## Required Cloudflare Pages environment variables / secrets

Set these in the Pages project under **Settings → Variables and Secrets**.

### Required

- `SESSION_SECRET` — random secret, at least 32 characters. Use a unique high-entropy value.
- `PASSWORD_PEPPER` — separate high-entropy secret for PBKDF2 password hashing. If omitted, `SESSION_SECRET` is used.
- `ADMIN_TOKEN` — existing admin secret.
- `PUBLIC_DOMAIN` — `https://kundasanghomestay.my`

### ToyyibPay payments

- `TOYYIBPAY_PAYMENT_ENABLED=true` to enable live bill creation.
- `TOYYIBPAY_SECRET_KEY` — ToyyibPay user secret key.
- `TOYYIBPAY_CATEGORY_CODE` — ToyyibPay category code.

Do not enable live payments until the callback URL is deployed and tested.

### Owner payouts

- `TOYYIBPAY_PAYOUT_ENABLED=true` only when your ToyyibPay payout integration is configured and verified.
- `PAYOUT_SIMULATION=true` should only be used for controlled testing. Keep it `false` or unset in production.

### Password reset email

Configure either:

- `RESEND_API_KEY` and optionally `FROM_EMAIL`
- OR `SENDGRID_API_KEY` and optionally `FROM_EMAIL`

Reset URLs are no longer written to server logs.

### Legacy password migration

Existing accounts created with the old SHA-256 scheme can still log in. After a successful login, their password is transparently upgraded to PBKDF2.

If you want to explicitly preserve the old pepper during migration, set:

- `LEGACY_PASSWORD_PEPPER=kundasang-homestay-2026`

After all old accounts have logged in successfully or have reset their passwords, remove the legacy secret and delete the legacy verification fallback from `_utils.js`.

## Important payment behavior change

Bookings are now created as:

`Pending Payment`

They become:

`Paid - Awaiting Check-in`

only after a valid ToyyibPay server callback is received and its MD5 signature and amount are verified.

The browser can no longer mark a booking as paid.

## ToyyibPay callback

The bill callback URL is:

`https://kundasanghomestay.my/api/toyyibpay-webhook`

ToyyibPay's documented callback signature is validated as:

`MD5(userSecretKey + status + order_id + refno + "ok")`

The callback also verifies that the received amount matches the authoritative booking total before changing payment state.

## Deployment checklist

1. Deploy all patched files together.
2. Set the required environment secrets.
3. Confirm `SESSION_SECRET` and `PASSWORD_PEPPER` are not present in source code.
4. Register a test guest.
5. Log in as that guest and confirm `/api/bookings` only returns that guest's bookings.
6. Register a test homestay and confirm it enters pending state.
7. Confirm the owner login works only after the server has stored the owner password hash.
8. Create a ToyyibPay sandbox bill before enabling live payment.
9. Test the ToyyibPay callback with the sandbox account.
10. Confirm the booking remains `Pending Payment` if the callback is invalid or has the wrong amount.
11. Test owner check-in with payout simulation before enabling real payouts.
12. Disable `PAYOUT_SIMULATION` before production.

## Do not restore these old patterns

- Base64 JSON as authentication.
- Client-supplied booking totals.
- Client-supplied payment status.
- Public GET of all bookings.
- Public POST of the complete pending-homestay array.
- Reset URLs in logs.
- Demo bank accounts as a payment fallback.
