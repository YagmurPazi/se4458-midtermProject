import { createInterface, Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { TuitionAgent } from './agent';
import { loadConfig } from './config';
import { GeminiClient } from './llm';
import { McpPolicySearch } from './policy-search';
import { buildSystemPrompt } from './system-prompt';
import { TOOL_DECLARATIONS } from './tools';
import { ConsoleFileTrace } from './trace';
import { ApiError, HttpTuitionApi, Session } from './tuition-api';

// Command-line chat. The student logs in first; the agent then acts only for that student.
//   npm run start -w apps/agent
// For scripted demos the login can come from AGENT_USERNAME / AGENT_PASSWORD.

/** Output stream that can hide what is typed (for the password prompt). */
class MutableStdout extends Writable {
  muted = false;
  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    if (!this.muted) {
      process.stdout.write(chunk);
    }
    done();
  }
}

async function login(rl: Interface, output: MutableStdout, api: HttpTuitionApi): Promise<Session> {
  const presetUser = process.env.AGENT_USERNAME;
  const presetPassword = process.env.AGENT_PASSWORD;
  for (;;) {
    const username = presetUser ?? (await rl.question('Student number: ')).trim();
    let password = presetPassword;
    if (password === undefined) {
      process.stdout.write('Password: ');
      output.muted = true;
      password = await rl.question('');
      output.muted = false;
      process.stdout.write('\n');
    }
    try {
      return await api.login(username, password);
    } catch (error) {
      const message = error instanceof ApiError ? `${error.code}: ${error.message}` : String(error);
      console.log(`Login failed (${message})`);
      if (presetUser !== undefined) {
        throw error;
      }
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const output = new MutableStdout();
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });

  const api = new HttpTuitionApi(config.gatewayUrl);
  const policy = new McpPolicySearch(config.mcpUrl, config.mcpApiKey);

  console.log('AI Tuition Assistant');
  console.log(`Gateway: ${config.gatewayUrl} | MCP: ${config.mcpUrl} | Model: ${config.geminiModel}\n`);
  const session = await login(rl, output, api);
  console.log(`Logged in as student ${session.studentNo}. Type your question, or "exit" to quit.\n`);

  const today = new Date().toISOString().slice(0, 10);
  const agent = new TuitionAgent({
    llm: new GeminiClient(config.geminiApiKey, config.geminiModel, buildSystemPrompt(session.studentNo, today), TOOL_DECLARATIONS),
    api,
    policy,
    session,
    trace: new ConsoleFileTrace(config.traceFile),
  });

  try {
    for (;;) {
      let question: string;
      try {
        question = (await rl.question('You: ')).trim();
      } catch {
        break; // input closed (Ctrl+D or end of piped input)
      }
      if (!question) {
        continue;
      }
      if (['exit', 'quit', 'çıkış'].includes(question.toLowerCase())) {
        break;
      }
      try {
        const reply = await agent.handle(question);
        console.log(`\nAssistant: ${reply.text}\n`);
      } catch (error) {
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rl.close();
    await policy.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
