import { join } from 'node:path';
import request from 'supertest';
import { AgentReply } from './agent';
import { ChatAgent, createChatServer } from './chat-server';
import { ApiError, NotAStudentError, Session, TuitionApi } from './tuition-api';

// The web chat server with a fake API and fake agents: no gateway, MCP or LLM is used.

const session: Session = { accessToken: 'jwt', role: 'STUDENT', studentNo: '20230001' };

function reply(text: string, extra: Partial<AgentReply> = {}): AgentReply {
  return {
    text,
    pendingPayment: null,
    trace: {
      timestamp: '',
      studentNo: '20230001',
      user: '',
      steps: [{ tool: 'get_my_tuition', input: {}, ok: true, output: {}, durationMs: 1 }],
      answer: text,
    },
    ...extra,
  };
}

function setup(
  overrides: {
    maxMessagesPerSession?: number;
    maxSessions?: number;
    idleTimeoutMs?: number;
    maxSessionAgeMs?: number;
  } = {},
) {
  let clock = 0;
  const api = {
    login: jest.fn().mockResolvedValue(session),
    getTuition: jest.fn(),
    pay: jest.fn(),
  } satisfies TuitionApi;
  const agents: { handle: jest.Mock }[] = [];
  const createAgent = jest.fn((): ChatAgent => {
    const agent = { handle: jest.fn().mockResolvedValue(reply('Your balance is 4,500.00 USD.')) };
    agents.push(agent);
    return agent;
  });
  const app = createChatServer({
    api,
    createAgent,
    publicDir: join(__dirname, '..', 'public'),
    swaggerUrl: 'https://gateway.test/api/docs',
    now: () => clock,
    ...overrides,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { app, api, createAgent, agents, advance };
}

async function loggedIn(app: ReturnType<typeof setup>['app']) {
  const browser = request.agent(app);
  await browser
    .post('/api/login')
    .send({ username: '20230001', password: 'Student#2026' })
    .expect(200);
  return browser;
}

describe('chat server', () => {
  it('serves the chat page', async () => {
    const { app } = setup();
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('AI Tuition Assistant');
  });

  it('logs in through the API and sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const { app, api, createAgent } = setup();

    const res = await request(app)
      .post('/api/login')
      .send({ username: ' 20230001 ', password: 'Student#2026' })
      .expect(200);

    expect(res.body).toEqual({ studentNo: '20230001' });
    expect(api.login).toHaveBeenCalledWith('20230001', 'Student#2026');
    expect(createAgent).toHaveBeenCalledWith(session);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^chat_session=[\w-]{32};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(res.text).not.toContain('jwt'); // the token stays on the server
  });

  it('rejects wrong credentials and non-student accounts', async () => {
    const { app, api } = setup();
    api.login.mockRejectedValueOnce(
      new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.'),
    );
    await request(app)
      .post('/api/login')
      .send({ username: '20230001', password: 'x' })
      .expect(401, {
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid student number or password.',
      });

    api.login.mockRejectedValueOnce(new NotAStudentError('ADMIN'));
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'x' })
      .expect(403);
    expect(res.body).toEqual({
      error: 'NOT_A_STUDENT',
      role: 'ADMIN',
      message: expect.stringContaining('Welcome, admin!'),
      swaggerUrl: 'https://gateway.test/api/docs',
    });
    expect(res.headers['set-cookie']).toBeUndefined(); // no chat session for staff accounts

    await request(app).post('/api/login').send({ username: '', password: '' }).expect(400);
  });

  it('answers chat messages with the reply and the tool trace', async () => {
    const { app, agents } = setup();
    const browser = await loggedIn(app);

    const res = await browser
      .post('/api/chat')
      .send({ message: 'What is my balance?' })
      .expect(200);

    expect(agents[0].handle).toHaveBeenCalledWith('What is my balance?');
    expect(res.body).toEqual({
      reply: 'Your balance is 4,500.00 USD.',
      pendingPayment: null,
      confirmation: null,
      steps: [{ tool: 'get_my_tuition', input: {}, ok: true, output: {}, durationMs: 1 }],
    });
  });

  it('returns the pending payment so the page can show the confirmation buttons', async () => {
    const { app, agents } = setup();
    const browser = await loggedIn(app);
    const pendingPayment = {
      studentNo: '20230001',
      term: '2026-FALL',
      amount: 500,
      currentBalance: 1500,
    };
    agents[0].handle.mockResolvedValueOnce(
      reply('Please confirm this payment', { pendingPayment }),
    );

    const res = await browser
      .post('/api/chat')
      .send({ message: 'Pay 500 for Fall 2026' })
      .expect(200);

    expect(res.body.pendingPayment).toEqual(pendingPayment);
  });

  it('keeps one agent per session, so students never share a conversation', async () => {
    const { app, agents } = setup();
    const first = await loggedIn(app);
    const second = await loggedIn(app);

    await first.post('/api/chat').send({ message: 'one' });
    await second.post('/api/chat').send({ message: 'two' });

    expect(agents).toHaveLength(2);
    expect(agents[0].handle).toHaveBeenCalledWith('one');
    expect(agents[1].handle).toHaveBeenCalledWith('two');
  });

  it('refuses chat without a session and after logout', async () => {
    const { app } = setup();
    await request(app).post('/api/chat').send({ message: 'hi' }).expect(401);

    const browser = await loggedIn(app);
    await browser.get('/api/session').expect(200, { studentNo: '20230001' });
    await browser.post('/api/logout').send({}).expect(200);
    await browser.post('/api/chat').send({ message: 'hi' }).expect(401);
  });

  it('ends a session after the idle timeout', async () => {
    const { app, advance } = setup({ idleTimeoutMs: 1000 });
    const browser = await loggedIn(app);

    advance(1001);

    await browser.get('/api/session').expect(401);
  });

  it('ends a session after its maximum age even while it is used', async () => {
    const { app, advance } = setup({ idleTimeoutMs: 1000, maxSessionAgeMs: 2500 });
    const browser = await loggedIn(app);

    for (let i = 0; i < 3; i++) {
      advance(900);
      await browser.get('/api/session');
    }

    await browser.get('/api/session').expect(401);
  });

  it('ends the session when the API rejects its token (expired JWT)', async () => {
    const { app, agents } = setup();
    const browser = await loggedIn(app);
    agents[0].handle.mockResolvedValueOnce(
      reply('I could not read your account.', {
        trace: {
          timestamp: '',
          studentNo: '20230001',
          user: '',
          answer: '',
          steps: [
            {
              tool: 'get_my_tuition',
              input: {},
              ok: false,
              output: { error: { status: 401, code: 'HTTP_401' } },
              durationMs: 1,
            },
          ],
        },
      }),
    );

    const res = await browser.post('/api/chat').send({ message: 'balance?' }).expect(401);

    expect(res.body.error).toBe('NOT_LOGGED_IN');
    await browser.get('/api/session').expect(401);
  });

  it('validates messages and enforces the per-session message limit', async () => {
    const { app } = setup({ maxMessagesPerSession: 1 });
    const browser = await loggedIn(app);

    await browser.post('/api/chat').send({ message: '   ' }).expect(400);
    await browser
      .post('/api/chat')
      .send({ message: 'x'.repeat(1001) })
      .expect(400);
    await browser.post('/api/chat').send({ message: 'first' }).expect(200);
    const res = await browser.post('/api/chat').send({ message: 'second' }).expect(429);
    expect(res.body.error).toBe('MESSAGE_LIMIT');
  });

  it('limits the number of open sessions', async () => {
    const { app } = setup({ maxSessions: 1 });
    await loggedIn(app);

    const res = await request(app)
      .post('/api/login')
      .send({ username: '20230002', password: 'x' })
      .expect(503);
    expect(res.body.error).toBe('TOO_MANY_SESSIONS');
  });

  it('reports an unavailable assistant without leaking internal errors', async () => {
    const { app, agents } = setup();
    const browser = await loggedIn(app);
    agents[0].handle.mockRejectedValueOnce(new Error('Gemini 503 secret details'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await browser.post('/api/chat').send({ message: 'hi' }).expect(502);

    expect(res.body.error).toBe('ASSISTANT_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
