# AI Tuition Assistant — SE 4458 Midterm (Group 1)

A conversational assistant that answers student questions about tuition deadlines, installments, payment rules, balances and payments. An LLM chooses between a policy search tool (MCP) and live tuition operations (REST API behind an API Gateway), or uses both.

> Status: work in progress. Sections marked _TBD_ are completed in later stages.

## Contents
1. [Architecture](#1-architecture)
2. [Repository layout](#2-repository-layout)
3. [API](#3-api)
4. [API Gateway](#4-api-gateway)
5. [MCP server and indexing](#5-mcp-server-and-indexing)
6. [AI Agent](#6-ai-agent)
7. [Data model](#7-data-model)
8. [Running locally](#8-running-locally) _(partly TBD)_
9. [Cloud deployment](#9-cloud-deployment)
10. [Testing](#10-testing)
11. [Demonstration evidence](#11-demonstration-evidence) _TBD_
12. [Assumptions and design decisions](#12-assumptions-and-design-decisions)
13. [Cost](#13-cost)

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

Kong Gateway OSS 3.9 in DB-less mode. Every REST operation, including the AI Agent's calls, goes through Kong; the API itself is not published (in Docker Compose it has no host port).

| | |
|---|---|
| Gateway URL (local) | `http://localhost:8000` |
| Gateway URL (cloud) | https://tuition-gateway.bluesea-79ab2835.swedencentral.azurecontainerapps.io |
| Configuration | [`gateway/kong.yml`](gateway/kong.yml), image [`gateway/Dockerfile`](gateway/Dockerfile) |
| Upstream | Tuition API service `http://tuition-api:3000` |

### Route mappings
Paths are versioned (`/api/v1`) and forwarded unchanged (`strip_path: false`). Each route accepts only its own HTTP method; any other path, version or method gets Kong's `404`.

| Kong route | Method and path | Plugins | Auth |
|---|---|---|---|
| `health` | `GET /api/v1/health` | default limit | — |
| `swagger-docs` | `GET /api/docs`, `/api/docs-json` | default limit | — |
| `auth-login` | `POST /api/v1/auth/login` | default limit | — |
| `mobile-query-tuition` | `GET /api/v1/mobile/tuition` | `rate-limiting`: 3 per day by `X-Student-No` | — |
| `banking-query-tuition` | `GET /api/v1/banking/tuition/{studentNo}` | `jwt`, default limit | JWT |
| `banking-pay-tuition` | `POST /api/v1/banking/payments` | `jwt`, default limit | JWT |
| `admin-add-tuition` | `POST /api/v1/admin/tuition` | `jwt`, default limit | JWT |
| `admin-add-tuition-batch` | `POST /api/v1/admin/tuition/batch` | `jwt`, default limit | JWT |
| `admin-unpaid-tuition` | `GET /api/v1/admin/tuition/unpaid` | `jwt`, default limit | JWT |

"Default limit" is a service-level `rate-limiting` plugin: 120 requests per minute per client IP.

### Authentication at the gateway
- The `jwt` plugin checks the `Authorization: Bearer` token: HS256 signature and the `exp` claim. Tokens in query strings or cookies are not accepted.
- Kong picks the verification key by the token's `iss` claim (`tuition-auth`), which matches the credential of the single consumer `tuition-auth-issuer`.
- The secret is not in the repository. `kong.yml` contains a placeholder that [`gateway/render-config.sh`](gateway/render-config.sh) replaces with the `JWT_SECRET` environment variable when the container starts. (Kong OSS cannot read this field from a vault reference; this was tested.)
- Kong only proves that the token is genuine and not expired. The API checks the token again and enforces role and ownership (`403 FORBIDDEN_ROLE`, `403 FORBIDDEN_STUDENT`).

### Mobile rate limit
- `rate-limiting` with `day: 3`, `limit_by: header`, `header_name: X-Student-No`, `policy: local` (see §12.4 for the reasons).
- Each student number has its own counter, so one student reaching the limit does not affect others. Every call counts, including errors.
- Without the header, Kong counts by client IP and the API answers `400 MISSING_STUDENT_NO`.

### Sample error responses
Fourth mobile query of the day for the same student:
```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 3
RateLimit-Remaining: 0
RateLimit-Reset: 20635
Retry-After: 20635
X-RateLimit-Limit-Day: 3
X-RateLimit-Remaining-Day: 0

{ "message": "API rate limit exceeded", "request_id": "82429669e4737701b7d8f9268e8b7b53" }
```
Protected route without a token, and with an altered token:
```
HTTP/1.1 401 Unauthorized
{ "message": "Unauthorized" }

HTTP/1.1 401 Unauthorized
{ "message": "Invalid signature" }
```
All gateway and API error formats are listed in [docs/API.md](docs/API.md#error-format).

### Smoke test
[`gateway/smoke-test.sh`](gateway/smoke-test.sh) calls every kind of route through the gateway and checks the status codes: public routes, `401` from Kong, `403` from the API, the mobile limit (`200, 200, 200, 429`, while another student still gets `200`) and unrouted paths. It does not change data. Output of a full run: [docs/evidence/gateway-smoke-test.txt](docs/evidence/gateway-smoke-test.txt).
```bash
./gateway/smoke-test.sh                       # default http://localhost:8000
./gateway/smoke-test.sh https://<cloud-gateway>
```

## 5. MCP server and indexing

A real MCP server built with the official `@modelcontextprotocol/sdk` ([`apps/mcp-server`](apps/mcp-server)). It gives the agent read-only access to the instructor's policy document, [`University_Tuition_Policies.md`](apps/mcp-server/data/University_Tuition_Policies.md). It does not go through the API gateway (as the assignment requires) and has no access to student data.

| | |
|---|---|
| Endpoint (local) | `POST http://localhost:3001/mcp` (Streamable HTTP transport) |
| Endpoint (cloud) | `POST https://tuition-mcp.bluesea-79ab2835.swedencentral.azurecontainerapps.io/mcp` |
| Authentication | `x-api-key` header, compared in constant time; otherwise `401` |
| Health | `GET /health` (public) → `{ "status": "ok", "document": "UNI-TUITION-2026-01", "chunks": 25 }` |
| Local stdio mode | `npm run start:stdio -w apps/mcp-server` (for MCP clients that start the server themselves) |

The HTTP server is **stateless**: each request gets a fresh MCP server and transport bound to the shared, read-only index, so any number of replicas can answer any request.

### Tool: `search_tuition_policies`
Input schema:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 500, "description": "What to look for, e.g. \"fall payment deadline\"" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 5, "description": "Maximum number of passages (default 3)" }
  },
  "required": ["query"]
}
```
Output (`structuredContent`, also returned as JSON text), following the format suggested in policy §9:
```json
{
  "document": "University_Tuition_Policies.md",
  "documentId": "UNI-TUITION-2026-01",
  "query": "late fee",
  "matches": [
    {
      "section": "4.1",
      "heading": "Late fee rule",
      "parentHeading": "Late fees",
      "text": "A 2% one-time late fee may be assessed on an overdue amount after the applicable due date, unless an approved exception applies. ...",
      "score": 85.17
    }
  ]
}
```
The tool is annotated as read-only. Invalid input (empty query, limit above 5) is returned as a tool error. If nothing matches, `matches` is empty, so the agent can say the policy does not cover the question instead of guessing.

### Chunking and indexing
1. **Chunking** ([`policy-chunks.ts`](apps/mcp-server/src/policy-chunks.ts)): the Markdown is split by headings into one chunk per `###` subsection (for example §3.2), or per `##` section when it has no subsections (§1, §9). Each chunk keeps its section number, heading, parent heading and plain text (Markdown emphasis removed). The title block is skipped and the document ID is read from it. The document gives **25 chunks**.
2. **Indexing** ([`policy-index.ts`](apps/mcp-server/src/policy-index.ts)): full-text **BM25** search with MiniSearch over the heading, parent heading and text. Headings are boosted (×3, parent ×1.5), common English stop words are ignored, and prefix and fuzzy matching (edit distance 20% of the term length) handle word forms and small typos such as "instalment".
3. **Build time, not per question** ([`build-index.ts`](apps/mcp-server/src/build-index.ts)): `npm run build` chunks the document and writes the serialized index to `dist/policy-index.json`; the Docker image builds it during `docker build`. The server only loads this file when it starts.

Why full-text search and not embeddings: the document is small and uses the same vocabulary as the questions (deadline, installment, refund, late fee). BM25 is free, needs no external model or API key, and gives deterministic results that unit tests can check. The agent writes the search query itself in English keywords, which also covers questions asked in Turkish.

### Retrieval tests and evidence
- [`policy-index.spec.ts`](apps/mcp-server/src/policy-index.spec.ts) checks five distinct topics, each must rank the correct section first: Spring deadline → §2.2, installment eligibility → §3.1, late fee → §4.1, early withdrawal refund → §6.1, duplicate payment → §7.4. It also checks score order, the limit, typo tolerance, empty results and that the index gives identical results after the build-time JSON round trip.
- [`policy-chunks.spec.ts`](apps/mcp-server/src/policy-chunks.spec.ts) checks the 25 chunks and their section numbers, headings and parents.
- [`http-app.spec.ts`](apps/mcp-server/src/http-app.spec.ts) runs the server on localhost and uses the official MCP client: `tools/list`, `tools/call`, invalid arguments, wrong or missing API key (`401`), health and `405` for `GET /mcp`.
- Three queries against the running container with the MCP client (`npm run demo -w apps/mcp-server`): [docs/evidence/mcp-queries.txt](docs/evidence/mcp-queries.txt).

| Query | Top sections returned |
|---|---|
| `fall tuition payment deadline` | §8.1 (FAQ: Fall deadline), §2.1 Fall term |
| `installment eligibility and number of installments` | §3.2 Number and size of installments, §3.1 Eligibility |
| `refund after withdrawal from the term` | §6.1 Early withdrawal, §6.2 Later withdrawal |

## 6. AI Agent

A command-line chat agent ([`apps/agent`](apps/agent)) that uses **Google Gemini with real function calling**. Gemini decides which tools to use; the agent runs every tool itself and sends the results back to Gemini, which writes the final answer. There is no keyword routing, and the LLM never calls a backend.

```
Student ──► CLI ──► Agent loop ──► Gemini (function calling)
                      │   ▲            │ "call get_my_tuition {term}"
                      │   └────────────┘ results sent back as function responses
                      ├─► search_tuition_policies ──► MCP client ──HTTP──► MCP server
                      ├─► get_my_tuition ───────────► Kong ──► Tuition API (JWT of the student)
                      └─► pay_my_tuition ──► confirmation gate (code) ──► Kong ──► Tuition API
```

### Run
```bash
npm run build -w apps/agent
npm run start -w apps/agent        # CLI: asks for student number and password
npm run start:web -w apps/agent    # web chat on http://localhost:8080
```
Configuration (from `.env`): `GATEWAY_URL`, `MCP_URL`, `MCP_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.8-flash`), `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`, used when the main model is busy: `429`/`503` are retried once on the same model, a `504` or a second failure moves to the fallback at once, requests have a 25 s deadline, and a busy model is skipped for 5 minutes) and optionally `AGENT_TRACE_FILE` (default `logs/agent-trace.jsonl`). For scripted demos the login can be given as `AGENT_USERNAME` / `AGENT_PASSWORD`.

### Web chat
The same agent also runs behind a small web page ([`chat-server.ts`](apps/agent/src/chat-server.ts), [`public/index.html`](apps/agent/public/index.html)), served by its own container (`docker compose` service `chat` at `http://localhost:8080`, Azure Container App `tuition-chat`).
- The browser only talks to this server. The JWT, the Gemini key and the MCP key stay on the server; the page gets an HttpOnly, SameSite=Strict session cookie.
- Each login gets its own `TuitionAgent` (own history and pending payment), kept in memory for 30 minutes of inactivity; the app therefore runs as one replica. Limits protect the free Gemini quota: 40 messages per session, 100 open sessions, 1,000 characters per message.
- Every answer shows a collapsible tool trace (tool, input, result, confirmation decision); the full trace also goes to the container log as one JSON line per turn.
- A payment summary comes with **Confirm payment** and **Cancel** buttons. They only send "yes" or "cancel" as the next message, so the confirmation gate in the agent decides, exactly as in the CLI.
- Endpoints: `POST /api/login`, `GET /api/session`, `POST /api/chat`, `POST /api/logout`, `GET /health`. Tested in [`chat-server.spec.ts`](apps/agent/src/chat-server.spec.ts) with a fake API and fake agents.

### Tools given to Gemini
| Tool | Parameters | Executed by the agent as |
|---|---|---|
| `search_tuition_policies` | `query` (English keywords), `limit?` | MCP `tools/call` on the MCP server (§5) |
| `get_my_tuition` | `term?` | `GET /api/v1/banking/tuition/{studentNo}` through Kong |
| `pay_my_tuition` | `term`, `amount` | Nothing at first: starts the confirmation gate (below) |

### Identity: the agent cannot reach another student's data
- The student logs in when the chat starts (`POST /api/v1/auth/login` through Kong). The agent keeps the JWT in memory; only `STUDENT` accounts are accepted.
- **No tool has a student-number parameter.** The number always comes from the login, and every REST call carries the student's own token. If a prompt says "show student 20230002", or the model invents a `studentNo` argument, the agent still queries only the logged-in student. The API would also reject another number with `403 FORBIDDEN_STUDENT`.

### Payment confirmation is enforced in code
1. When Gemini calls `pay_my_tuition`, the agent validates the term and the amount (positive, at most 2 decimals) and reads the live balance. An amount above the balance is rejected at once.
2. The agent does **not** call the payment API. It shows a fixed summary (policy §7.3) and ends the turn:
   ```
   Please confirm this payment / Lütfen bu ödemeyi onaylayın:
     Student:         20230001 (logged-in user)
     Term:            2026-FALL
     Amount:          500.00 USD
     Current balance: 1,500.00 USD (after payment: 1,000.00 USD)
   Reply "yes" or "confirm" ("evet" / "onaylıyorum") to submit it. Any other reply cancels it.
   ```
3. The user's **next** message decides, in code and before Gemini sees it: only an exact confirmation (`yes`, `confirm`, `I confirm`, `evet`, `onaylıyorum`, …) submits the payment, with a new UUID as `transactionId` (the idempotency key, policy §7.4). Any other reply, such as "Can I pay $500?", cancels it.
4. Gemini receives the real API result and the system prompt tells it to report success only if the result says `SUCCESS`.

### System prompt
[`system-prompt.ts`](apps/agent/src/system-prompt.ts): answer in the user's language; use the policy tool for every rule question and write its query in English keywords (the index is English); use the balance tool for anything about the student's account and never invent amounts; cite policy sections such as "(§3.2)"; never confirm an installment plan or a scholarship and never add late fees; send refund decisions to the finance office.

### Tool trace
Every turn prints a compact trace and appends the full trace as one JSON line to `logs/agent-trace.jsonl`: the user message, each tool with its input, result, success flag and duration, the confirmation-gate decision and the final answer.
```
  ┌─ tool trace
  │ ✔ get_my_tuition {} (31 ms)
  │   → {"result":{"studentNo":"20230001","scope":"OVERALL",…,"balance":4500,…}}
  │ ✔ search_tuition_policies {"query":"installment eligibility"} (18 ms)
  │   → {"result":{"document":"University_Tuition_Policies.md",…,"matches":[{"section":"3.1",…}]}}
  └─ trace saved to logs/agent-trace.jsonl
```

### Tests (no LLM, no network)
[`agent.spec.ts`](apps/agent/src/agent.spec.ts) replaces Gemini with a scripted fake LLM and fakes the REST and MCP clients:
- MCP-only, REST-only and MCP + REST turns (two tools in one model response), and a direct answer without tools;
- the logged-in student is used even when the prompt or the model names another student; API errors such as `403` are passed back to the model;
- the confirmation gate: a payment request only shows the summary; `yes` sends exactly one payment with a new `transactionId`; `evet` works; any other reply cancels; a later `yes` does not revive a cancelled payment; amounts above the balance and invalid arguments never reach the confirmation; a failed payment (`409`) is reported;
- the tool-call loop stops after the configured number of rounds, and a turn that fails (LLM unavailable) is dropped so the conversation stays valid;
- which replies count as a confirmation.

[`llm.spec.ts`](apps/agent/src/llm.spec.ts) checks the Gemini client with the SDK call mocked: automatic function calling off, retry of temporary errors, switch to the fallback model and skipping a busy model, no retry of permanent errors.

[`tuition-api.spec.ts`](apps/agent/src/tuition-api.spec.ts) checks the REST client with a mocked `fetch`: gateway URLs, bearer token, own student number, non-student login refused, API and Kong error mapping.

Live runs with Gemini for the three required scenarios (MCP only, REST only, MCP + REST) and a confirmed payment are in section 11.

## 7. Data model

PostgreSQL 16, managed with Prisma ([schema](apps/tuition-api/prisma/schema.prisma), [migrations](apps/tuition-api/prisma/migrations/)). Table details and design notes are in [docs/ER.md](docs/ER.md).

```mermaid
erDiagram
    STUDENTS ||--o| USERS : "logs in as"
    STUDENTS ||--o{ TUITIONS : "is billed"
    TUITIONS ||--o{ PAYMENTS : "is paid by"
    USERS |o--o{ PAYMENTS : "submits"

    STUDENTS {
        uuid id PK
        varchar student_no UK "8 digits, e.g. 20230001"
        varchar full_name
        timestamptz created_at
    }

    USERS {
        uuid id PK
        varchar username UK "student number for students"
        varchar password_hash "scrypt"
        enum role "STUDENT, BANK or ADMIN"
        uuid student_id FK, UK "set only for STUDENT"
        timestamptz created_at
    }

    TUITIONS {
        uuid id PK
        uuid student_id FK "unique together with term"
        varchar term "YYYY-FALL, YYYY-SPRING, YYYY-SUMMER"
        numeric amount "NUMERIC(12,2), 0 < amount <= 1,000,000"
        char currency "always USD"
        timestamptz created_at
        timestamptz updated_at
    }

    PAYMENTS {
        uuid id PK
        varchar transaction_id UK "idempotency key, 8-64 chars"
        uuid tuition_id FK
        numeric amount "NUMERIC(12,2), > 0"
        uuid paid_by_user_id FK "STUDENT or BANK user, nullable"
        timestamptz paid_at
    }
```

- **Balance is computed, not stored:** `balance = tuitions.amount − SUM(payments.amount)`.
- Money is `NUMERIC(12,2)`; currency is always `USD`.
- `tuitions` is unique on (`student_id`, `term`), the key of the Add Tuition upsert. `payments.transaction_id` is unique, the idempotency key of Pay Tuition.
- CHECK constraints repeat the API validation at database level: student number format, term format, `0 < amount ≤ 1,000,000`, currency `USD`, payment amount `> 0`, transaction ID format, and "a `STUDENT` user is linked to exactly one student".

### Seed data
The seed ([`src/seed/seed-data.ts`](apps/tuition-api/src/seed/seed-data.ts)) is fictitious and can be run any number of times without creating duplicates.

| Student | Records | Used for |
|---|---|---|
| `20230001` Elif Demir | 2026-FALL $3,000 (paid $1,500), 2027-SPRING $3,000 (unpaid) | Main agent demo student, overall query with per-term breakdown |
| `20230002` Can Öztürk | 2026-FALL $2,500 (fully paid by the bank), 2027-SPRING $2,500 (unpaid) | Second student for the cross-student access demo |
| `20230003` Deniz Kaya | 2026-FALL $3,000 (unpaid) | Unpaid list |
| `20230004` Zeynep Arslan | 2026-FALL $2,800 (fully paid in two payments) | Not in the unpaid list |
| `20230005` Mert Çelik | 2026-FALL $3,000 (paid $2,750, balance $250) | Balance below the $300 installment threshold (policy §3.1) |
| `20230006`–`20230024` | 2026-FALL $2,500–$3,500, some partly paid | Paging: 22 unpaid students in 2026-FALL, so the default page size of 20 gives two pages |
| `20230025` Efe Turan | none | `TUITION_NOT_FOUND` cases |

## 8. Running locally

### Full stack with Docker Compose (PostgreSQL, Tuition API, Kong, MCP server)
```bash
cp .env.example .env              # set JWT_SECRET and MCP_API_KEY to long random values
docker compose up -d --build
./gateway/smoke-test.sh
```
The API container applies the database migrations when it starts and loads the demo data on its first start (`SEED_ON_START=true`, only while the database is empty). To reload it later: `docker compose exec tuition-api node dist/seed/seed.js`. The gateway listens on `http://localhost:8000`, Swagger UI is at `http://localhost:8000/api/docs`, and the MCP server on `http://localhost:3001/mcp`.

### API without Docker (development)
```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://tuition:tuition@localhost:5432/tuition?schema=public
export JWT_SECRET=local-dev-secret
npm run prisma:migrate -w apps/tuition-api
npm run prisma:seed -w apps/tuition-api
npm run build -w apps/tuition-api && node apps/tuition-api/dist/main.js
```
`prisma:migrate` applies the migrations (`prisma migrate deploy`); `prisma:seed` loads the demo data. This runs the API on port 3000 without the gateway, which is only meant for development.

### Demo accounts
Fictitious accounts created by the seed, for local and demo use only.

| Username | Password | Role |
|---|---|---|
| `admin` | `Admin#2026` | `ADMIN` |
| `bank` | `Bank#2026` | `BANK` |
| `20230001` … `20230025` (student number) | `Student#2026` | `STUDENT` |

## 9. Cloud deployment

Microsoft Azure, deployed with the Azure CLI scripts in [`infra/`](infra). The CLI agent runs on the user's machine and connects to the cloud gateway and MCP server.

```
                         Azure Container Apps environment
Agent (local) ──HTTPS──► Kong gateway (external, 1 replica) ──HTTPS──► Tuition API (internal ingress) ──TLS──► PostgreSQL Flexible Server
       │                                                                                                  (Burstable B1ms, PG 16)
       └──HTTPS + x-api-key──► MCP server (external)
```

| Component | Azure resource | Settings |
|---|---|---|
| Tuition API | Container App `tuition-api` | **Internal ingress only**: reachable from Kong, not from the internet. 0.5 vCPU / 1 GiB, scales 0–2. Applies migrations (and the first seed) on start |
| API gateway | Container App `tuition-gateway` (Kong image from `gateway/Dockerfile`) | External HTTPS ingress, **exactly 1 replica** so the in-memory mobile rate-limit counters are exact (§12.4). 0.25 vCPU / 0.5 GiB |
| MCP server | Container App `tuition-mcp` | External HTTPS ingress, `x-api-key`; not behind the gateway. 0.25 vCPU / 0.5 GiB, scales 0–2 |
| Web chat | Container App `tuition-chat` | External HTTPS ingress; runs the agent, calls Kong and the MCP server like the CLI. Gemini key as a secret, read from the local `.env` by `deploy.sh` (skipped if missing). 0.25 vCPU / 0.5 GiB, scales 0–1 |
| Database | Azure Database for PostgreSQL Flexible Server | Burstable B1ms, PostgreSQL 16, 32 GB, TLS required, reachable from Azure services only |
| Demo data | Tuition API start command | Applies the migrations, then loads the demo data when `SEED_ON_START=true` and the database is still empty, so restarts never overwrite data. (Container Apps jobs are not available in the Express environment that Azure for Students creates.) |
| Images | Azure Container Registry (Basic) | Built for linux/amd64 with the local Docker (`docker buildx`) and pushed to the registry. Azure for Students blocks ACR Tasks, so `az acr build` is only used with `IMAGE_BUILD=acr` |

Secrets (`JWT_SECRET`, database URL, `MCP_API_KEY`) are generated on the first run, stored as Container Apps secrets and kept locally in `infra/.deploy-state.env`, which is not committed. Kong and the API receive the same `JWT_SECRET`.

### Deploy
Requirements: Azure CLI, a running Docker Desktop, an Azure subscription (Azure for Students works) and `openssl`. Azure for Students only allows a few regions (here: `swedencentral`, `francecentral`, `switzerlandnorth`, `polandcentral`, `norwayeast`).
```bash
az login
cp infra/config.env.example infra/config.env    # region and names; see the notes in the file
./infra/deploy.sh                               # about 15-20 minutes the first time
```
The script is idempotent: running it again keeps names and secrets, and rebuilds and redeploys only the images whose source files changed (each image is tagged with a hash of its sources). At the end it prints the URLs and writes `infra/cloud.env` (gateway URL, MCP URL and key) for the agent and the tests:
```bash
./gateway/smoke-test.sh https://<gateway-fqdn>
set -a; source infra/cloud.env; set +a
npm run demo -w apps/mcp-server     # three MCP queries against the cloud server
npm run start -w apps/agent         # the agent against the cloud services
```
Remove everything with `./infra/destroy.sh` (asks for the resource group name, then deletes it).

Azure for Students subscriptions may allow only some regions. If a step fails with a policy or region error, set another `LOCATION` in `infra/config.env` and run the script again.

### Deployed URLs
| | URL |
|---|---|
| Gateway (all REST operations) | https://tuition-gateway.bluesea-79ab2835.swedencentral.azurecontainerapps.io |
| Swagger UI | https://tuition-gateway.bluesea-79ab2835.swedencentral.azurecontainerapps.io/api/docs |
| MCP server | https://tuition-mcp.bluesea-79ab2835.swedencentral.azurecontainerapps.io/mcp (header `x-api-key`) |
| Web chat | https://tuition-chat.bluesea-79ab2835.swedencentral.azurecontainerapps.io |
| Tuition API | internal only (`tuition-api.internal.…`), reachable through the gateway |

Verified against the cloud: the gateway smoke test passes all 18 checks ([docs/evidence/gateway-smoke-test-cloud.txt](docs/evidence/gateway-smoke-test-cloud.txt)), the three MCP queries return the expected sections ([docs/evidence/mcp-queries-cloud.txt](docs/evidence/mcp-queries-cloud.txt)), and the web chat answers with live Gemini function calls through Kong and the MCP server. The API and MCP server scale to zero, so the first request after a pause can take 10–30 s.

The environment must use workload profiles: newer Azure CLI versions may create an "Express" environment, which has no traffic between apps and internal apps and no jobs. `deploy.sh` creates a workload-profiles environment and, if it finds an Express one, stops and explains how to recreate it (`RECREATE_ENV=true ./infra/deploy.sh`; database, registry and secrets are kept).


## 10. Testing

### Tuition API unit tests (no database, no network)
```bash
npm test                      # all workspaces
npm test -w apps/tuition-api  # API only
```
Prisma is replaced by a mock, so these tests need no database, Docker, cloud service or LLM.

| File | What it checks |
|---|---|
| [`app.http.spec.ts`](apps/tuition-api/src/app.http.spec.ts) | Every endpoint over HTTP (Supertest) with the real Nest configuration: success and failure for each operation, 401/403 guards, 400 validation (for example more than 2 decimals), the shared error body |
| [`payments.service.spec.ts`](apps/tuition-api/src/banking/payments.service.spec.ts) | Pay Tuition: partial/full payment, `409 DUPLICATE_TRANSACTION` (with and without the original payment), `422 AMOUNT_EXCEEDS_BALANCE`, `404 TUITION_NOT_FOUND` |
| [`tuition-query.service.spec.ts`](apps/tuition-api/src/tuition/tuition-query.service.spec.ts) | Query Tuition: overall and per-term balance, term ordering, `STUDENT_NOT_FOUND`, `TUITION_NOT_FOUND` |
| [`tuition-admin.service.spec.ts`](apps/tuition-api/src/admin/tuition-admin.service.spec.ts) | Add Tuition: `CREATED`, `UPDATED`, `UNCHANGED`, `AMOUNT_BELOW_PAID`, `STUDENT_NOT_FOUND`, retry after a concurrent create |
| [`tuition-batch.service.spec.ts`](apps/tuition-api/src/admin/tuition-batch.service.spec.ts) | Batch CSV: header check, row-level errors, `DUPLICATE_IN_FILE`, counts and line numbers |
| [`unpaid-tuition.service.spec.ts`](apps/tuition-api/src/admin/unpaid-tuition.service.spec.ts) | Unpaid list: paging, `PAGE_OUT_OF_RANGE`, empty result with `totalPages: 0` |
| [`auth.service.spec.ts`](apps/tuition-api/src/auth/auth.service.spec.ts), [`password.spec.ts`](apps/tuition-api/src/auth/password.spec.ts) | Login, token claims, `INVALID_CREDENTIALS`, scrypt hashing |

Result: 9 suites, 100 tests, all passing.

### MCP server and agent tests (no network, no LLM)
```bash
npm test -w apps/mcp-server   # 3 suites, 23 tests: chunking, retrieval of five topics, MCP over HTTP (see §5)
npm test -w apps/agent        # 4 suites, 61 tests: fake-LLM agent scenarios, confirmation gate, Gemini client, web chat server (see §6)
```
`npm test` at the repository root runs all three workspaces (184 tests).

### Tuition API integration tests (PostgreSQL in Docker)
Some behaviour can only be proved against a real database: the row lock that prevents overpayment, the unique `transactionId` under concurrency, and the SQL sorting and paging of the unpaid list.
```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://tuition:tuition@localhost:5432/tuition?schema=public
npm run prisma:migrate -w apps/tuition-api
npm run prisma:seed -w apps/tuition-api
npm run test:int -w apps/tuition-api
```
The tests create their own students (`2099xxxx`) and remove them afterwards; the seeded data is not changed. They log in as the seeded `bank` and `admin` users.

Covered: two or more concurrent payments that together exceed the balance (only the ones that fit succeed, the balance never goes negative), the same `transactionId` sent twice at once (one `201`, one `409`, one row), sorting in both columns and directions with the `studentNo` tie-break, page boundaries and `PAGE_OUT_OF_RANGE`, the Add Tuition upsert statuses including two concurrent creates, and a CSV import. Result: 1 suite, 14 tests, all passing.

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

### 12.12 Errors, validation and edge cases
These details were fixed while implementing the API; [docs/API.md](docs/API.md) lists them per endpoint.
- Common error codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN_ROLE` (403), `NOT_FOUND` (404 unknown route), `INTERNAL_ERROR` (500, no internal details). Unknown fields in a body or query are rejected with `VALIDATION_ERROR`.
- Protected routes check in this order: token and role, then input validation, then ownership (`FORBIDDEN_STUDENT`), then the database.
- Payment amounts follow the same limits as tuition amounts: greater than 0, at most 1,000,000, at most 2 decimals.
- A `409 DUPLICATE_TRANSACTION` response contains the original payment only when it belongs to the same student, so another student's payment is never revealed. A retried request always gets `409`, even if the amount would now exceed the balance.
- An overall query for a student without any tuition records returns `200` with zero totals and an empty `terms` list.
- Two concurrent Add Tuition requests for the same new student and term: one creates the record, the other is retried once and reports `UNCHANGED` (or `UPDATED`), instead of failing.
- Batch CSV: an empty file is `INVALID_CSV_HEADER`; a file that is not valid CSV is `VALIDATION_ERROR`; more than 1,000 data rows is `FILE_TOO_LARGE`. `DUPLICATE_IN_FILE` applies to repeats of the first valid occurrence.
- For `BANK` and `ADMIN` logins `studentNo` is `null`. `JWT_SECRET` is required; the API does not start without it.

### 12.13 Deployment
- Cloud: Microsoft Azure. Tuition API, MCP server and Kong run on Azure Container Apps; the database is Azure Database for PostgreSQL Flexible Server (Burstable B1MS).
- The CLI agent runs on the user's machine and connects to the cloud gateway and MCP URLs.
- Secrets (JWT secret, database URL, Gemini API key, MCP API key) are supplied as environment variables and are never committed.

## 13. Cost

### Cloud (Azure, approximate, West Europe prices)
| Resource | Cost |
|---|---|
| PostgreSQL Flexible Server B1ms + 32 GB | Free for the first 12 months on a new Azure for Students / free account (750 hours per month) |
| Kong (0.25 vCPU / 0.5 GiB, always on) | About 10–15 USD per month after the monthly Container Apps free grant |
| Tuition API and MCP server (scale to zero) | Within the free grant for demo traffic |
| Container Registry Basic | About 5 USD per month |

Together about 15–20 USD per month, covered by the Azure for Students credit. The resources are meant to be deleted with `infra/destroy.sh` after grading. The API and MCP server scale to zero when idle, which is why the first request after a pause is slower.

### LLM
_TBD (Stage 8: measured token use of the demo scenarios)._
