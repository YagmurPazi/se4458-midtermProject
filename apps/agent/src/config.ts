import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

export interface AgentConfig {
  /** Kong gateway base URL; every REST call goes through it. */
  gatewayUrl: string;
  /** MCP server endpoint (not behind the gateway). */
  mcpUrl: string;
  mcpApiKey: string;
  geminiApiKey: string;
  geminiModel: string;
  /** Used when the main model is busy. */
  geminiFallbackModel: string;
  /** JSON Lines file that receives one tool trace per turn. */
  traceFile: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (see .env.example)`);
  }
  return value;
}

/** Reads the configuration from the environment, falling back to the repository's .env file. */
export function loadConfig(): AgentConfig {
  loadDotenv({ path: resolve(__dirname, '..', '..', '..', '.env'), quiet: true });
  return {
    gatewayUrl: (process.env.GATEWAY_URL ?? 'http://localhost:8000').replace(/\/+$/, ''),
    mcpUrl: process.env.MCP_URL ?? 'http://localhost:3001/mcp',
    mcpApiKey: required('MCP_API_KEY'),
    geminiApiKey: required('GEMINI_API_KEY'),
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
    geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.1-flash-lite',
    traceFile: process.env.AGENT_TRACE_FILE ?? resolve(process.cwd(), 'logs', 'agent-trace.jsonl'),
  };
}
