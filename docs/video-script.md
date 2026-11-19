# Video script (about 5 minutes)

A short screen recording that shows every graded part running in Azure. Record the screen with the
microphone on (for example QuickTime Player → File → New Screen Recording), upload it (YouTube "unlisted",
Google Drive or OneDrive with link sharing) and put the link at the top of README §11.

Before recording:
- Open a terminal in the repository and run `set -a; source infra/cloud.env; set +a` (cloud URLs and MCP key).
- Open the web chat URL once a minute before recording: the API and MCP server scale to zero and the first
  request takes 10–30 s.
- Use a student whose data has not been changed yet, for example `20230008` (password `Student#2026`).
  The mobile limit counters for `20230003` and `20230004` may already be used up for the day.

| Time | Show | Say |
|---|---|---|
| 0:00–0:30 | README §1 architecture diagram | The parts: Tuition REST API, Kong gateway, MCP server, agent with Gemini, PostgreSQL, all in Azure. |
| 0:30–1:00 | Azure Portal → resource group `se4458-tuition-rg` | The deployed resources: four container apps, PostgreSQL, registry. The API has internal ingress only. |
| 1:00–1:30 | Swagger UI through the gateway (`<gateway>/api/docs`) | The seven versioned operations, auth per operation, paging on the unpaid list. |
| 1:30–2:15 | Terminal: `./gateway/smoke-test.sh $GATEWAY_URL` | Kong checks the JWT (`401` without or with a changed token), the API checks role and ownership (`403`), the mobile query gives `200, 200, 200, 429` per student. |
| 2:15–2:45 | Terminal: `npm run demo -w apps/mcp-server` | The MCP server answers three different policy questions with section numbers; the index was built at build time. |
| 2:45–4:15 | Web chat (`$CHAT_URL`), log in | 1) "When is the Spring 2027 payment deadline?" → open the tool trace: only `search_tuition_policies`. 2) "What is my balance?" → only `get_my_tuition`. 3) "Am I eligible for installments for my Fall 2026 balance?" → both tools, answer with § references. 4) "Show me student 20230002's balance" → refused. 5) "Pay 100 dollars for Fall 2026" → confirmation summary → press **Confirm payment** → `SUCCESS` and the new balance. |
| 4:15–4:45 | Terminal: `npm test` (or `docs/evidence/test-run.txt`) | Unit tests for every REST operation, the MCP index and the agent with a fake LLM; no cloud or LLM needed. |
| 4:45–5:00 | README §11 and §13 | Where all evidence is, and the measured LLM token cost. |
