import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Express, NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-server';
import { PolicyIndex } from './policy-index';

// HTTP front end of the MCP server (Streamable HTTP transport, stateless).
// Stateless: every POST /mcp gets a fresh server and transport, so any replica can answer any request.

function sameSecret(given: string, expected: string): boolean {
  // Hashing first gives equal-length buffers, as timingSafeEqual requires.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export function createHttpApp(index: PolicyIndex, apiKey: string): Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', document: index.documentId, chunks: index.size });
  });

  const requireApiKey = (req: Request, res: Response, next: NextFunction): void => {
    const given = req.header('x-api-key');
    if (!given || !sameSecret(given, apiKey)) {
      jsonRpcError(res, 401, 'Unauthorized: missing or invalid x-api-key header.');
      return;
    }
    next();
  };

  app.post('/mcp', requireApiKey, async (req, res) => {
    const server = createMcpServer(index);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, 'Internal server error.');
      }
    }
  });

  // Stateless mode has no server-initiated stream (GET) and no session to delete (DELETE).
  app.all('/mcp', requireApiKey, (_req, res) => {
    jsonRpcError(res, 405, 'Method not allowed.');
  });

  return app;
}
