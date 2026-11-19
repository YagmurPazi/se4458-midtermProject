import { randomUUID } from 'node:crypto';
import { Content, FunctionCall, Part } from '@google/genai';
import { LlmClient } from './llm';
import { PolicySearch } from './policy-search';
import { TOOL_GET_MY_TUITION, TOOL_PAY_MY_TUITION, TOOL_SEARCH_POLICIES } from './tools';
import { ConfirmationRecord, LlmUsageSummary, TraceSink, TraceStep, TurnTrace } from './trace';
import { ApiError, Session, TuitionApi } from './tuition-api';

// The agent loop: the LLM chooses tools through function calling, the agent runs them and returns the results,
// until the LLM writes the answer. A payment is never sent in the turn in which the LLM asks for it: the agent
// shows a summary and only the user's next message, if it is an explicit confirmation, releases it.

const TERM = /^[0-9]{4}-(FALL|SPRING|SUMMER)$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

// Exact replies (after trimming, lower-casing and removing end punctuation) that confirm a pending payment.
const CONFIRMATIONS = new Set([
  'yes',
  'y',
  'confirm',
  'confirmed',
  'i confirm',
  'yes, i confirm',
  'yes i confirm',
  'evet',
  'onaylıyorum',
  'onayliyorum',
  'onayla',
  'evet, onaylıyorum',
  'evet onaylıyorum',
]);

export function isExplicitConfirmation(reply: string): boolean {
  // Lower-cased both ways: Turkish rules turn "ONAYLIYORUM" into "onaylıyorum", English rules keep "I" as "i".
  const normalize = (locale: string) =>
    reply
      .trim()
      .toLocaleLowerCase(locale)
      .replace(/[.!\s]+$/u, '')
      .replace(/\s+/g, ' ');
  return CONFIRMATIONS.has(normalize('en-US')) || CONFIRMATIONS.has(normalize('tr-TR'));
}

export interface PendingPayment {
  studentNo: string;
  term: string;
  amount: number;
  currentBalance: number;
}

export interface AgentReply {
  text: string;
  trace: TurnTrace;
  /** Set when the reply asks the user to confirm a payment. */
  pendingPayment: PendingPayment | null;
}

export interface AgentDependencies {
  llm: LlmClient;
  api: TuitionApi;
  policy: PolicySearch;
  session: Session;
  trace?: TraceSink;
  newTransactionId?: () => string;
  /** Maximum model calls that may request tools in one turn (protects against loops). */
  maxToolRounds?: number;
}

type ToolOutput = Record<string, unknown>;

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function errorOutput(error: unknown): ToolOutput {
  if (error instanceof ApiError) {
    return { error: { status: error.status, code: error.code, message: error.message } };
  }
  return { error: { message: error instanceof Error ? error.message : String(error) } };
}

export function confirmationMessage({ studentNo, term, amount, currentBalance }: PendingPayment): string {
  return [
    'Please confirm this payment / Lütfen bu ödemeyi onaylayın:',
    `  Student:         ${studentNo} (logged-in user)`,
    `  Term:            ${term}`,
    `  Amount:          ${money(amount)} USD`,
    `  Current balance: ${money(currentBalance)} USD (after payment: ${money(currentBalance - amount)} USD)`,
    'Reply "yes" or "confirm" ("evet" / "onaylıyorum") to submit it. Any other reply cancels it.',
  ].join('\n');
}

export class TuitionAgent {
  private readonly history: Content[] = [];
  private pending: PendingPayment | null = null;
  private readonly maxToolRounds: number;
  private readonly newTransactionId: () => string;

  constructor(private readonly deps: AgentDependencies) {
    this.maxToolRounds = deps.maxToolRounds ?? 5;
    this.newTransactionId = deps.newTransactionId ?? randomUUID;
  }

  get pendingPayment(): PendingPayment | null {
    return this.pending;
  }

  async handle(userText: string): Promise<AgentReply> {
    const steps: TraceStep[] = [];
    const parts: Part[] = [{ text: userText }];
    let confirmation: ConfirmationRecord | undefined;

    // The confirmation gate: a pending payment is decided by this reply, in code, before the LLM sees it.
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      const details = { term: pending.term, amount: pending.amount, currentBalance: pending.currentBalance };
      if (isExplicitConfirmation(userText)) {
        confirmation = { decision: 'CONFIRMED', ...details };
        const result = await this.submitPayment(pending, steps);
        parts.push({
          text: `[Payment system message, not written by the user] The user confirmed the pending payment. Payment API result: ${JSON.stringify(result)}`,
        });
      } else {
        confirmation = { decision: 'CANCELLED', ...details };
        parts.push({
          text:
            `[Payment system message, not written by the user] The pending payment of ${money(pending.amount)} USD for ` +
            `${pending.term} was cancelled because the reply was not an explicit confirmation. No payment was made.`,
        });
      }
    }

    const historyLength = this.history.length;
    this.history.push({ role: 'user', parts });
    const llm: LlmUsageSummary = { calls: 0, models: [], inputTokens: 0, outputTokens: 0 };
    let text: string;
    try {
      text = await this.runModel(steps, llm);
    } catch (error) {
      // For example the LLM is unavailable: drop this turn so the conversation history stays valid.
      // A payment confirmed above has already been sent and is not affected.
      this.history.length = historyLength;
      this.pending = null;
      throw error;
    }
    if (this.pending) {
      const { term, amount, currentBalance } = this.pending;
      confirmation = { decision: 'REQUESTED', term, amount, currentBalance };
    }

    const trace: TurnTrace = {
      timestamp: new Date().toISOString(),
      studentNo: this.deps.session.studentNo,
      user: userText,
      steps,
      ...(confirmation && { confirmation }),
      llm,
      answer: text,
    };
    this.deps.trace?.record(trace);
    return { text, trace, pendingPayment: this.pending };
  }

  /** Calls the LLM, runs the tools it asks for and feeds the results back, until it answers in text. */
  private async runModel(steps: TraceStep[], llm: LlmUsageSummary): Promise<string> {
    for (let round = 1; ; round++) {
      const response = await this.deps.llm.generate(this.history);
      llm.calls++;
      if (response.usage) {
        llm.inputTokens += response.usage.inputTokens;
        llm.outputTokens += response.usage.outputTokens;
        if (!llm.models.includes(response.usage.model)) {
          llm.models.push(response.usage.model);
        }
      }
      this.history.push(response.content);
      if (response.functionCalls.length === 0) {
        return response.text;
      }

      const limitReached = round > this.maxToolRounds;
      const results: Part[] = [];
      for (const call of response.functionCalls) {
        const output = limitReached
          ? { error: { code: 'TOOL_CALL_LIMIT_REACHED', message: 'Too many tool calls in one turn.' } }
          : await this.runTool(call, steps);
        results.push({ functionResponse: { id: call.id, name: call.name, response: output } });
      }
      this.history.push({ role: 'user', parts: results });

      if (limitReached) {
        return this.reply('Sorry, I could not complete this request. Please ask again in a simpler way.');
      }
      if (this.pending) {
        // Stop here: the summary is shown by the agent and the payment waits for the user's next message.
        return this.reply(confirmationMessage(this.pending));
      }
    }
  }

  /** A model turn written by the agent itself, kept in the history so the conversation stays consistent. */
  private reply(text: string): string {
    this.history.push({ role: 'model', parts: [{ text }] });
    return text;
  }

  private async runTool(call: FunctionCall, steps: TraceStep[]): Promise<ToolOutput> {
    const name = call.name ?? '';
    const args = call.args ?? {};
    const started = Date.now();
    let output: ToolOutput;
    try {
      output = await this.execute(name, args);
    } catch (error) {
      output = errorOutput(error);
    }
    steps.push({ tool: name, input: args, ok: !('error' in output), output, durationMs: Date.now() - started });
    return output;
  }

  private async execute(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    switch (name) {
      case TOOL_SEARCH_POLICIES: {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          return { error: { code: 'INVALID_ARGUMENT', message: 'query is required' } };
        }
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        return { result: await this.deps.policy.search(query, limit) };
      }
      case TOOL_GET_MY_TUITION: {
        const term = args.term;
        if (term !== undefined && (typeof term !== 'string' || !TERM.test(term))) {
          return { error: { code: 'INVALID_ARGUMENT', message: 'term must look like 2026-FALL' } };
        }
        return { result: await this.deps.api.getTuition(this.deps.session, term) };
      }
      case TOOL_PAY_MY_TUITION:
        return this.requestPayment(args);
      default:
        return { error: { code: 'UNKNOWN_TOOL', message: `No tool named ${name}` } };
    }
  }

  /** Validates a payment request against the live balance and parks it until the user confirms. */
  private async requestPayment(args: Record<string, unknown>): Promise<ToolOutput> {
    const { term, amount } = args;
    if (typeof term !== 'string' || !TERM.test(term)) {
      return { error: { code: 'INVALID_ARGUMENT', message: 'term must look like 2026-FALL' } };
    }
    if (typeof amount !== 'number' || !(amount > 0) || !AMOUNT.test(String(amount))) {
      return { error: { code: 'INVALID_ARGUMENT', message: 'amount must be a positive number with at most 2 decimals' } };
    }

    const { balance } = await this.deps.api.getTuition(this.deps.session, term);
    if (amount > balance) {
      return {
        error: {
          code: 'AMOUNT_EXCEEDS_BALANCE',
          message: `The amount ${money(amount)} USD exceeds the current balance ${money(balance)} USD for ${term}. Nothing was submitted.`,
        },
      };
    }

    this.pending = { studentNo: this.deps.session.studentNo, term, amount, currentBalance: balance };
    return {
      result: {
        status: 'AWAITING_USER_CONFIRMATION',
        message: 'The payment was NOT submitted. The user must explicitly confirm it in their next message.',
        ...this.pending,
      },
    };
  }

  private async submitPayment(pending: PendingPayment, steps: TraceStep[]): Promise<ToolOutput> {
    const input = {
      studentNo: pending.studentNo,
      term: pending.term,
      amount: pending.amount,
      transactionId: this.newTransactionId(),
    };
    const started = Date.now();
    let output: ToolOutput;
    try {
      output = { result: await this.deps.api.pay(this.deps.session, input) };
    } catch (error) {
      output = errorOutput(error);
    }
    steps.push({
      tool: `${TOOL_PAY_MY_TUITION} (confirmed: POST /api/v1/banking/payments)`,
      input,
      ok: !('error' in output),
      output,
      durationMs: Date.now() - started,
    });
    return output;
  }
}
