import { join } from 'node:path';
import { TuitionAgent } from './agent';
import { createChatServer } from './chat-server';
import { loadConfig } from './config';
import { GeminiClient } from './llm';
import { McpPolicySearch } from './policy-search';
import { buildSystemPrompt } from './system-prompt';
import { TOOL_DECLARATIONS } from './tools';
import { HttpTuitionApi } from './tuition-api';

// Web chat entry point:  node dist/serve.js   (PORT, default 8080)
// Same agent, tools and confirmation gate as the CLI; every turn's trace goes to the container log.

const config = loadConfig();
const api = new HttpTuitionApi(config.gatewayUrl);
const policy = new McpPolicySearch(config.mcpUrl, config.mcpApiKey);

const app = createChatServer({
  api,
  publicDir: join(__dirname, '..', 'public'),
  secureCookies: process.env.CHAT_SECURE_COOKIES === 'true',
  swaggerUrl: `${config.gatewayUrl}/api/docs`,
  createAgent: (session) =>
    new TuitionAgent({
      llm: new GeminiClient({
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
        fallbackModel: config.geminiFallbackModel,
        systemInstruction: buildSystemPrompt(session.studentNo, new Date().toISOString().slice(0, 10)),
        tools: TOOL_DECLARATIONS,
      }),
      api,
      policy,
      session,
      trace: { record: (trace) => console.log(JSON.stringify({ type: 'tool-trace', ...trace })) },
    }),
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`Web chat on http://0.0.0.0:${port} (gateway ${config.gatewayUrl}, MCP ${config.mcpUrl})`);
});
