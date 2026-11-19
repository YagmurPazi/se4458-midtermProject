import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Tool trace: for every turn, the tools the agent ran (name, input, result) and the final answer.

export interface TraceStep {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  output: unknown;
  durationMs: number;
}

export interface ConfirmationRecord {
  decision: 'REQUESTED' | 'CONFIRMED' | 'CANCELLED';
  term: string;
  amount: number;
  currentBalance: number;
}

/** LLM calls of one turn and their token use (when the LLM reports it). */
export interface LlmUsageSummary {
  calls: number;
  models: string[];
  inputTokens: number;
  outputTokens: number;
}

export interface TurnTrace {
  timestamp: string;
  studentNo: string;
  user: string;
  steps: TraceStep[];
  confirmation?: ConfirmationRecord;
  llm?: LlmUsageSummary;
  answer: string;
}

export interface TraceSink {
  record(trace: TurnTrace): void;
}

function shorten(value: unknown, max = 400): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Prints a compact trace to the console and appends the full trace as one JSON line to a file. */
export class ConsoleFileTrace implements TraceSink {
  constructor(
    private readonly file: string,
    private readonly print: (line: string) => void = console.log,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  record(trace: TurnTrace): void {
    this.print('  ┌─ tool trace');
    if (trace.steps.length === 0) {
      this.print('  │ (no tools used)');
    }
    for (const step of trace.steps) {
      this.print(`  │ ${step.ok ? '✔' : '✖'} ${step.tool} ${shorten(step.input, 200)} (${step.durationMs} ms)`);
      this.print(`  │   → ${shorten(step.output)}`);
    }
    if (trace.confirmation) {
      const { decision, term, amount } = trace.confirmation;
      this.print(`  │ confirmation gate: ${decision} (${term}, ${amount.toFixed(2)} USD)`);
    }
    if (trace.llm && trace.llm.calls > 0) {
      const { calls, models, inputTokens, outputTokens } = trace.llm;
      this.print(`  │ LLM: ${calls} call(s) to ${models.join(', ')}; tokens in ${inputTokens}, out ${outputTokens}`);
    }
    this.print(`  └─ trace saved to ${this.file}`);
    appendFileSync(this.file, `${JSON.stringify(trace)}\n`);
  }
}
