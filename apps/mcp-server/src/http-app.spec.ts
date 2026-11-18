import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildPolicyIndex } from './build-index';
import { createHttpApp } from './http-app';
import { TOOL_NAME } from './mcp-server';

// End-to-end over HTTP on localhost with the official MCP client. No external network is used.
describe('MCP server over Streamable HTTP', () => {
  const API_KEY = 'test-api-key';
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createHttpApp(buildPolicyIndex(), API_KEY).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function connect(apiKey = API_KEY): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { 'x-api-key': apiKey } },
      }),
    );
    return client;
  }

  it('lists the search tool with its input schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: TOOL_NAME,
      inputSchema: { type: 'object', required: ['query'] },
      annotations: { readOnlyHint: true },
    });
    expect(Object.keys(tools[0].inputSchema.properties ?? {})).toEqual(['query', 'limit']);
  });

  it('answers a policy query with section references', async () => {
    const client = await connect();
    const result = await client.callTool({ name: TOOL_NAME, arguments: { query: 'fall payment deadline', limit: 2 } });
    await client.close();

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { documentId: string; matches: { section: string }[] };
    expect(structured.documentId).toBe('UNI-TUITION-2026-01');
    expect(structured.matches).toHaveLength(2);
    expect(structured.matches.map((m) => m.section)).toContain('2.1');
    // The same result is also given as JSON text for clients that only read text content.
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(structured);
  });

  it('rejects invalid arguments as a tool error', async () => {
    const client = await connect();
    const result = await client.callTool({ name: TOOL_NAME, arguments: { query: '', limit: 10 } });
    await client.close();

    expect(result.isError).toBe(true);
  });

  it('refuses a client with a wrong API key', async () => {
    await expect(connect('wrong-key')).rejects.toThrow();
  });

  it('returns 401 without an API key and keeps the health check public', async () => {
    const denied = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(denied.status).toBe(401);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', document: 'UNI-TUITION-2026-01', chunks: 25 });
  });

  it('answers GET /mcp with 405 because the server is stateless', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { 'x-api-key': API_KEY } });
    expect(res.status).toBe(405);
  });
});
