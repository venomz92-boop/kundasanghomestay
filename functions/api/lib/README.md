# API Library Modules

This directory contains modular, reusable library functions extracted from the monolithic `_utils.js` file. Each module focuses on a specific concern following the Single Responsibility Principle.

## Modules

### `crypto.js` - Cryptographic Operations
- Token creation and verification (JWT-like)
- Password hashing with PBKDF2
- HMAC signing
- Base64url encoding/decoding
- Salt generation

**Key exports:**
- `createSignedToken(payload, env, ttlMs)`
- `verifySignedToken(token, env)`
- `hashPassword(password, env, salt)`
- `verifyPassword(password, record, env)`
- `generateSalt()`

### `http.js` - HTTP Utilities
- Request parsing (cookies, headers, body)
- Response helpers (JSON, error responses)
- CORS headers configuration
- Cookie management
- HTTPS enforcement

**Key exports:**
- `getCookie(request, name)`
- `getBearerToken(request, headerName)`
- `jsonResponse(body, status, request, extra)`
- `errorResponse(message, status, request)`
- `corsHeaders(request)`
- `parseJSONSafely(request)`

### `validation.js` - Input Validation & Sanitization
- Email validation
- Phone number validation (Malaysia format)
- Price validation
- String sanitization
- Bank code validation (CHIP whitelist)

**Key exports:**
- `isValidEmail(email)`
- `isValidPhone(phone)`
- `isValidPrice(price)`
- `sanitizeString(str, maxLen)`
- `validateBankCode(code)`
- `cleanWhatsapp(value)`

### `database.js` - Database Operations
- Rate limiting
- Audit logging
- Session version management
- Check-in attempt tracking
- Distributed locking

**Key exports:**
- `checkRateLimit(db, ip, action, maxAttempts, windowSeconds)`
- `recordRateLimit(db, ip, action)`
- `logAction({ db, action, admin, details, ip, userId, homestayId })`
- `incrementSessionVersion(db, userId, type)`
- `withLock(db, lockKey, callback, staleTimeoutMs)`

### `csrf.js` - CSRF Protection
- Token generation
- Token validation

**Key exports:**
- `generateCSRFToken(userId, env)`
- `validateCSRFToken(token, userId, env)`

### `email.js` - Email Sending
- Host payout notifications
- CHIP compliance record emails
- Resend/SendGrid integration

**Key exports:**
- `sendHostPayoutEmail(booking, homestay, payoutInfo, env)`
- `sendPayoutRecordEmail(booking, payoutInfo, env)`

### `index.js` - Central Export Point
Re-exports all modules for convenient importing:

```javascript
// Option 1: Import specific module
import { hashPassword } from './lib/crypto.js';

// Option 2: Import everything from index
import { hashPassword, jsonResponse, isValidEmail } from './lib/index.js';

// Option 3: Import entire namespace
import * as utils from './lib/index.js';
utils.hashPassword(...);
```

## Migration from `_utils.js`

The original `_utils.js` file remains unchanged for backward compatibility. New code should import from these modular files instead. Gradually migrate existing endpoints by updating their imports:

**Before:**
```javascript
import { hashPassword, getCookie, corsHeaders } from './_utils.js';
```

**After:**
```javascript
import { hashPassword } from './lib/crypto.js';
import { getCookie, corsHeaders } from './lib/http.js';
// or
import { hashPassword, getCookie, corsHeaders } from './lib/index.js';
```

## Testing

Each module is designed to be independently testable. Mock the `env` and `db` objects when writing unit tests.

## Security Notes

- Always validate and sanitize user input before database operations
- Use `withLock()` for operations that require atomicity
- Never expose SESSION_SECRET or PASSWORD_PEPPER to client-side code
- CSRF tokens must be validated on all mutating requests

### `session.js` - Session Management
- Guest session retrieval and validation
- Owner session retrieval and validation  
- Admin session retrieval
- Session version checking for invalidation

**Key exports:**
- `getGuestSession(request, env)`
- `getOwnerSession(request, env)`
- `getAdminSession(request, env)`
- `verifyAdminAuth(request, env)`
