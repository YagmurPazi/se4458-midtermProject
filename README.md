# AI Tuition Assistant — SE 4458 Midterm (Group 1)

A conversational assistant that answers student questions about tuition deadlines, installments, payment rules, balances and payments. An LLM chooses between a policy search tool (MCP) and live tuition operations (REST API behind an API Gateway), or uses both.

> Status: work in progress. Sections marked _TBD_ are completed in later stages.

## Contents
1. [Architecture](#1-architecture)
2. [Repository layout](#2-repository-layout)
3. [API](#3-api)
4. [API Gateway](#4-api-gateway) _TBD_
5. [MCP server and indexing](#5-mcp-server-and-indexing) _TBD_
6. [AI Agent](#6-ai-agent) _TBD_
7. [Data model](#7-data-model) _TBD_
8. [Running locally](#8-running-locally) _TBD_
9. [Cloud deployment](#9-cloud-deployment) _TBD_
10. [Testing](#10-testing) _TBD_
11. [Demonstration evidence](#11-demonstration-evidence) _TBD_
12. [Assumptions and design decisions](#12-assumptions-and-design-decisions)
13. [LLM cost](#13-llm-cost) _TBD_

## 1. Architecture

```
User (CLI chat)
   │ question
   ▼
AI Agent orchestrator ───── prompts / tool requests ─────► LLM (Gemini, function calling)
   │                                                        (selects tools, writes the answer)
   ├── MCP client ──HTTP──► MCP Server ──► indexed University_Tuition_Policies.md
   │
   └── REST ──► API Gateway (Kong) ──► Tuition REST API (NestJS) ──► PostgreSQL
```

- The **agent** executes every tool call. The LLM only selects tools and writes the final answer; it never calls a backend directly.
- The **MCP path** (policy documentation) and the **gateway path** (live records and transactions) are separate.
- The policy document is indexed **once, at build time**, not for every question.

## 2. Repository layout

| Path | Contents |
|---|---|
| `apps/tuition-api` | NestJS REST API, Prisma schema and migrations, unit tests |
| `apps/mcp-server` | MCP server, policy indexer, `search_tuition_policies` tool |
| `apps/agent` | CLI chat agent (Gemini + MCP client + REST client) |
| `gateway/` | Kong declarative configuration |
| `infra/` | Azure deployment scripts |
| `docs/` | API contract, ER diagram, screenshots and tool traces |

## 3. API

The full contract, with request and response examples and every error code, is in [docs/API.md](docs/API.md). Swagger UI is served at `/api/docs`.

| Client | Operation | Method and route | Auth | Paging |
|---|---|---|---|---|
| — | Login | `POST /api/v1/auth/login` | — | — |
| Mobile App | Query Tuition | `GET /api/v1/mobile/tuition` (header `X-Student-No`) | No | No |
| Banking App | Query Tuition | `GET /api/v1/banking/tuition/{studentNo}` | Yes | No |
| Banking App | Pay Tuition | `POST /api/v1/banking/payments` | Yes | No |
| Admin | Add Tuition | `POST /api/v1/admin/tuition` | Yes | No |
| Admin | Add Tuition – Batch | `POST /api/v1/admin/tuition/batch` | Yes | No |
| Admin | Unpaid Tuition Status | `GET /api/v1/admin/tuition/unpaid` | Yes | Yes |

## 4. API Gateway
_TBD (Stage 4)._

## 5. MCP server and indexing
_TBD (Stage 5)._

## 6. AI Agent
_TBD (Stage 6)._

## 7. Data model
_TBD (Stage 2)._

## 8. Running locally
_TBD._

## 9. Cloud deployment
_TBD (Stage 7)._

## 10. Testing
_TBD._

## 11. Demonstration evidence
_TBD (Stage 8)._

## 12. Assumptions and design decisions

### 12.1 Technology
| Decision | Choice | Reason |
|---|---|---|
| Language and framework | TypeScript, NestJS | Modular structure, built-in validation and Swagger generation, first-class Jest support |
| ORM | Prisma | The schema file is the single source of truth for the data model and migrations |
| Database | PostgreSQL 16 (Azure Database for PostgreSQL Flexible Server in the cloud) | Server database as required; SQLite is not used |
| API Gateway | Kong Gateway OSS 3.x, DB-less declarative mode | Free, cloud-deployable, and supports per-student rate limiting (see 12.4). Azure API Management's Consumption tier does not support key-based rate limits, and the tiers that do are costly for a course project |
| LLM | Google Gemini (Flash model) via the Gemini API free tier | Native function calling, no cost for this project's volume (see section 13) |
| MCP | Official `@modelcontextprotocol/sdk`, Streamable HTTP transport (stdio also supported for local use) | HTTP is required to deploy the MCP service as a separate cloud service |
| Search | Full-text BM25 search with MiniSearch | Allowed by the assignment; no embedding cost; deterministic results for tests |
| Chat interface | Command-line chat | UI is not graded; a CLI makes tool traces easy to show |

### 12.2 API style and versioning
- REST over JSON, all routes under `/api/v1`. A breaking change would be published as `/api/v2` alongside v1.
- Errors share one JSON shape with a machine-readable `error` code (see [docs/API.md](docs/API.md#error-format)).

### 12.3 Identity, authentication and authorization
- Authentication uses **JWT (HS256)** issued by the API's own `POST /api/v1/auth/login` endpoint. Demo users are seeded; credentials are listed in section 8.
- Roles: `STUDENT`, `BANK`, `ADMIN`.
  - `STUDENT` can query and pay **only their own** tuition. The `studentNo` claim in the token must match the requested student, otherwise `403`.
  - `BANK` represents the banking system and may query and pay for any student.
  - `ADMIN` is required for every admin operation.
- The JWT is verified by Kong (signature and expiry) **and** by the API (signature, expiry, role, ownership).
- The **AI Agent never trusts a student number from the prompt.** The user logs in when the chat starts, the agent stores that student's token, and its tools have no student-number parameter: the number always comes from the token. Asking about another student's balance therefore returns only the logged-in student's data, or a `403`.
- The mobile Query Tuition endpoint is unauthenticated, as the specification requires.

### 12.4 Rate limiting
- The mobile Query Tuition rule (3 calls per student per day) is enforced **at the gateway**.
- The specification lists "Student No" as the parameter but does not say how it is transmitted. The assignment allows alternative API styles if the required operations are preserved and the choice is documented; this section documents it.
- Kong's open-source rate-limiting plugin can key counters by consumer, credential, IP, service, a header, or one fixed path. It cannot key by a path parameter. For this reason the mobile endpoint receives the student number in the `X-Student-No` header, and the plugin uses `limit_by: header`. The limit is therefore keyed by student identity, not by client IP.
- Every call counts, including calls that end in an error such as `404`.
- The day is a calendar day in **UTC** (Kong's fixed daily window).
- Counters are kept in Kong's memory (`policy: local`) and the gateway runs as a **single instance**, so the count is exact. A restart resets the counters. A multi-instance deployment would need the `redis` policy.

### 12.5 Tuition and balance
- Currency is **USD**. The policy document uses dollar amounts, so `currency` must be `USD` and no conversion is performed.
- Amounts are positive, have at most 2 decimal places and are stored as `NUMERIC(12,2)`. Inputs with more than 2 decimals are rejected rather than rounded, so no rounding happens in the API.
- **Balance = tuition amount − sum of recorded payments.** The balance is calculated, not stored, so it cannot drift out of sync.
- Query Tuition supports both scopes: with `term` it returns that term; without it, the overall total with a per-term breakdown.
- Tuition amounts are recorded **after** any scholarship or adjustment. Scholarships are not modelled separately. Following policy §5.2, the assistant explains the 25% rule but never claims that a particular student has a scholarship.
- Late fees are **not** calculated or posted (policy §4.1). The assistant may explain the 2% rule but does not add fees to balances.
- Terms use the policy format `YYYY-FALL`, `YYYY-SPRING`, `YYYY-SUMMER`.

### 12.6 Add Tuition and batch import
- Add Tuition is **create-or-update** on `studentNo` + `term`:
  - new record → created (`201`);
  - different amount → updated (`200`);
  - same amount → unchanged (`200`);
  - new amount lower than the amount already paid → rejected (`422`), so a balance can never become negative.
- The student must already exist. Students are master data and are not created by tuition operations (`404` otherwise).
- Batch CSV rows are processed **independently**: valid rows are saved, failed rows are reported with their line number and an error code, and the response gives success and failure counts. A duplicate `studentNo` + `term` inside one file is processed once; later occurrences fail with `DUPLICATE_IN_FILE`. An invalid header rejects the whole file.

### 12.7 Payments
- Payments are **simulated**. No real money or card processing.
- Partial and full payments are allowed. The amount must be positive and must not exceed the remaining balance (policy §7.2). Overpayment is not supported.
- `transactionId` is the idempotency key (policy §7.4). A repeated `transactionId` is rejected with `409` and the original payment is returned; no second record is created.
- The tuition row is locked during a payment, so concurrent payments cannot overpay.
- A partial payment is **not** an installment approval (policy §3.4). The API has no installment-approval operation, and the assistant does not promise approval.

### 12.8 Unpaid Tuition Status
- Lists students with **balance > 0** for the given term, so partially paid students are included.
- `term` is required. `page` starts at 1. `pageSize` defaults to 20, maximum 100.
- Sorting is selectable: `sortBy=balance|studentNo`, `sortOrder=asc|desc`. Default: `balance desc`. Ties are broken by `studentNo asc` so pages stay stable.
- If no student has an unpaid balance, page 1 returns an empty list (`totalPages: 0`).
- Requesting a page beyond the last page returns `400 PAGE_OUT_OF_RANGE`. If all results fit on one page, there is no page 2.

### 12.9 AI Agent behaviour
- Tool selection is done by the LLM through real function calling. There is no keyword routing.
- Agent tools: `search_tuition_policies(query)` (MCP), `get_my_tuition(term?)` (REST via gateway) and `pay_my_tuition(term, amount)` (REST via gateway).
- **Payment confirmation is enforced in code, not only in the prompt.** When the LLM requests a payment, the agent does not call the API. It shows the student, term, amount and current balance (policy §7.3) and waits. The payment is submitted only if the user's next message is an explicit confirmation (`yes` / `confirm`). Anything else cancels it. A question such as "Can I pay $500?" is never treated as authorization.
- The agent generates the `transactionId` (UUID) when the user confirms and reports success only after the API returns success (policy §7.4).
- Answers that use the policy cite section numbers (for example "§3.2").
- The assistant answers in the user's language; code and documentation are in English.
- Every turn writes a tool trace (tool name, input, result, final answer) to the console and to a JSON log file.

### 12.10 Policy interpretation
- Deadlines are in the university's local time zone (policy §2.2); this project uses `Europe/Istanbul`.
- Installment eligibility (balance of at least $300, up to three installments, policy §3) is explained by the assistant using the live balance plus the policy text. The assistant states that an arrangement is **subject to approval** and never confirms approval.
- Refund questions are answered from policy §6, and the user is directed to the finance office for decisions.

### 12.11 MCP server
- The document is split by Markdown headings into one chunk per `###` subsection (or per `##` section when it has no subsections). Each chunk keeps its section ID, heading and parent heading.
- The index is built once at build time and loaded at startup. It is not rebuilt per question.
- `search_tuition_policies(query)` returns the top matches with `document`, `documentId`, `section`, `heading` and `text`, following the format suggested in policy §9.
- The MCP endpoint does not go through the API Gateway, as the assignment specifies. It is protected with a shared API key header.

### 12.12 Deployment
- Cloud: Microsoft Azure. Tuition API, MCP server and Kong run on Azure Container Apps; the database is Azure Database for PostgreSQL Flexible Server (Burstable B1MS).
- The CLI agent runs on the user's machine and connects to the cloud gateway and MCP URLs.
- Secrets (JWT secret, database URL, Gemini API key, MCP API key) are supplied as environment variables and are never committed.

## 13. LLM cost
_TBD._
