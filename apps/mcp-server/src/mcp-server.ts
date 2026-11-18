import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PolicyIndex } from './policy-index';

export const TOOL_NAME = 'search_tuition_policies';

const matchSchema = z.object({
  section: z.string().describe('Section number to cite, e.g. "3.2"'),
  heading: z.string(),
  parentHeading: z.string().nullable().describe('Heading of the enclosing section, if any'),
  text: z.string().describe('Policy text of the section'),
  score: z.number().describe('Relevance score, higher is better'),
});

const resultSchema = {
  document: z.string(),
  documentId: z.string(),
  query: z.string(),
  matches: z.array(matchSchema),
};

/** Creates an MCP server exposing the policy search tool over the given (pre-built) index. */
export function createMcpServer(index: PolicyIndex): McpServer {
  const server = new McpServer({ name: 'tuition-policy-mcp', version: '1.0.0' });

  server.registerTool(
    TOOL_NAME,
    {
      title: 'Search tuition policies',
      description:
        'Searches the official university tuition policy document (payment deadlines, installments, late fees, ' +
        'scholarships, refunds and withdrawals, banking and payment rules). Returns the most relevant passages ' +
        'with their section numbers so answers can cite them (for example "§3.2"). Write the query in English ' +
        'keywords. The document contains general rules only, no student-specific balances or records.',
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe('What to look for, e.g. "fall payment deadline"'),
        limit: z.number().int().min(1).max(5).optional().describe('Maximum number of passages (default 3)'),
      },
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const result = index.search(query, limit ?? 3);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result },
      };
    },
  );

  return server;
}
