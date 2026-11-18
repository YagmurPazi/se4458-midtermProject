import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// MCP client for the policy search tool. The MCP server is called directly, not through the gateway.

export const MCP_TOOL_NAME = 'search_tuition_policies';

export interface PolicySearch {
  search(query: string, limit?: number): Promise<unknown>;
  close(): Promise<void>;
}

export class McpPolicySearch implements PolicySearch {
  private client: Client | null = null;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async search(query: string, limit?: number): Promise<unknown> {
    const client = await this.connect();
    const result = await client.callTool({
      name: MCP_TOOL_NAME,
      arguments: limit === undefined ? { query } : { query, limit },
    });
    if (result.isError) {
      const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? 'unknown error';
      throw new Error(`MCP tool error: ${text}`);
    }
    return result.structuredContent;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private async connect(): Promise<Client> {
    if (!this.client) {
      const client = new Client({ name: 'tuition-agent', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(this.url), {
          requestInit: { headers: { 'x-api-key': this.apiKey } },
        }),
      );
      this.client = client;
    }
    return this.client;
  }
}
