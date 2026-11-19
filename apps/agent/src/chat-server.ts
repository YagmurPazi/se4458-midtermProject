import { randomBytes } from 'node:crypto';
import express, { Express, Request, Response } from 'express';
import { AgentReply } from './agent';
import { ApiError, Session, TuitionApi } from './tuition-api';

// Web front end of the agent: a static chat page plus a small JSON API.
// Each logged-in student gets their own TuitionAgent (and so their own history and pending payment),
// kept in memory and identified by an HttpOnly cookie. The page never sees the JWT, the Gemini key
// or the MCP key; the payment confirmation gate stays in TuitionAgent.

export interface ChatAgent {
  handle(text: string): Promise<AgentReply>;
}

export interface ChatServerOptions {
  api: TuitionApi;
  createAgent: (session: Session) => ChatAgent;
  /** Folder with index.html. */
  publicDir: string;
  /** Mark the session cookie Secure (behind HTTPS). */
  secureCookies?: boolean;
  maxSessions?: number;
  maxMessagesPerSession?: number;
  maxMessageLength?: number;
  idleTimeoutMs?: number;
  /** Absolute session lifetime; kept below the JWT lifetime (1 h) so a session never outlives its token. */
  maxSessionAgeMs?: number;
  now?: () => number;
}

interface ChatSession {
  studentNo: string;
  createdAt: number;
  agent: ChatAgent;
  lastSeen: number;
  messages: number;
  busy: boolean;
}

const COOKIE = 'chat_session';

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }
  return undefined;
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

export function createChatServer(options: ChatServerOptions): Express {
  const {
    api,
    createAgent,
    publicDir,
    secureCookies = false,
    maxSessions = 100,
    maxMessagesPerSession = 40,
    maxMessageLength = 1000,
    idleTimeoutMs = 30 * 60_000,
    maxSessionAgeMs = 55 * 60_000,
    now = Date.now,
  } = options;
  const sessions = new Map<string, ChatSession>();

  const removeIdleSessions = (): void => {
    for (const [id, session] of sessions) {
      if (now() - session.lastSeen > idleTimeoutMs || now() - session.createdAt > maxSessionAgeMs) {
        sessions.delete(id);
      }
    }
  };

  const currentSession = (req: Request): { id: string; session: ChatSession } | null => {
    removeIdleSessions();
    const id = readCookie(req, COOKIE);
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session) {
      return null;
    }
    session.lastSeen = now();
    return { id, session };
  };

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: secureCookies,
    path: '/',
    maxAge: idleTimeoutMs,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(publicDir));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username.trim() ||
      !password
    ) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Student number and password are required.');
      return;
    }
    removeIdleSessions();
    if (sessions.size >= maxSessions) {
      sendError(res, 503, 'TOO_MANY_SESSIONS', 'The assistant is busy. Please try again later.');
      return;
    }
    try {
      const session = await api.login(username.trim(), password);
      const id = randomBytes(24).toString('base64url');
      sessions.set(id, {
        studentNo: session.studentNo,
        agent: createAgent(session),
        createdAt: now(),
        lastSeen: now(),
        messages: 0,
        busy: false,
      });
      res.cookie(COOKIE, id, cookieOptions).json({ studentNo: session.studentNo });
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        const code = error.code === 'NOT_A_STUDENT' ? 'NOT_A_STUDENT' : 'INVALID_CREDENTIALS';
        const message =
          code === 'NOT_A_STUDENT' ? error.message : 'Invalid student number or password.';
        sendError(res, error.code === 'NOT_A_STUDENT' ? 403 : 401, code, message);
        return;
      }
      sendError(res, 502, 'LOGIN_UNAVAILABLE', 'Login is not available right now.');
    }
  });

  app.get('/api/session', (req, res) => {
    const current = currentSession(req);
    if (!current) {
      sendError(res, 401, 'NOT_LOGGED_IN', 'Please log in.');
      return;
    }
    res.json({ studentNo: current.session.studentNo });
  });

  app.post('/api/chat', async (req, res) => {
    const current = currentSession(req);
    if (!current) {
      sendError(res, 401, 'NOT_LOGGED_IN', 'Please log in.');
      return;
    }
    const { session } = current;
    const message = (req.body as { message?: unknown } | undefined)?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > maxMessageLength) {
      sendError(
        res,
        400,
        'VALIDATION_ERROR',
        `The message must be 1-${maxMessageLength} characters.`,
      );
      return;
    }
    if (session.messages >= maxMessagesPerSession) {
      sendError(
        res,
        429,
        'MESSAGE_LIMIT',
        'This session has reached its message limit. Please log in again.',
      );
      return;
    }
    if (session.busy) {
      sendError(res, 409, 'BUSY', 'Please wait for the previous answer.');
      return;
    }

    session.busy = true;
    session.messages++;
    try {
      const reply = await session.agent.handle(message.trim());
      const tokenRejected = reply.trace.steps.some(
        (step) =>
          (step.output as { error?: { status?: number } } | undefined)?.error?.status === 401,
      );
      if (tokenRejected) {
        // The JWT behind this session is no longer accepted (for example it expired): end the session.
        sessions.delete(current.id);
        res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
        sendError(res, 401, 'NOT_LOGGED_IN', 'Your login has expired. Please log in again.');
        return;
      }
      res.json({
        reply: reply.text,
        pendingPayment: reply.pendingPayment,
        confirmation: reply.trace.confirmation ?? null,
        steps: reply.trace.steps,
      });
    } catch (error) {
      console.error('Chat turn failed:', error);
      sendError(
        res,
        502,
        'ASSISTANT_UNAVAILABLE',
        'The assistant could not answer right now. Please try again.',
      );
    } finally {
      session.busy = false;
    }
  });

  app.post('/api/logout', (req, res) => {
    const id = readCookie(req, COOKIE);
    if (id) {
      sessions.delete(id);
    }
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });

  return app;
}
