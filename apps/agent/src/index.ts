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

/** Reads answers line by line; lines typed or piped in early are queued, not lost. */
class LineReader {
  private readonly lines: AsyncIterator<string>;

  constructor(
    rl: Interface,
    private readonly output: MutableStdout,
  ) {
    this.lines = rl[Symbol.asyncIterator]();
  }

  /** Returns the next line, or null when the input has ended. */
  async ask(prompt: string, hidden = false): Promise<string | null> {
    process.stdout.write(prompt);
    this.output.muted = hidden;
    const { value, done } = await this.lines.next();
    this.output.muted = false;
    if (done) {
      return null;
    }
    if (hidden) {
      process.stdout.write('\n');
    } else if (!process.stdin.isTTY) {
      process.stdout.write(`${value}\n`); // show piped input, so saved transcripts read like a chat
    }
    return value;
  }
}

async function login(reader: LineReader, api: HttpTuitionApi): Promise<Session> {
  const presetUser = process.env.AGENT_USERNAME;
  const presetPassword = process.env.AGENT_PASSWORD;
  for (;;) {
    const username = presetUser ?? (await reader.ask('Student number: '));
    const password = presetPassword ?? (username === null ? null : await reader.ask('Password: ', true));
    if (username === null || password === null) {
      throw new Error('Input ended before login');
    }
    try {
      return await api.login(username.trim(), password);
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
  console.log(
    `Gateway: ${config.gatewayUrl} | MCP: ${config.mcpUrl} | Model: ${config.geminiModel} (fallback ${config.geminiFallbackModel})\n`,
  );
  const reader = new LineReader(rl, output);
  const session = await login(reader, api);
  console.log(`Logged in as student ${session.studentNo}. Type your question, or "exit" to quit.\n`);

  const today = new Date().toISOString().slice(0, 10);
  const agent = new TuitionAgent({
    llm: new GeminiClient({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      fallbackModel: config.geminiFallbackModel,
      systemInstruction: buildSystemPrompt(session.studentNo, today),
      tools: TOOL_DECLARATIONS,
    }),
    api,
    policy,
    session,
    trace: new ConsoleFileTrace(config.traceFile),
  });

  try {
    for (;;) {
      const line = await reader.ask('You: ');
      if (line === null) {
        break; // input closed (Ctrl+D or end of piped input)
      }
      const question = line.trim();
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
