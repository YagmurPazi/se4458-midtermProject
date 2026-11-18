import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TOOL_NAME } from './mcp-server';

// Calls a running MCP server with the official MCP client and prints three distinct policy queries.
//   MCP_URL=http://localhost:3001/mcp MCP_API_KEY=... npm run demo -w apps/mcp-server
// Used to produce docs/evidence/mcp-queries.txt.

const QUERIES = [
  'fall tuition payment deadline',
  'installment eligibility and number of installments',
  'refund after withdrawal from the term',
];

async function main(): Promise<void> {
  const url = process.env.MCP_URL ?? 'http://localhost:3001/mcp';
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    throw new Error('MCP_API_KEY is not set');
  }

  const client = new Client({ name: 'demo-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'x-api-key': apiKey } } }));

  console.log(`MCP server: ${url}`);
  console.log(`Time:       ${new Date().toISOString()}\n`);

  const { tools } = await client.listTools();
  console.log('== tools/list');
  console.log(JSON.stringify(tools, null, 2));

  for (const [n, query] of QUERIES.entries()) {
    console.log(`\n== Query ${n + 1}: tools/call ${TOOL_NAME} ${JSON.stringify({ query, limit: 2 })}`);
    const result = await client.callTool({ name: TOOL_NAME, arguments: { query, limit: 2 } });
    console.log(JSON.stringify(result.structuredContent, null, 2));
  }

  await client.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
