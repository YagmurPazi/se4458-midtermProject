import { Content, FunctionCall, FunctionCallingConfigMode, FunctionDeclaration, GoogleGenAI } from '@google/genai';

// The agent talks to the LLM only through this interface, so tests can use a scripted fake LLM.

/** Token use of one model call, as reported by the LLM. */
export interface LlmUsage {
  model: string;
  inputTokens: number;
  /** Answer tokens, including any thinking tokens (billed as output). */
  outputTokens: number;
}

export interface LlmResponse {
  /** The model turn, appended to the conversation history as-is. */
  content: Content;
  /** Tools the model asks the agent to run (empty when it answers directly). */
  functionCalls: FunctionCall[];
  text: string;
  usage?: LlmUsage;
}

export interface LlmClient {
  generate(history: Content[]): Promise<LlmResponse>;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Used in order when the main model stays busy (503 "high demand" on the free tier); comma-separated list. */
  fallbackModel?: string;
  systemInstruction: string;
  tools: FunctionDeclaration[];
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
  now?: () => number;
  /** Which models were busy until when; shared by all clients by default (one per web chat session). */
  busyUntil?: Map<string, number>;
}

// Temporary errors. A rate limit or an internal error is retried once on the same model; an overloaded
// model (503) or a deadline error (504) moves to the next model at once, because on the free tier
// another model is usually available while the busy one stays busy for a while.
const RETRY_SAME_MODEL_STATUS = new Set([429, 500]);
const MOVE_ON_STATUS = new Set([503, 504]);
const ATTEMPTS_PER_MODEL = 2;
const RETRY_DELAY_MS = 2000;
// The SDK passes this to Gemini as the request deadline; an overloaded model answers 504 when it expires.
const DEFAULT_TIMEOUT_MS = 35_000;
// A model that stayed busy is skipped for a while, so every question does not wait for it again.
const BUSY_COOLDOWN_MS = 5 * 60_000;
const SHARED_BUSY_UNTIL = new Map<string, number>();

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Google Gemini with function calling. The SDK's automatic function calling is off: the agent runs every tool. */
export class GeminiClient implements LlmClient {
  private readonly ai: GoogleGenAI;
  private readonly models: string[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warn: (message: string) => void;
  private readonly now: () => number;
  private readonly busyUntil: Map<string, number>;

  constructor(private readonly options: GeminiOptions) {
    this.ai = new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS } });
    const { model, fallbackModel } = options;
    const fallbacks = (fallbackModel ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    this.models = [...new Set([model, ...fallbacks])];
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.now = options.now ?? Date.now;
    this.busyUntil = options.busyUntil ?? SHARED_BUSY_UNTIL;
  }

  async generate(history: Content[]): Promise<LlmResponse> {
    const available = this.models.filter((model) => (this.busyUntil.get(model) ?? 0) <= this.now());
    // If every model was busy recently, try them all again rather than giving up.
    const candidates = available.length > 0 ? available : this.models;

    let lastError: unknown;
    for (const [index, model] of candidates.entries()) {
      if (index > 0) {
        this.warn(`  (Gemini model ${candidates[index - 1]} is busy; using ${model})`);
      }
      for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
        try {
          const response = await this.generateWith(model, history);
          this.busyUntil.delete(model);
          return response;
        } catch (error) {
          const status = statusOf(error);
          if (status === undefined || !(RETRY_SAME_MODEL_STATUS.has(status) || MOVE_ON_STATUS.has(status))) {
            throw error;
          }
          lastError = error;
          if (MOVE_ON_STATUS.has(status)) {
            break;
          }
          if (attempt < ATTEMPTS_PER_MODEL) {
            await this.sleep(RETRY_DELAY_MS);
          }
        }
      }
      this.busyUntil.set(model, this.now() + BUSY_COOLDOWN_MS);
    }
    throw lastError;
  }

  private async generateWith(model: string, history: Content[]): Promise<LlmResponse> {
    const response = await this.ai.models.generateContent({
      model,
      contents: history,
      config: {
        systemInstruction: this.options.systemInstruction,
        tools: [{ functionDeclarations: this.options.tools }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        automaticFunctionCalling: { disable: true },
        // Temperature is left at the model default, as recommended for Gemini 3 models.
      },
    });

    const meta = response.usageMetadata;
    const usage: LlmUsage = {
      model,
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    };

    const content = response.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      // For example a blocked or empty answer; keep the history valid with a short model turn.
      const text = 'Sorry, I could not produce an answer. Please rephrase your question.';
      return { content: { role: 'model', parts: [{ text }] }, functionCalls: [], text, usage };
    }
    // The text parts are joined here (response.text would warn when the turn also contains function calls).
    const text = content.parts
      .filter((part) => typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('');
    return { content: { ...content, role: 'model' }, functionCalls: response.functionCalls ?? [], text, usage };
  }
}
