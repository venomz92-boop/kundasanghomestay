# System Architecture

## Status
This document must be updated from the actual repository. Do not treat placeholders as facts.

## High-Level Architecture
Describe the request flow:

User → Frontend → API/Server Logic → Database → External Services

Replace this diagram with the verified architecture when known.

## Repository Structure
Document the actual directories and their responsibilities.

| Path | Responsibility |
|---|---|
| | |

## Frontend
- Framework:
- Routing:
- State management:
- Form handling:
- Validation:
- UI/component conventions:

## Backend
- Runtime:
- API structure:
- Server-side validation:
- Error handling:
- Logging:

## Authentication & Authorization
- Authentication provider:
- Session/token mechanism:
- Role enforcement:
- Server-side authorization:
- Password/credential handling:

## External Services
| Service | Purpose | Configuration Location | Verification |
|---|---|---|---|
| Cloudflare | Deployment/runtime | | |
| | | | |

## Data Flow
Document important flows such as:
- Registration
- Login
- Listing creation
- Booking creation
- Payment confirmation
- Admin deletion/moderation

## Architectural Constraints
- Avoid unnecessary rewrites.
- Preserve public API compatibility where possible.
- Keep secrets server-side.
- Validate permissions server-side.
- Document breaking changes before implementation.
