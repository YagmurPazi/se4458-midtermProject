import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { INDEX_FILE } from './build-index';
import { createHttpApp } from './http-app';
import { createMcpServer } from './mcp-server';
import { PolicyIndex } from './policy-index';

// Entry point.
//   HTTP (default): node dist/index.js            -> POST /mcp, needs MCP_API_KEY
//   stdio (local):  node dist/index.js --stdio    -> for MCP clients that start the server themselves

async function main(): Promise<void> {
  // The index was built by `npm run build`; it is only loaded here.
  const index = PolicyIndex.load(INDEX_FILE);

  if (process.argv.includes('--stdio')) {
    await createMcpServer(index).connect(new StdioServerTransport());
    console.error(`MCP server on stdio: ${index.size} policy chunks loaded.`);
    return;
  }

  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    throw new Error('MCP_API_KEY is not set');
  }
  const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? 3001);
  createHttpApp(index, apiKey).listen(port, () => {
    console.log(`MCP server on http://0.0.0.0:${port}/mcp: ${index.size} policy chunks loaded.`);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
