# Database Schema

## Warning
This document must reflect the actual database schema. Inspect migrations, schema files, and production configuration before updating it.

## Database Provider
- Provider:
- Environment:
- Migration system:
- Local database:
- Production database:

## Tables / Collections

| Name | Purpose | Primary Key | Important Relationships |
|---|---|---|---|
| | | | |

## Relationships
Document verified relationships, foreign keys, indexes, and cascade behavior.

## Critical Operations
For each operation, document authorization and data-integrity requirements.

### Guest Deletion
- Authorized roles:
- Related records:
- Soft delete or hard delete:
- Cascade behavior:
- Audit requirements:
- Verification status:

### Booking Creation
- Required validation:
- Availability checks:
- Concurrency protection:
- Payment state:
- Rollback behavior:

## Migration Rules
1. Never make destructive schema changes without explicit approval.
2. Back up or establish a rollback plan where applicable.
3. Review existing records and relationships.
4. Test migrations in a safe environment.
5. Document migration commands and outcomes.

## Data Protection
- Never include production secrets.
- Do not include real personal data.
- Use synthetic examples in documentation.
