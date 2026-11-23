# Tuition API — Contract (v1)

All operations are exposed **only through the API Gateway (Kong)**. Clients, including the AI Agent, never call the service directly.

- Base path: `/api/v1`
- Versioning: URI versioning (`/api/v1/...`). A breaking change ships as `/api/v2/...` while v1 keeps running.
- Format: JSON (`application/json`), except the batch upload, which takes `multipart/form-data`.
- Money: decimal numbers with at most 2 fraction digits, stored as `NUMERIC(12,2)`. Currency is `USD` (see Assumptions).
- Term format: `YYYY-FALL`, `YYYY-SPRING` or `YYYY-SUMMER` (for example `2026-FALL`), as in the policy document section 1.
- Interactive documentation: Swagger UI at `/api/docs` (OpenAPI JSON at `/api/docs-json`).

## Clients, roles and access

| Client | Role in JWT | Can access |
|---|---|---|
| University Mobile App | — (no token) | Mobile Query Tuition only |
| Banking App / AI Agent on behalf of a student | `STUDENT` | Own records only (`studentNo` claim must match) |
| Banking App (bank system account) | `BANK` | Query and pay for any student |
| University Web Site – Admin | `ADMIN` | Admin operations |

The AI Agent always uses the **logged-in student's token**. The student number is taken from the token, never from the prompt, so a student cannot read or pay another student's tuition by typing a different number.

## Authentication

### `POST /api/v1/auth/login`

Issues a JWT (HS256). Not rate-limited beyond the gateway default.

Request:
```json
{ "username": "20230001", "password": "Student#2026" }
```

Response `200`:
```json
{
  "accessToken": "<jwt>",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "role": "STUDENT",
  "studentNo": "20230001"
}
```

JWT claims: `sub` (user id), `role`, `studentNo` (students only), `iss` (`tuition-auth`, used by Kong to pick the verification key), `iat`, `exp`.

For `BANK` and `ADMIN` users `studentNo` is `null` and the token carries no `studentNo` claim.

Errors: `400 VALIDATION_ERROR` (missing field, username longer than 64 or password longer than 128 characters), `401 INVALID_CREDENTIALS` (unknown user and wrong password give the same response).

Protected endpoints require `Authorization: Bearer <jwt>`. The token is checked twice: Kong verifies signature and expiry, and the API verifies it again and enforces role and ownership (defense in depth).

---

## University Mobile App

### Query Tuition (mobile) — `GET /api/v1/mobile/tuition`

| | |
|---|---|
| Auth | None |
| Paging | No |
| Rate limit | **3 calls per student per day**, enforced by Kong and keyed by the `X-Student-No` header (student identity), not by client IP |

Headers: `X-Student-No: 20230001` (required)
Query: `term` (optional). Without `term`, the overall balance across all terms is returned with a per-term breakdown.

Response `200`:
```json
{
  "studentNo": "20230001",
  "scope": "OVERALL",
  "term": null,
  "currency": "USD",
  "tuitionTotal": 6000.00,
  "paidAmount": 1500.00,
  "balance": 4500.00,
  "terms": [
    { "term": "2026-FALL",   "tuitionTotal": 3000.00, "paidAmount": 1500.00, "balance": 1500.00 },
    { "term": "2027-SPRING", "tuitionTotal": 3000.00, "paidAmount": 0.00,    "balance": 3000.00 }
  ]
}
```
With `?term=2026-FALL`, `scope` is `TERM`, `term` is set and `terms` holds only that term. `terms` is ordered chronologically (year, then SPRING, SUMMER, FALL). A student who exists but has no tuition records gets `200` with all totals `0` and `terms: []` when no `term` is given.

Errors: `400 MISSING_STUDENT_NO` (header missing or empty), `400 VALIDATION_ERROR` (header not 8 digits, bad `term`), `404 STUDENT_NOT_FOUND`, `404 TUITION_NOT_FOUND` (term given but no record), `429` from the gateway after the third call of the day.

---

## Banking App

### Query Tuition (banking) — `GET /api/v1/banking/tuition/{studentNo}`

| | |
|---|---|
| Auth | Yes: `STUDENT` (own number only) or `BANK` |
| Paging | No |

Query: `term` (optional). Response body is identical to the mobile query.

Errors: `400 VALIDATION_ERROR` (`studentNo` not 8 digits, bad `term`), `401 UNAUTHORIZED` (missing, invalid or expired token), `403 FORBIDDEN_ROLE` (`ADMIN` token), `403 FORBIDDEN_STUDENT` (student token, different number), `404 STUDENT_NOT_FOUND`, `404 TUITION_NOT_FOUND`.

### Pay Tuition — `POST /api/v1/banking/payments`

| | |
|---|---|
| Auth | Yes: `STUDENT` (own number only) or `BANK` |
| Paging | No |

Records a **simulated** partial or full payment. No card processing.

Request:
```json
{
  "studentNo": "20230001",
  "term": "2026-FALL",
  "amount": 500.00,
  "transactionId": "9f1c2e4a-7b9d-4c1e-8a7f-1d2c3b4a5e6f"
}
```
`transactionId` is the client's idempotency key: 8–64 characters, `[A-Za-z0-9_-]`. The AI Agent generates a UUID after the user confirms.

Response `201`:
```json
{
  "status": "SUCCESS",
  "transactionId": "9f1c2e4a-7b9d-4c1e-8a7f-1d2c3b4a5e6f",
  "studentNo": "20230001",
  "term": "2026-FALL",
  "paidAmount": 500.00,
  "totalPaid": 2000.00,
  "remainingBalance": 1000.00,
  "currency": "USD",
  "paidAt": "2026-11-17T14:05:00.000Z"
}
```

Errors:
- `400 VALIDATION_ERROR` (amount ≤ 0, above 1,000,000 or with more than 2 decimals, bad studentNo, term or transactionId format)
- `401 UNAUTHORIZED`, `403 FORBIDDEN_ROLE` (`ADMIN` token)
- `403 FORBIDDEN_STUDENT`
- `404 TUITION_NOT_FOUND`
- `409 DUPLICATE_TRANSACTION`: the transactionId was already used, and no new payment is recorded. If the original payment belongs to the same student, the error body also contains it in a `payment` field (same shape as the `201` body). If it belongs to another student, the field is omitted so no other student's data is revealed. A retried request always gets `409`, even if the amount would now exceed the balance.
- `422 AMOUNT_EXCEEDS_BALANCE`: the amount is greater than the remaining balance (this includes paying a term that is already fully paid).

Concurrency: the tuition row is locked (`SELECT … FOR UPDATE`) inside a transaction, and `transactionId` has a unique constraint, so two simultaneous requests can neither overpay nor double-record.

---

## University Web Site – Admin

All admin operations require a token with role `ADMIN`. Other roles receive `403 FORBIDDEN_ROLE`.

### Add Tuition — `POST /api/v1/admin/tuition`

Request:
```json
{ "studentNo": "20230001", "term": "2026-FALL", "amount": 3000.00, "currency": "USD" }
```

Duplicate handling (create-or-update, keyed by `studentNo` + `term`):
| Situation | Result |
|---|---|
| No record for student + term | Create → `201`, `status: "CREATED"` |
| Record exists, different amount | Update amount → `200`, `status: "UPDATED"` |
| Record exists, same amount | No change → `200`, `status: "UNCHANGED"` |
| New amount is lower than what has already been paid | Reject → `422 AMOUNT_BELOW_PAID` |

Response:
```json
{
  "status": "CREATED",
  "studentNo": "20230001",
  "term": "2026-FALL",
  "amount": 3000.00,
  "currency": "USD",
  "paidAmount": 0.00,
  "balance": 3000.00
}
```

Errors: `400` validation (amount must be > 0 and ≤ 1,000,000 with at most 2 decimals; currency must be `USD`), `404 STUDENT_NOT_FOUND` (students are master data and are not created by this operation).

### Add Tuition – Batch — `POST /api/v1/admin/tuition/batch`

`multipart/form-data` with one file field named `file` (CSV, UTF-8, at most 1 MB and 1,000 data rows).

```csv
studentNo,term,amount,currency
20230001,2026-FALL,3000.00,USD
20230002,2026-FALL,2500.00,USD
```

Processing rules:
- The header row must be exactly `studentNo,term,amount,currency`. Otherwise the whole file is rejected with `400 INVALID_CSV_HEADER`.
- Each row is validated and processed **independently** with the same rules as Add Tuition. Valid rows are saved even if other rows fail.
- If the same `studentNo` + `term` appears more than once in the file, the first valid occurrence is processed and later ones fail with `DUPLICATE_IN_FILE`.
- Row-level error codes: `VALIDATION_ERROR` (wrong column count, bad studentNo, term or amount, currency other than `USD`), `STUDENT_NOT_FOUND`, `AMOUNT_BELOW_PAID`, `DUPLICATE_IN_FILE`.
- `succeeded` counts rows with status `CREATED`, `UPDATED` or `UNCHANGED`. Empty lines are skipped but still counted in `row` numbers.

Response `200`:
```json
{
  "totalRows": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "row": 2, "studentNo": "20230001", "term": "2026-FALL", "status": "CREATED" },
    { "row": 3, "studentNo": "20230002", "term": "2026-FALL", "status": "UPDATED" },
    { "row": 4, "studentNo": "99999999", "term": "2026-FALL", "status": "FAILED", "error": "STUDENT_NOT_FOUND" }
  ]
}
```
`row` is the line number in the file (the header is line 1).

Errors: `400 MISSING_FILE` (also when the file is sent in another multipart field), `400 INVALID_CSV_HEADER` (also for an empty file), `400 FILE_TOO_LARGE` (over 1 MB or more than 1,000 data rows), `400 VALIDATION_ERROR` (file is not valid CSV, e.g. an unclosed quote).

### Unpaid Tuition Status — `GET /api/v1/admin/tuition/unpaid`

| Query parameter | Required | Default | Rules |
|---|---|---|---|
| `term` | Yes | — | Term format |
| `page` | No | `1` | Integer ≥ 1 |
| `pageSize` | No | `20` | Integer 1–100 |
| `sortBy` | No | `balance` | `balance` or `studentNo` |
| `sortOrder` | No | `desc` | `asc` or `desc` |

"Unpaid" means **balance > 0**, so partially paid students are included. Ties are broken by `studentNo` ascending, which keeps page boundaries stable.

Response `200`:
```json
{
  "term": "2026-FALL",
  "page": 1,
  "pageSize": 20,
  "totalItems": 7,
  "totalPages": 1,
  "sortBy": "balance",
  "sortOrder": "desc",
  "items": [
    {
      "studentNo": "20230003",
      "fullName": "Deniz Kaya",
      "term": "2026-FALL",
      "tuitionTotal": 3000.00,
      "paidAmount": 0.00,
      "balance": 3000.00,
      "currency": "USD"
    }
  ]
}
```
Paging boundaries:
- No unpaid students for the term → `200` with `items: []`, `totalItems: 0`, `totalPages: 0` (only `page=1` is valid).
- A page beyond the last page is rejected with `400 PAGE_OUT_OF_RANGE`. For example, if all results fit on one page, `page=2` is an error.

Errors: `400 VALIDATION_ERROR` (missing `term`, bad values, unknown query parameters), `400 PAGE_OUT_OF_RANGE`.

---

## Error format

Errors raised by the API use one shape:
```json
{
  "statusCode": 422,
  "error": "AMOUNT_EXCEEDS_BALANCE",
  "message": "Payment amount 3500.00 exceeds the remaining balance 3000.00.",
  "path": "/api/v1/banking/payments",
  "timestamp": "2026-11-17T14:05:00.000Z"
}
```

Common error codes used by every endpoint:

| Status | `error` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Request body, path or query fails validation, or contains unknown fields. `message` lists the problems, separated by `; `. Also for a body that is not valid JSON or is larger than 100 kB. |
| 401 | `UNAUTHORIZED` | Missing, invalid or expired token on a protected route |
| 403 | `FORBIDDEN_ROLE` | Token role is not allowed for the operation |
| 404 | `NOT_FOUND` | Unknown route |
| 500 | `INTERNAL_ERROR` | Unexpected server error (no internal details are returned) |

Order of checks on protected routes: token and role (`401`/`403 FORBIDDEN_ROLE`), then validation (`400`), then ownership (`403 FORBIDDEN_STUDENT`), then the database (`404`, `409`, `422`).

Errors raised by the gateway (before the request reaches the API) use Kong's format:
```json
{ "message": "Unauthorized" }                                          // 401 – no JWT
{ "message": "Invalid signature" }                                     // 401 – JWT signed with another key or altered
{ "exp": "token expired" }                                             // 401 – JWT past its exp claim
{ "message": "API rate limit exceeded", "request_id": "82429669..." }  // 429 – fourth mobile query of the day
{ "message": "no Route matched with those values", "request_id": "…" } // 404 – unknown path, version or method
```
Rate-limited responses also carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `Retry-After` headers. Every route also has a gateway default of 120 requests per minute per client IP; the mobile route uses its own daily limit instead.

## Health

`GET /api/v1/health` → `200 { "status": "ok" }` (public, used by cloud health probes).
