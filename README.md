# AI Tuition Assistant — SE 4458 Midterm (Group 1)

A conversational assistant that answers student questions about tuition deadlines, installments, payment rules, balances and payments. An LLM chooses between a policy search tool (MCP) and live tuition operations (REST API behind an API Gateway), or uses both.

> Deployed on Azure (Sweden Central): gateway, MCP server and web chat URLs in [section 9](#9-cloud-deployment); evidence for every requirement in [section 11](#11-demonstration-evidence).

## Contents
1. [Architecture](#1-architecture)
2. [Repository layout](#2-repository-layout)
3. [API](#3-api)
4. [API Gateway](#4-api-gateway)
5. [MCP server and indexing](#5-mcp-server-and-indexing)
6. [AI Agent](#6-ai-agent)
7. [Data model](#7-data-model)
8. [Running locally](#8-running-locally)
9. [Cloud deployment](#9-cloud-deployment)
10. [Testing](#10-testing)
11. [Demonstration evidence](#11-demonstration-evidence)
12. [Assumptions and design decisions](#12-assumptions-and-design-decisions)
13. [Cost](#13-cost)

## 1. Architecture

```
User (CLI chat or web chat)
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

### How a question is answered (agent loop)
1. The agent sends the user's question, the conversation so far and the three tool declarations to Gemini.
2. Gemini answers either with text or with one or more **function calls** (tool name and arguments). It chooses the tools itself; there is no keyword routing.
3. The agent validates each call and executes it: `search_tuition_policies` through the MCP client, `get_my_tuition` and the payment through Kong with the student's JWT. A payment first goes through the confirmation gate (section 6).
4. The agent sends the tool results back to Gemini as function responses.
5. Steps 2 to 4 repeat (at most 5 rounds) until Gemini writes the final answer, grounded in the tool results and citing policy sections.
6. The agent records the turn in the tool trace: tools, inputs, results, confirmation decision and token use.

### Technology stack
| Part | Technologies |
|---|---|
| Language and runtime | TypeScript 5.9 (strict), Node.js 22, npm workspaces monorepo |
| Tuition REST API | NestJS 11, class-validator (input validation), `@nestjs/swagger` (OpenAPI and Swagger UI), Passport JWT (HS256 tokens) |
| Database | PostgreSQL 16 with Prisma 6 (schema, migrations, type-safe queries) |
| API Gateway | Kong Gateway OSS 3.9, DB-less declarative config, `jwt` and `rate-limiting` plugins |
| MCP server | Official MCP TypeScript SDK 1.32 (Streamable HTTP and stdio), MiniSearch 7 (BM25 full-text index), Express 5 |
| AI agent | Google Gen AI SDK 1.52 with Gemini function calling (`gemini-3.8-flash` and Flash-Lite fallbacks), MCP client from the same SDK |
| Web chat | Express 5 server and a plain HTML/JavaScript page (no framework) |
| Tests | Jest 29, Supertest; agent tests use a scripted fake LLM |
| Cloud and tooling | Azure Container Apps, Azure Database for PostgreSQL Flexible Server, Azure Container Registry, Azure CLI scripts (`infra/`), Docker and Docker Compose |

Why each technology was chosen is explained in section 12.1.

## 2. Repository layout

| Path | Contents |
|---|---|
| `apps/tuition-api` | NestJS REST API, Prisma schema and migrations, unit tests |
| `apps/mcp-server` | MCP server, policy indexer, `search_tuition_policies` tool |
| `apps/agent` | Chat agent (Gemini + MCP client + REST client), as a CLI and as a web chat server with a static page |
| `gateway/` | Kong declarative configuration, Kong image and the gateway smoke test |
| `infra/` | Azure deployment scripts |
| `docs/` | API contract, ER diagram, screenshots and tool traces |

## 3. API

The full contract, with request and response examples and every error code, is in [docs/API.md](docs/API.md). Swagger UI is served at `/api/docs` (cloud: https://tuition-gateway.bluesea-79ab2835.swedencentral.azurecontainerapps.io/api/docs).

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
| Upstream | Tuition API service, set by `UPSTREAM_URL` at container start: `http://tuition-api:3000` in Docker Compose, `https://tuition-api.internal.<environment domain>` in Azure |

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
- `rate-limiting` with `day: 3`, `limit_by: header`, `header_name: X-Student-No`, `policy: local` (see section 12.4 for the reasons).
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
Output (`structuredContent`, also returned as JSON text), following the format suggested in policy section 9:
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
1. **Chunking** ([`policy-chunks.ts`](apps/mcp-server/src/policy-chunks.ts)): the Markdown is split by headings into one chunk per `###` subsection (for example section 3.2), or per `##` section when it has no subsections (section 1, section 9). Each chunk keeps its section number, heading, parent heading and plain text (Markdown emphasis removed). The title block is skipped and the document ID is read from it. The document gives **25 chunks**.
2. **Indexing** ([`policy-index.ts`](apps/mcp-server/src/policy-index.ts)): full-text **BM25** search with MiniSearch over the heading, parent heading and text. Headings are boosted (×3, parent ×1.5), common English stop words are ignored, and prefix and fuzzy matching (edit distance 20% of the term length) handle word forms and small typos such as "instalment".
3. **Build time, not per question** ([`build-index.ts`](apps/mcp-server/src/build-index.ts)): `npm run build` chunks the document and writes the serialized index to `dist/policy-index.json`; the Docker image builds it during `docker build`. The server only loads this file when it starts.

Why full-text search and not embeddings: the document is small and uses the same vocabulary as the questions (deadline, installment, refund, late fee). BM25 is free, needs no external model or API key, and gives deterministic results that unit tests can check. The agent writes the search query itself in English keywords, which also covers questions asked in Turkish.

### Retrieval tests and evidence
- [`policy-index.spec.ts`](apps/mcp-server/src/policy-index.spec.ts) checks five distinct topics, each must rank the correct section first: Spring deadline → section 2.2, installment eligibility → section 3.1, late fee → section 4.1, early withdrawal refund → section 6.1, duplicate payment → section 7.4. It also checks score order, the limit, typo tolerance, empty results and that the index gives identical results after the build-time JSON round trip.
- [`policy-chunks.spec.ts`](apps/mcp-server/src/policy-chunks.spec.ts) checks the 25 chunks and their section numbers, headings and parents.
- [`http-app.spec.ts`](apps/mcp-server/src/http-app.spec.ts) runs the server on localhost and uses the official MCP client: `tools/list`, `tools/call`, invalid arguments, wrong or missing API key (`401`), health and `405` for `GET /mcp`.
- Three queries against the running container with the MCP client (`npm run demo -w apps/mcp-server`): [docs/evidence/mcp-queries.txt](docs/evidence/mcp-queries.txt).

| Query | Top sections returned |
|---|---|
| `fall tuition payment deadline` | section 8.1 (FAQ: Fall deadline), section 2.1 Fall term |
| `installment eligibility and number of installments` | section 3.2 Number and size of installments, section 3.1 Eligibility |
| `refund after withdrawal from the term` | section 6.1 Early withdrawal, section 6.2 Later withdrawal |

## 6. AI Agent

The chat agent ([`apps/agent`](apps/agent)), available as a command-line chat and as a web chat, uses **Google Gemini with real function calling**. Gemini decides which tools to use; the agent runs every tool itself and sends the results back to Gemini, which writes the final answer. There is no keyword routing, and the LLM never calls a backend.

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
Configuration (from `.env`): `GATEWAY_URL`, `MCP_URL`, `MCP_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.8-flash`), `GEMINI_FALLBACK_MODEL` (default `gemini-3.6-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.1-flash-lite`: tried in order when the main model is busy; a `503` (overloaded) or `504` (deadline) moves to the next model at once, a `429` is retried once on the same model, requests have a 35 s deadline, and a busy model is skipped for 5 minutes) and optionally `AGENT_TRACE_FILE` (default `logs/agent-trace.jsonl`). For scripted demos the login can be given as `AGENT_USERNAME` / `AGENT_PASSWORD`.

### Web chat
The same agent also runs behind a small web page ([`chat-server.ts`](apps/agent/src/chat-server.ts), [`public/index.html`](apps/agent/public/index.html)), served by its own container (`docker compose` service `chat` at `http://localhost:8080`, Azure Container App `tuition-chat`).
- The browser only talks to this server. The JWT, the Gemini key and the MCP key stay on the server; the page gets an HttpOnly, SameSite=Strict session cookie.
- Each login gets its own `TuitionAgent` (own history and pending payment), kept in memory for 30 minutes of inactivity; the app therefore runs as one replica. Limits protect the free Gemini quota: 40 messages per session, 100 open sessions, 1,000 characters per message.
- Every answer shows a collapsible tool trace (tool, input, result, confirmation decision); the full trace also goes to the container log as one JSON line per turn.
- After login the page greets the student and offers the assignment's example questions as buttons (`When is the payment deadline?`, `What is my balance?`, `Can I pay my outstanding balance in installments?`, `Pay part of my balance: …`). After each answer it suggests follow-up questions that fit the tools just used (for example the balance after a policy answer). The suggestions are only part of the page: Gemini still chooses the tools for every question.
- `ADMIN` and `BANK` accounts are greeted by role ("Welcome, admin!") and pointed to Swagger UI; the chat itself stays student-only, because every agent tool acts on the logged-in student's own record.
- A payment summary comes with **Confirm payment** and **Cancel** buttons. They only send "yes" or "cancel" as the next message, so the confirmation gate in the agent decides, exactly as in the CLI.
- Endpoints: `POST /api/login`, `GET /api/session`, `POST /api/chat`, `POST /api/logout`, `GET /health`. Tested in [`chat-server.spec.ts`](apps/agent/src/chat-server.spec.ts) with a fake API and fake agents.

### Tools given to Gemini
| Tool | Parameters | Executed by the agent as |
|---|---|---|
| `search_tuition_policies` | `query` (English keywords), `limit?` | MCP `tools/call` on the MCP server (section 5) |
| `get_my_tuition` | `term?` | `GET /api/v1/banking/tuition/{studentNo}` through Kong |
| `pay_my_tuition` | `term`, `amount` | Nothing at first: starts the confirmation gate (below) |

### Identity: the agent cannot reach another student's data
- The student logs in when the chat starts (`POST /api/v1/auth/login` through Kong). The agent keeps the JWT in memory; only `STUDENT` accounts are accepted.
- **No tool has a student-number parameter.** The number always comes from the login, and every REST call carries the student's own token. If a prompt says "show student 20230002", or the model invents a `studentNo` argument, the agent still queries only the logged-in student. The API would also reject another number with `403 FORBIDDEN_STUDENT`.

### Payment confirmation is enforced in code
1. When Gemini calls `pay_my_tuition`, the agent validates the term and the amount (positive, at most 2 decimals) and reads the live balance. An amount above the balance is rejected at once.
2. The agent does **not** call the payment API. It shows a fixed summary (policy section 7.3) and ends the turn:
   ```
   Please confirm this payment / Lütfen bu ödemeyi onaylayın:
     Student:         20230001 (logged-in user)
     Term:            2026-FALL
     Amount:          500.00 USD
     Current balance: 1,500.00 USD (after payment: 1,000.00 USD)
   Reply "yes" or "confirm" ("evet" / "onaylıyorum") to submit it. Any other reply cancels it.
   ```
3. The user's **next** message decides, in code and before Gemini sees it: only an exact confirmation (`yes`, `confirm`, `I confirm`, `evet`, `onaylıyorum`, …) submits the payment, with a new UUID as `transactionId` (the idempotency key, policy section 7.4). Any other reply, such as "Can I pay $500?", cancels it.
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
| `20230005` Mert Çelik | 2026-FALL $3,000 (paid $2,750, balance $250) | Balance below the $300 installment threshold (policy section 3.1) |
| `20230006`–`20230024` | 2026-FALL $2,500–$3,500, some partly paid | Paging: 22 unpaid students in 2026-FALL, so the default page size of 20 gives two pages |
| `20230025` Efe Turan | none | `TUITION_NOT_FOUND` cases |

## 8. Running locally

### Full stack with Docker Compose (PostgreSQL, Tuition API, Kong, MCP server, web chat)
```bash
cp .env.example .env              # set JWT_SECRET and MCP_API_KEY to long random values, GEMINI_API_KEY for the chat
docker compose up -d --build
./gateway/smoke-test.sh
```
The API container applies the database migrations when it starts and loads the demo data on its first start (`SEED_ON_START=true`, only while the database is empty). To reload it later: `docker compose exec tuition-api node dist/seed/seed.js`. The gateway listens on `http://localhost:8000`, Swagger UI is at `http://localhost:8000/api/docs`, the MCP server on `http://localhost:3001/mcp` and the web chat on `http://localhost:8080`. The chat needs a Gemini API key from Google AI Studio (free tier); everything else runs without it.

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

Microsoft Azure, deployed with the Azure CLI scripts in [`infra/`](infra). The web chat runs in Azure; the CLI agent runs on the user's machine and connects to the same cloud gateway and MCP server.

```
                         Azure Container Apps environment
Agent (local) ──HTTPS──► Kong gateway (external, 1 replica) ──HTTPS──► Tuition API (internal ingress) ──TLS──► PostgreSQL Flexible Server
       │                                                                                                  (Burstable B1ms, PG 16)
       └──HTTPS + x-api-key──► MCP server (external)
```

| Component | Azure resource | Settings |
|---|---|---|
| Tuition API | Container App `tuition-api` | **Internal ingress only**: reachable from Kong, not from the internet. 0.5 vCPU / 1 GiB, scales 0–2. Applies migrations (and the first seed) on start |
| API gateway | Container App `tuition-gateway` (Kong image from `gateway/Dockerfile`) | External HTTPS ingress, **exactly 1 replica** so the in-memory mobile rate-limit counters are exact (section 12.4). 0.25 vCPU / 0.5 GiB |
| MCP server | Container App `tuition-mcp` | External HTTPS ingress, `x-api-key`; not behind the gateway. 0.25 vCPU / 0.5 GiB, scales 0–2 |
| Web chat | Container App `tuition-chat` | External HTTPS ingress; runs the agent, calls Kong and the MCP server like the CLI. Gemini key as a secret, read from the local `.env` by `deploy.sh` (skipped if missing). 0.25 vCPU / 0.5 GiB, scales 0–1 |
| Database | Azure Database for PostgreSQL Flexible Server | Burstable B1ms, PostgreSQL 16, 32 GB, TLS required, reachable from Azure services only |
| Demo data | Tuition API start command | Applies the migrations, then loads the demo data when `SEED_ON_START=true` and the database is still empty, so restarts never overwrite data. (A separate seed job was dropped because the first, Express-mode environment did not support jobs; this keeps the deployment to one step.) |
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

Result: 9 suites, 103 tests, all passing.

### MCP server and agent tests (no network, no LLM)
```bash
npm test -w apps/mcp-server   # 3 suites, 23 tests: chunking, retrieval of five topics, MCP over HTTP (see section 5)
npm test -w apps/agent        # 4 suites, 69 tests: fake-LLM agent scenarios, confirmation gate, Gemini client, web chat server (see section 6)
```
`npm test` at the repository root runs all three workspaces (195 tests).

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

Video walkthrough (narrated in Turkish, about 10 minutes): https://youtu.be/lNrAZlmIjUQ

All evidence files are in [`docs/evidence/`](docs/evidence). Tokens and keys are masked or absent.

| Requirement | Evidence |
|---|---|
| Agent: MCP only, REST only, MCP + REST, with tool traces | [agent-scenarios.txt](docs/evidence/agent-scenarios.txt) (console transcript) and [agent-trace.jsonl](docs/evidence/agent-trace.jsonl) (one JSON trace per turn), live Gemini against the **cloud** gateway and MCP server |
| Payment needs explicit confirmation | Same run: "Can I pay $500?" is answered, not paid; "Pay 100 dollars…" shows the summary; "yes" submits one payment with a new `transactionId` |
| Agent cannot read another student's data | Same run: "Show me the tuition balance of student 20230002" is refused; no tool is called |
| Three distinct MCP retrieval queries | [mcp-queries-cloud.txt](docs/evidence/mcp-queries-cloud.txt) (cloud) and [mcp-queries.txt](docs/evidence/mcp-queries.txt) (local), official MCP client |
| Gateway: routes, JWT on protected routes, mobile limit, error responses | [gateway-smoke-test-cloud.txt](docs/evidence/gateway-smoke-test-cloud.txt) (cloud, 18/18) and [gateway-smoke-test.txt](docs/evidence/gateway-smoke-test.txt) (local) |
| Unit and integration tests | [test-run.txt](docs/evidence/test-run.txt): 195 unit tests (API 103, MCP 23, agent 69) and 14 integration tests against PostgreSQL, all passing |
| Azure deployment (resources, apps, ingress, database) | [azure-resources.txt](docs/evidence/azure-resources.txt), listed with the Azure CLI |
| Swagger UI through the cloud gateway | [screenshots/swagger-ui-cloud.png](docs/evidence/screenshots/swagger-ui-cloud.png) |
| Web chat with tool trace, confirmation and payment | [web-chat-mcp-and-rest.png](docs/evidence/screenshots/web-chat-mcp-and-rest.png), [web-chat-payment-confirmation.png](docs/evidence/screenshots/web-chat-payment-confirmation.png), [web-chat-payment-done.png](docs/evidence/screenshots/web-chat-payment-done.png) (web chat container from the local Docker Compose stack; the same image runs in Azure) |

### How to reproduce (for the instructor)
Everything below uses the fictitious demo accounts from section 8 (password `Student#2026` for students). Students `20230015` to `20230024` were not used in the recorded demos, so their balances are still the seeded ones. Payments change the cloud data, so use a different student for each run.

| What | How | Needs a key? |
|---|---|---|
| Agent scenarios (MCP only, REST only, both, confirmed payment) | Open the web chat https://tuition-chat.bluesea-79ab2835.swedencentral.azurecontainerapps.io, log in as a student and ask, for example: `When is the payment deadline?`, `What is my balance?`, `Can I pay my outstanding balance in installments?`, `Pay part of my balance: 500 dollars for Fall 2026.` then press **Confirm payment**. Open "Tool trace" under each answer to see the tools, inputs and results. | No |
| Gateway: protected route, error responses, mobile limit | From the repository root: `MOBILE_STUDENT=20230020 OTHER_STUDENT=20230021 ./gateway/smoke-test.sh https://tuition-gateway.bluesea-79ab2835.swedencentral.azurecontainerapps.io` (the mobile limit counts per student per UTC day, so pick other students to run it again the same day) | No |
| REST API by hand | Swagger UI https://tuition-gateway.bluesea-79ab2835.swedencentral.azurecontainerapps.io/api/docs: call `POST /api/v1/auth/login` (for example `bank` / `Bank#2026` or `admin` / `Admin#2026`), copy `accessToken`, press **Authorize**, then try the protected operations | No |
| MCP retrieval | `npm ci && npm test -w apps/mcp-server` runs the retrieval tests offline. For a live MCP server: `docker compose up -d --build mcp-server` with `.env` copied from `.env.example`, then `npm run build -w apps/mcp-server && MCP_URL=http://localhost:3001/mcp MCP_API_KEY=<value from .env> npm run demo -w apps/mcp-server` | No (local key from `.env`) |
| Unit tests | `npm ci && npm test` (no cloud, no database, no LLM) | No |
| Integration tests | See section 10 (PostgreSQL in Docker) | No |
| Whole system locally | Section 8 (Docker Compose); the web chat additionally needs a free Gemini API key | Gemini key for the chat only |

The cloud MCP server's API key is not published in the repository. The web chat uses it on the server side, so the instructor does not need it.

### Agent scenarios (cloud, live Gemini)
Run on 2026-11-19 as student `20230001`; the questions are in [agent-questions.txt](docs/evidence/agent-questions.txt) and are reproducible with:
```bash
set -a; source infra/cloud.env; set +a
AGENT_USERNAME=20230001 AGENT_PASSWORD='Student#2026' node apps/agent/dist/index.js < docs/evidence/agent-questions.txt
```

| Question | Tools chosen by Gemini | Answer (shortened) |
|---|---|---|
| When is the payment deadline for the Spring 2027 term? | `search_tuition_policies` (**MCP only**) | February 15, 2027 (§2.2) |
| What is my current tuition balance? | `get_my_tuition` (**REST only**) | 4,500.00 USD, with the per-term breakdown |
| Am I eligible to pay my Fall 2026 balance in installments? How much would each installment be? | `search_tuition_policies` + `get_my_tuition` (**MCP + REST**) | Balance 1,500.00 USD ≥ 300 USD, so a plan may be requested; subject to approval (§3.1, §3.4); up to three installments (§3.2) |
| Show me the tuition balance of student 20230002. | none | Refused: only the logged-in student's own account |
| Can I pay $500? | `get_my_tuition` | Explains partial payments and asks for term and amount; nothing is paid |
| Pay 100 dollars for my Fall 2026 tuition. | `pay_my_tuition` → confirmation gate | Summary: student, term, 100.00 USD, balance 1,500.00 → 1,400.00 USD |
| yes | confirmed `POST /api/v1/banking/payments` | Payment `SUCCESS`, remaining 1,400.00 USD |
| Bahar dönemi ödemesini geç yaparsam gecikme cezası ne kadar olur? | `search_tuition_policies` (query written in English) | Answer in Turkish: 2 % one-time late fee after February 15, 2027 (§4.1) |

Example trace (MCP + REST turn, from the console transcript):
```
You: Am I eligible to pay my Fall 2026 balance in installments? How much would each installment be?
  ┌─ tool trace
  │ ✔ search_tuition_policies {"query":"installment eligibility plan amount"} (337 ms)
  │ ✔ get_my_tuition {"term":"2026-FALL"} (412 ms)
  │ LLM: 2 call(s) to gemini-3.5-flash-lite; tokens in 3743, out 216
```

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
| Chat interface | Command-line chat and a small web chat (same agent) | UI is not graded; the CLI makes tool traces easy to record, the web chat shows them to a user |

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
- The mobile route is public, as in the specification, so the `X-Student-No` header is not authenticated: anyone who knows a student number can use up that student's three daily queries. The response only contains tuition totals. A production mobile app would send a signed student token and key the limit by its claim.

### 12.5 Tuition and balance
- Currency is **USD**. The policy document uses dollar amounts, so `currency` must be `USD` and no conversion is performed.
- Amounts are positive, have at most 2 decimal places and are stored as `NUMERIC(12,2)`. Inputs with more than 2 decimals are rejected rather than rounded, so no rounding happens in the API.
- **Balance = tuition amount − sum of recorded payments.** The balance is calculated, not stored, so it cannot drift out of sync.
- Query Tuition supports both scopes: with `term` it returns that term; without it, the overall total with a per-term breakdown.
- Tuition amounts are recorded **after** any scholarship or adjustment. Scholarships are not modelled separately. Following policy section 5.2, the assistant explains the 25% rule but never claims that a particular student has a scholarship.
- Late fees are **not** calculated or posted (policy section 4.1). The assistant may explain the 2% rule but does not add fees to balances.
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
- Partial and full payments are allowed. The amount must be positive and must not exceed the remaining balance (policy section 7.2). Overpayment is not supported.
- `transactionId` is the idempotency key (policy section 7.4). A repeated `transactionId` is rejected with `409` and no second record is created; the original payment is returned only to the student it belongs to (see section 12.12).
- The tuition row is locked during a payment, so concurrent payments cannot overpay.
- A partial payment is **not** an installment approval (policy section 3.4). The API has no installment-approval operation, and the assistant does not promise approval.

### 12.8 Unpaid Tuition Status
- Lists students with **balance > 0** for the given term, so partially paid students are included.
- `term` is required. `page` starts at 1. `pageSize` defaults to 20, maximum 100.
- Sorting is selectable: `sortBy=balance|studentNo`, `sortOrder=asc|desc`. Default: `balance desc`. Ties are broken by `studentNo asc` so pages stay stable.
- If no student has an unpaid balance, page 1 returns an empty list (`totalPages: 0`).
- Requesting a page beyond the last page returns `400 PAGE_OUT_OF_RANGE`. If all results fit on one page, there is no page 2.

### 12.9 AI Agent behaviour
- Tool selection is done by the LLM through real function calling. There is no keyword routing.
- Agent tools: `search_tuition_policies(query)` (MCP), `get_my_tuition(term?)` (REST via gateway) and `pay_my_tuition(term, amount)` (REST via gateway).
- **Payment confirmation is enforced in code, not only in the prompt.** When the LLM requests a payment, the agent does not call the API. It shows the student, term, amount and current balance (policy section 7.3) and waits. The payment is submitted only if the user's next message is an explicit confirmation (`yes` / `confirm`). Anything else cancels it. A question such as "Can I pay $500?" is never treated as authorization.
- The agent generates the `transactionId` (UUID) when the user confirms and reports success only after the API returns success (policy section 7.4).
- Answers that use the policy cite section numbers (for example "§3.2").
- The assistant answers in the user's language; code and documentation are in English.
- Every turn writes a tool trace (tool name, input, result, final answer) to the console and to a JSON log file.

### 12.10 Policy interpretation
- Deadlines are in the university's local time zone (policy section 2.2); this project uses `Europe/Istanbul`.
- Installment eligibility (balance of at least $300, up to three installments, policy section 3) is explained by the assistant using the live balance plus the policy text. The assistant states that an arrangement is **subject to approval** and never confirms approval.
- Refund questions are answered from policy section 6, and the user is directed to the finance office for decisions.

### 12.11 MCP server
- The document is split by Markdown headings into one chunk per `###` subsection (or per `##` section when it has no subsections). Each chunk keeps its section ID, heading and parent heading.
- The index is built once at build time and loaded at startup. It is not rebuilt per question.
- `search_tuition_policies(query)` returns the top matches with `document`, `documentId`, `section`, `heading` and `text`, following the format suggested in policy section 9.
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
- The web chat runs as a fourth container app; the CLI agent runs on the user's machine. Both connect to the cloud gateway and MCP URLs.
- Secrets (JWT secret, database URL, Gemini API key, MCP API key) are supplied as environment variables and are never committed.

## 13. Cost

### Cloud (Azure, approximate)
| Resource | Cost |
|---|---|
| PostgreSQL Flexible Server B1ms + 32 GB | Free for the first 12 months on a new Azure for Students / free account (750 hours per month) |
| Kong (0.25 vCPU / 0.5 GiB, always on) | About 10–15 USD per month after the monthly Container Apps free grant |
| Tuition API, MCP server and web chat (scale to zero) | Within the free grant for demo traffic |
| Container Registry Basic | About 5 USD per month |

Together about 15–20 USD per month, covered by the Azure for Students credit. The resources are meant to be deleted with `infra/destroy.sh` after grading. The API and MCP server scale to zero when idle, which is why the first request after a pause is slower.

### LLM
The agent uses Google Gemini on the **free tier** of Google AI Studio, so the demonstration cost nothing. Token use is measured, not estimated: Gemini reports it with every response and the agent records it in the trace (`llm` field; see [agent-trace.jsonl](docs/evidence/agent-trace.jsonl)).

Measured in the cloud scenario run above (8 turns, 13 model calls, all answered by the fallback model `gemini-3.5-flash-lite` because the main model was busy):

| | Tokens |
|---|---|
| Input, all turns | 27,984 |
| Output, all turns | 744 |
| Per turn, average | about 3,500 input, 93 output |

Input dominates because every call sends the system prompt, the three tool declarations and the conversation so far; a turn with a tool call makes two model calls. Cost per turn on a paid tier is therefore about `3,500 × input price + 93 × output price` (see Google's Gemini pricing page for current prices); for a Flash-Lite model this is a small fraction of a cent.

How the cost is kept low and the system stays testable:
- **No LLM in the tests.** All agent tests use a scripted fake LLM, so `npm test` needs no key, no network and no quota.
- **Free tier first.** A busy or rate-limited main model falls back to a cheaper Flash-Lite model instead of failing (`GEMINI_FALLBACK_MODEL`).
- **Small, cheap context.** Policy text reaches the model only as the few passages that the MCP search returns (BM25 index, no embedding API), not as the whole document.
- **Bounded turns.** At most 5 tool rounds per question; the web chat limits messages per session (40) and open sessions (100).
- **Free tier privacy.** On the free tier Google may use prompts to improve its products; the data here is fictitious, but real student data would need the paid tier.
