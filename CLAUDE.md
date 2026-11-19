# CLAUDE.md — SE 4458 Midterm: AI Tuition Assistant (Group 1)

Individual university project (Yaşar University, SE 4458 Software Architecture & Design of Modern Large Scale Systems). Owner: Yağmur Pazı.

## Working rules (follow every session)
- **Talk to the user in Turkish.** Write all code, comments, commit messages, README and docs in **English**.
- **Ask for confirmation before each stage and before any change to the repo, commit or push.** Show what you plan, then do it.
- Explain technical changes **briefly and simply**, staying professional.
- Never commit secrets (`.env`, API keys). `.env.example` holds placeholders only.
- **No AI attribution anywhere**: no `Co-Authored-By`, "Generated with Claude", session links or similar lines in commit messages, PR descriptions or files.
- Model use: the main session handles design, the MCP server and the agent. Delegate large, well-defined work to the subagents in `.claude/agents/` and tell the user in one line which agent and model you are using.
- Before marking any stage done, run `npm run build`, `npm test` and `npm run lint` at the repo root.

## Sources of truth
- `docs/API.md`: REST contract (routes, bodies, error codes). Change the code to match the contract, or update the contract **with the user's approval**.
- `README.md` §12: all agreed assumptions and design decisions. These are final unless the user changes them.
- `apps/mcp-server/data/University_Tuition_Policies.md`: the instructor-provided policy document. Do not edit it.
- The requirements checklist below, condensed from the assignment.

## Architecture (required by the assignment)
```
CLI chat → Agent ──► Gemini (function calling: tool selection + answer)
             ├─ MCP client ──HTTP──► MCP server ──► MiniSearch index of the policy .md
             └─ REST ──► Kong gateway ──► Tuition API (NestJS) ──► PostgreSQL
```
The agent executes all tool calls; the LLM never calls backends. The MCP path does not go through the gateway. Every REST call (including the agent's) goes through Kong.

## Stack (decided)
- npm workspaces monorepo, TypeScript (strict), Node ≥ 20 (user has v26).
- `apps/tuition-api`: NestJS 11, Prisma 6 + PostgreSQL 16, @nestjs/swagger (Swagger UI at `/api/docs`), JWT (HS256) via @nestjs/jwt + passport-jwt, Jest + Supertest.
- `apps/mcp-server`: @modelcontextprotocol/sdk, MiniSearch (BM25), Streamable HTTP transport (stdio also), protected by an `x-api-key` header.
- `apps/agent`: plain TypeScript CLI, @google/genai (Gemini, free tier: `gemini-3.8-flash`, fallback `gemini-3.5-flash-lite`), MCP SDK client.
- `gateway/kong.yml`: Kong OSS 3.x, DB-less.
- Local: `docker-compose.yml` (postgres, tuition-api, mcp-server, kong). Cloud: Azure Container Apps + Azure Database for PostgreSQL Flexible Server (B1MS, free 12 months; the user's Azure for Students account is new).

## Key decisions (details in README §12)
- Routes under `/api/v1`. Roles: `STUDENT` (own records only), `BANK` (any student), `ADMIN`.
- Mobile Query Tuition: `GET /api/v1/mobile/tuition` with header `X-Student-No`, no auth. Kong `rate-limiting` with `limit_by: header`, `day: 3`, `policy: local`, single Kong instance. UTC day; every call counts.
- Banking Query: `GET /api/v1/banking/tuition/{studentNo}?term=`. Pay: `POST /api/v1/banking/payments` (`transactionId` = idempotency key → `409 DUPLICATE_TRANSACTION`; amount > balance → `422 AMOUNT_EXCEEDS_BALANCE`; row lock with `SELECT … FOR UPDATE`).
- Admin: Add Tuition (upsert on studentNo+term; `422 AMOUNT_BELOW_PAID`; student must exist → 404), Batch CSV (row-independent, `DUPLICATE_IN_FILE`), Unpaid (balance > 0; `term` required; `sortBy=balance|studentNo`, `sortOrder=asc|desc`, default `balance desc`, tie-break `studentNo asc`; page past the last → `400 PAGE_OUT_OF_RANGE`; empty result → `totalPages: 0`).
- Currency USD only. Money `NUMERIC(12,2)`; reject more than 2 decimals (no rounding). Balance is computed (amount − sum of payments), never stored.
- Agent tools: `search_tuition_policies(query)`, `get_my_tuition(term?)`, `pay_my_tuition(term, amount)`. **No student-number parameter**: the number always comes from the logged-in user's JWT. **Payment confirmation is enforced in code**: show student, term, amount and current balance, then call the API only after an explicit "yes"/"confirm". The agent generates the transactionId (UUID).
- MCP: one chunk per `###` subsection (or `##` without subsections). Index built at build time, loaded at startup. Result fields: `document`, `documentId`, `section`, `heading`, `text`.

## Stage plan and status
| # | Stage | Status |
|---|---|---|
| 0 | Monorepo skeleton | Done |
| 1 | API contract (`docs/API.md`) + assumptions (README §12) | Done |
| 2 | Prisma schema, migration, seed data, ER diagram (Mermaid in `docs/`) | Done |
| 3 | REST API + unit tests (every operation: ≥1 success and ≥1 failure test) | Done |
| 4 | Kong: versioned routes, JWT on protected routes, per-student rate limit, sample error response | Done |
| 5 | MCP server: chunking, index, tool, 3 distinct retrieval tests | Done |
| 6 | Agent: Gemini function-calling loop, confirmation gate, tool trace log, mock-LLM tests | Done (verified live with Gemini) |
| 7 | Azure deployment scripts in `infra/` (the user runs them in their own account) | Done: deployed and verified in Azure (swedencentral) |
| 8 | Evidence + README: 3 agent scenarios, 3 MCP queries, protected route, confirmed payment, test run, video script | |
| 9 | Independent review against the checklist (`reviewer` agent) | |

Update this table when a stage finishes.

## Known issues / notes
- npm audit (reviewed in Stage 3): `deepmerge-ts` (3 findings: deepmerge-ts, @prisma/config, prisma) comes only from the Prisma CLI, which runs at build time and for `migrate deploy` at container start with our own config only (no untrusted input); the fix needs deepmerge-ts 8 and `npm audit fix` downgrades Prisma CLI to 6.12 (mismatch with client 6.19.3), so it is accepted. `zod` was upgraded to v4 in Stage 5 (MCP SDK 1.32 supports it), which cleared that finding. Never run `npm audit fix` blindly.
- Stage 4: `prisma` is now a runtime dependency; the API container runs `prisma migrate deploy` before starting. Seed in a container: `node dist/seed/seed.js`.
- Kong runs from its own image (`gateway/Dockerfile`, kong.yml baked in). Kong OSS cannot resolve `{vault://env/...}` in `jwt_secrets.secret` (tested: it used the literal string), so `gateway/render-config.sh` writes `JWT_SECRET` into the config at container start. Kong and the API must get the same `JWT_SECRET`.
- Gateway smoke test: `./gateway/smoke-test.sh [url]` (mobile limit counters live in Kong memory; restart Kong or use other students to rerun the same day). Evidence in `docs/evidence/`.
- Integration tests: `npm run test:int -w apps/tuition-api` (needs Docker Postgres, migrated + seeded; README §10). `JWT_SECRET` is required at startup.
- Stage 2 restored `prisma generate` in the `tuition-api` build script. Prisma 6 warns that `package.json#prisma` (seed config) is deprecated for Prisma 7; fine while on Prisma 6.
- Docker Desktop is installed on the user's Mac, but `~/.docker/bin` may be missing from the shell PATH: use `export PATH="$HOME/.docker/bin:$PATH"`. Local DB: `docker compose up -d postgres`, then `prisma:migrate` and `prisma:seed` (README §8).
- Seed lives in `apps/tuition-api/src/seed/` (not `prisma/`) so it compiles to `dist/seed/seed.js` and can seed the cloud DB from the container. Password hashing: `src/auth/password.ts` (node:crypto scrypt), reuse it for login in Stage 3.
- MCP server (Stage 5): stateless Streamable HTTP on `POST /mcp` (port 3001, `x-api-key`), index built by `npm run build` into `dist/policy-index.json`. The search is English keyword BM25: Turkish queries find nothing, so the agent's system prompt must tell Gemini to write `search_tuition_policies` queries in English. Demo/evidence: `npm run demo -w apps/mcp-server` (needs MCP_URL, MCP_API_KEY).
- Agent (Stage 6): `apps/agent` CLI; LlmClient interface (GeminiClient, scripted fake in tests); tools without studentNo; confirmation gate in `agent.ts` (`isExplicitConfirmation`); trace to console + `logs/agent-trace.jsonl` (gitignored). Login can be scripted with AGENT_USERNAME/AGENT_PASSWORD; piped input is queued (`LineReader`), so `node apps/agent/dist/index.js < questions.txt` gives a full transcript. GEMINI_API_KEY is in `.env` (the user once pasted it into `.env.example` by mistake: always check `git diff .env.example` before committing). `gemini-2.5-flash` is closed to new users; `gemini-3.8-flash` often answers 503/504 on the free tier, so GeminiClient retries twice, then uses GEMINI_FALLBACK_MODEL and skips a busy model for 5 minutes. Live run verified: MCP-only, REST-only, MCP+REST, other student refused, confirmed payment, Turkish question.
- Web chat (added after Stage 7, user's choice: simple page on Azure, not Firebase): `apps/agent/src/chat-server.ts` + `serve.ts` + `public/index.html` (vanilla JS), compose service `chat` (:8080), Azure app `tuition-chat` (max 1 replica, in-memory sessions, HttpOnly cookie). Confirm/Cancel buttons only send "yes"/"cancel". Gemini busy state is shared by all sessions (`SHARED_BUSY_UNTIL` in llm.ts).
- Azure for Students limits (found while deploying): only swedencentral/francecentral/switzerlandnorth/polandcentral/norwayeast; no ACR Tasks (images are built locally with buildx for linux/amd64, IMAGE_BUILD=local); the CLI may create an Express Container Apps environment (no internal app-to-app traffic, no jobs), so deploy.sh forces `--environment-mode WorkloadProfiles` (RECREATE_ENV=true recreates an Express one). Seed runs on the API's first start (SEED_ON_START, empty DB only). Image tags are content hashes. Never edit deploy.sh while the user is running it (bash reads it line by line). Cloud URLs are in README §9 and infra/cloud.env.
- Azure (Stage 7): `infra/deploy.sh` (idempotent az CLI; ACR build in the cloud, PG Flexible B1ms, Container Apps: tuition-api internal, tuition-gateway 1 replica, tuition-mcp, job tuition-seed running `npm run db:setup`). Gitignored local files: `infra/config.env`, `infra/.deploy-state.env` (generated secrets), `infra/cloud.env` (URLs + MCP key for agent/tests). Kong upstream comes from `UPSTREAM_URL` (rendered by `gateway/render-config.sh`; Azure uses `https://<api internal fqdn>`). `infra/destroy.sh` deletes the resource group. Never commit the state files.
- Docker build context is the repo root (`context: .`, `dockerfile: apps/<app>/Dockerfile`).

## Requirements checklist (condensed from the assignment)
Grading: REST + business logic 25 · Agent/LLM tool calling 20 · MCP + indexing 20 · API Gateway 10 · DB + auth 10 · Cloud 5 · Testing + docs 10.
- [ ] Real LLM function calling; no keyword routing. Flow: question → LLM picks tools → agent executes (REST via gateway) → results back to LLM → grounded answer with policy section references.
- [ ] Three demonstrated interactions with tool traces (tool names, inputs, results, final answer): MCP-only, REST-only, MCP + REST.
- [ ] Payment requires explicit confirmation. Account operations protected with auth.
- [ ] Real MCP SDK server with `search_tuition_policies(query)` returning excerpts + section references; three distinct retrieval queries demonstrated; document indexed before queries, not per question.
- [ ] All seven API operations as specified, with auth and paging as in the spec table; mobile query limited to 3 per student per day, keyed by student identity.
- [ ] APIs versionable. Swagger UI or document.
- [ ] Gateway routes ALL REST operations; at least two routed endpoints incl. one protected; versioned public routes; gateway URL, route mappings and one error response documented.
- [ ] JWT/OAuth; agent cannot access another user's data via a number in the prompt; confirmation before write/payment.
- [ ] Unit tests for all REST operations (≥1 success + ≥1 failure each), checking business logic, validation and responses; runnable without cloud or live LLM; test code, run instructions and evidence in README.
- [ ] ER/data model; server database (not SQLite).
- [ ] API, MCP, gateway and DB deployed on Azure (local deployment costs points). Document LLM cost and a low-cost/testable approach.
- [ ] README contains everything: source, Swagger/OpenAPI, ER diagram, gateway URL/routes, MCP tool schema + indexing approach, deployment instructions/URLs, assumptions, test data and reproduction steps, screenshots/logs of all demos, short video link. Nothing goes only to Moodle.
