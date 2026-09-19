# Security Checklist

Use this checklist for reviews and feature changes.

## Authentication
- [ ] Authentication is handled by the approved system.
- [ ] Sessions/tokens are validated server-side.
- [ ] Passwords or secrets are never logged.
- [ ] Logout and session invalidation are handled correctly.

## Authorization
- [ ] Every privileged operation checks permissions server-side.
- [ ] Role checks cannot be bypassed from the frontend.
- [ ] Object-level access is enforced.
- [ ] Admin endpoints are protected.

## Input & API Security
- [ ] User input is validated.
- [ ] Database queries are parameterized or safely constructed.
- [ ] Errors do not reveal sensitive internals.
- [ ] Rate limiting is considered where appropriate.
- [ ] File uploads are validated if applicable.

## Secrets & Deployment
- [ ] No secrets are committed.
- [ ] Environment variables are documented without values.
- [ ] Production and development settings are separated.
- [ ] Cloudflare configuration is reviewed before changes.

## Data Protection
- [ ] Personal data exposure is minimized.
- [ ] Deletion behavior is documented.
- [ ] Audit requirements are considered.
- [ ] Backups or rollback plans exist for destructive changes.

## Review Result
- Reviewer:
- Date:
- Findings:
- Follow-up tasks:
