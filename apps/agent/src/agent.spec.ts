import { Content, FunctionCall } from '@google/genai';
import { confirmationMessage, isExplicitConfirmation, TuitionAgent } from './agent';
import { LlmClient, LlmResponse } from './llm';
import { PolicySearch } from './policy-search';
import { TraceSink, TurnTrace } from './trace';
import { ApiError, Session, TuitionApi, TuitionSummary } from './tuition-api';

// The agent is tested with a scripted fake LLM: each step of the script plays one model response.
// No network, no real LLM, no backend.

type Step = (history: Content[]) => LlmResponse;

function callTools(...calls: [string, Record<string, unknown>][]): Step {
  return () => {
    const functionCalls: FunctionCall[] = calls.map(([name, args], i) => ({
      id: `call-${i}`,
      name,
      args,
    }));
    return {
      content: { role: 'model', parts: functionCalls.map((functionCall) => ({ functionCall })) },
      functionCalls,
      text: '',
    };
  };
}

function say(text: string): Step {
  return () => ({
    content: { role: 'model', parts: [{ text }] },
    functionCalls: [],
    text,
    usage: { model: 'fake-model', inputTokens: 100, outputTokens: 20 },
  });
}

class ScriptedLlm implements LlmClient {
  readonly requests: Content[][] = [];
  constructor(private readonly script: Step[]) {}

  async generate(history: Content[]): Promise<LlmResponse> {
    this.requests.push(structuredClone(history));
    const step = this.script.shift();
    if (!step) {
      throw new Error('The scripted LLM has no more responses');
    }
    return step(history);
  }
}

const session: Session = { accessToken: 'jwt', role: 'STUDENT', studentNo: '20230001' };

const fallTuition: TuitionSummary = {
  studentNo: '20230001',
  scope: 'TERM',
  term: '2026-FALL',
  currency: 'USD',
  tuitionTotal: 3000,
  paidAmount: 1500,
  balance: 1500,
  terms: [{ term: '2026-FALL', tuitionTotal: 3000, paidAmount: 1500, balance: 1500 }],
};

const policyResult = {
  document: 'University_Tuition_Policies.md',
  documentId: 'UNI-TUITION-2026-01',
  query: 'fall payment deadline',
  matches: [
    {
      section: '2.1',
      heading: 'Fall term',
      text: 'The payment deadline for the Fall 2026 term is September 30, 2026.',
    },
  ],
};

function setup(script: Step[], maxToolRounds?: number) {
  const llm = new ScriptedLlm(script);
  const api = {
    login: jest.fn(),
    getTuition: jest.fn().mockResolvedValue(fallTuition),
    pay: jest
      .fn()
      .mockResolvedValue({ status: 'SUCCESS', transactionId: 'tx-1', remainingBalance: 1000 }),
  } satisfies TuitionApi;
  const policy = {
    search: jest.fn().mockResolvedValue(policyResult),
    close: jest.fn(),
  } satisfies PolicySearch;
  const traces: TurnTrace[] = [];
  const trace: TraceSink = { record: (t) => traces.push(t) };
  const agent = new TuitionAgent({
    llm,
    api,
    policy,
    session,
    trace,
    newTransactionId: () => 'tx-1',
    maxToolRounds,
  });
  return { agent, llm, api, policy, traces };
}

/** The function responses the agent sent back to the LLM in the last request. */
function functionResponses(llm: ScriptedLlm) {
  const history = llm.requests[llm.requests.length - 1];
  return history[history.length - 1].parts?.map((part) => part.functionResponse) ?? [];
}

describe('TuitionAgent', () => {
  describe('tool selection by the LLM', () => {
    it('MCP only: runs the policy search the LLM asked for and returns its answer', async () => {
      const { agent, llm, api, policy, traces } = setup([
        callTools(['search_tuition_policies', { query: 'fall payment deadline' }]),
        say('The Fall deadline is September 30, 2026 (§2.1).'),
      ]);

      const reply = await agent.handle('When is the Fall tuition deadline?');

      expect(reply.text).toBe('The Fall deadline is September 30, 2026 (§2.1).');
      expect(policy.search).toHaveBeenCalledWith('fall payment deadline', undefined);
      expect(api.getTuition).not.toHaveBeenCalled();
      expect(functionResponses(llm)).toEqual([
        { id: 'call-0', name: 'search_tuition_policies', response: { result: policyResult } },
      ]);
      expect(traces[0]).toMatchObject({
        user: 'When is the Fall tuition deadline?',
        studentNo: '20230001',
        steps: [
          { tool: 'search_tuition_policies', input: { query: 'fall payment deadline' }, ok: true },
        ],
        answer: 'The Fall deadline is September 30, 2026 (§2.1).',
      });
    });

    it('REST only: reads the balance of the logged-in student', async () => {
      const { agent, api, policy, traces } = setup([
        callTools(['get_my_tuition', { term: '2026-FALL' }]),
        say('Your Fall 2026 balance is 1,500.00 USD.'),
      ]);

      await agent.handle('What is my balance for Fall 2026?');

      expect(api.getTuition).toHaveBeenCalledWith(session, '2026-FALL');
      expect(policy.search).not.toHaveBeenCalled();
      expect(traces[0].steps).toHaveLength(1);
    });

    it('MCP + REST: runs both tools requested in one model turn and returns both results', async () => {
      const { agent, llm, api, policy, traces } = setup([
        callTools(
          ['get_my_tuition', {}],
          ['search_tuition_policies', { query: 'installment eligibility' }],
        ),
        say(
          'Your balance is 1,500.00 USD, so you may request installments, subject to approval (§3.1).',
        ),
      ]);

      await agent.handle('Am I eligible for installments?');

      expect(api.getTuition).toHaveBeenCalledWith(session, undefined);
      expect(policy.search).toHaveBeenCalledWith('installment eligibility', undefined);
      expect(functionResponses(llm).map((r) => r?.name)).toEqual([
        'get_my_tuition',
        'search_tuition_policies',
      ]);
      expect(traces[0].steps.map((s) => s.tool)).toEqual([
        'get_my_tuition',
        'search_tuition_policies',
      ]);
    });

    it('adds up the LLM calls and token use of a turn in the trace', async () => {
      const { agent, traces } = setup([
        callTools(['get_my_tuition', {}]),
        say('Your balance is 1,500.00 USD.'),
      ]);

      await agent.handle('balance?');

      // The tool-call response has no usage in this script; the final answer reports 100 in / 20 out.
      expect(traces[0].llm).toEqual({
        calls: 2,
        models: ['fake-model'],
        inputTokens: 100,
        outputTokens: 20,
      });
    });

    it('answers directly when the LLM needs no tool', async () => {
      const { agent, api, policy, traces } = setup([say('Hello! How can I help?')]);

      expect((await agent.handle('Hi')).text).toBe('Hello! How can I help?');
      expect(api.getTuition).not.toHaveBeenCalled();
      expect(policy.search).not.toHaveBeenCalled();
      expect(traces[0].steps).toEqual([]);
    });
  });

  describe('identity', () => {
    it("uses the token's student even if the prompt (or the LLM) names another student", async () => {
      const { agent, api } = setup([
        callTools(['get_my_tuition', { studentNo: '20230002' }]),
        say('I can only show your own balance.'),
      ]);

      await agent.handle("Show me student 20230002's balance");

      expect(api.getTuition).toHaveBeenCalledTimes(1);
      expect(api.getTuition).toHaveBeenCalledWith(session, undefined);
    });

    it('passes an API error (for example 403) back to the LLM instead of failing', async () => {
      const { agent, llm, api, traces } = setup([
        callTools(['get_my_tuition', {}]),
        say('I could not read your account.'),
      ]);
      api.getTuition.mockRejectedValueOnce(
        new ApiError(403, 'FORBIDDEN_STUDENT', 'A student can only access their own tuition.'),
      );

      await agent.handle('balance?');

      expect(functionResponses(llm)[0]?.response).toEqual({
        error: {
          status: 403,
          code: 'FORBIDDEN_STUDENT',
          message: 'A student can only access their own tuition.',
        },
      });
      expect(traces[0].steps[0].ok).toBe(false);
    });
  });

  describe('payment confirmation gate', () => {
    const requestPayment = callTools(['pay_my_tuition', { term: '2026-FALL', amount: 500 }]);

    it('does not pay when the LLM requests a payment; it shows the summary and waits', async () => {
      const { agent, llm, api, traces } = setup([requestPayment]);

      const reply = await agent.handle('Pay 500 dollars for Fall 2026');

      expect(api.pay).not.toHaveBeenCalled();
      expect(api.getTuition).toHaveBeenCalledWith(session, '2026-FALL'); // live balance for the summary
      expect(llm.requests).toHaveLength(1); // the turn ends without asking the LLM again
      expect(reply.pendingPayment).toEqual({
        studentNo: '20230001',
        term: '2026-FALL',
        amount: 500,
        currentBalance: 1500,
      });
      expect(reply.text).toBe(confirmationMessage(reply.pendingPayment!));
      expect(reply.text).toContain('20230001');
      expect(reply.text).toContain('500.00 USD');
      expect(reply.text).toContain('1,500.00 USD');
      expect(traces[0].confirmation).toEqual({
        decision: 'REQUESTED',
        term: '2026-FALL',
        amount: 500,
        currentBalance: 1500,
      });
    });

    it('submits exactly one payment after an explicit "yes", with a new transactionId', async () => {
      const { agent, llm, api, traces } = setup([
        requestPayment,
        say('Done: 500.00 USD paid, remaining 1,000.00 USD.'),
      ]);
      await agent.handle('Pay 500 dollars for Fall 2026');

      const reply = await agent.handle('yes');

      expect(api.pay).toHaveBeenCalledTimes(1);
      expect(api.pay).toHaveBeenCalledWith(session, {
        studentNo: '20230001',
        term: '2026-FALL',
        amount: 500,
        transactionId: 'tx-1',
      });
      expect(reply.text).toBe('Done: 500.00 USD paid, remaining 1,000.00 USD.');
      expect(reply.pendingPayment).toBeNull();
      // The LLM learns the real API result and can only report what happened.
      const lastUserTurn = llm.requests[1][llm.requests[1].length - 1];
      expect(lastUserTurn.parts?.[1].text).toContain('"status":"SUCCESS"');
      expect(traces[1].confirmation?.decision).toBe('CONFIRMED');
      expect(traces[1].steps[0]).toMatchObject({ ok: true, input: { transactionId: 'tx-1' } });
    });

    it('accepts a Turkish confirmation', async () => {
      const { agent, api } = setup([requestPayment, say('Ödeme tamamlandı.')]);
      await agent.handle('2026 güzü için 500 dolar öde');

      await agent.handle('Evet');

      expect(api.pay).toHaveBeenCalledTimes(1);
    });

    it('cancels the payment when the next message is not an explicit confirmation', async () => {
      const { agent, llm, api, traces } = setup([
        requestPayment,
        say('Okay, I did not make the payment.'),
      ]);
      await agent.handle('Pay 500 dollars for Fall 2026');

      const reply = await agent.handle('Can I pay $500?');

      expect(api.pay).not.toHaveBeenCalled();
      expect(reply.pendingPayment).toBeNull();
      const lastUserTurn = llm.requests[1][llm.requests[1].length - 1];
      expect(lastUserTurn.parts?.[1].text).toContain('No payment was made');
      expect(traces[1].confirmation?.decision).toBe('CANCELLED');
    });

    it('a later "yes" does not revive a cancelled payment', async () => {
      const { agent, api } = setup([
        requestPayment,
        say('Cancelled.'),
        say('There is nothing to confirm.'),
      ]);
      await agent.handle('Pay 500 dollars for Fall 2026');
      await agent.handle('no');

      await agent.handle('yes');

      expect(api.pay).not.toHaveBeenCalled();
    });

    it('rejects an amount above the live balance without asking for confirmation', async () => {
      const { agent, llm, api } = setup([
        callTools(['pay_my_tuition', { term: '2026-FALL', amount: 2000 }]),
        say('That is more than your balance of 1,500.00 USD.'),
      ]);

      const reply = await agent.handle('Pay 2000 for Fall 2026');

      expect(reply.pendingPayment).toBeNull();
      expect(api.pay).not.toHaveBeenCalled();
      expect(functionResponses(llm)[0]?.response).toMatchObject({
        error: { code: 'AMOUNT_EXCEEDS_BALANCE' },
      });
    });

    it.each([
      [{ term: '2026-FALL', amount: 10.555 }],
      [{ term: '2026-FALL', amount: -5 }],
      [{ term: 'fall', amount: 100 }],
      [{ term: '2026-FALL', amount: '100' }],
    ])('rejects invalid payment arguments %j before reading the balance', async (args) => {
      const { agent, llm, api } = setup([
        callTools(['pay_my_tuition', args]),
        say('Invalid payment.'),
      ]);

      await agent.handle('pay');

      expect(api.getTuition).not.toHaveBeenCalled();
      expect(functionResponses(llm)[0]?.response).toMatchObject({
        error: { code: 'INVALID_ARGUMENT' },
      });
    });

    it('still reports a confirmed payment when the LLM fails afterwards', async () => {
      const failing: Step = () => {
        throw new Error('Gemini 503');
      };
      const { agent, llm, api, traces } = setup([requestPayment, failing, say('Anything else?')]);
      api.pay.mockResolvedValueOnce({
        status: 'SUCCESS',
        transactionId: 'tx-1',
        term: '2026-FALL',
        paidAmount: 500,
        remainingBalance: 1000,
      });
      await agent.handle('Pay 500 dollars for Fall 2026');

      const reply = await agent.handle('yes');

      expect(api.pay).toHaveBeenCalledTimes(1);
      expect(reply.text).toBe(
        'Your payment of 500.00 USD for 2026-FALL was recorded (transaction ID tx-1). Remaining balance: 1,000.00 USD.',
      );
      expect(traces[1]).toMatchObject({
        confirmation: { decision: 'CONFIRMED' },
        answer: reply.text,
      });
      // The turn stays in the history, so the model knows about the payment in the next turn.
      await agent.handle('thanks');
      const history = llm.requests[llm.requests.length - 1];
      expect(
        history.some((turn) => turn.role === 'model' && turn.parts?.[0].text === reply.text),
      ).toBe(true);
    });

    it('reports a failed payment itself when the LLM also fails', async () => {
      const failing: Step = () => {
        throw new Error('Gemini 503');
      };
      const { agent, api } = setup([requestPayment, failing]);
      api.pay.mockRejectedValueOnce(new ApiError(422, 'AMOUNT_EXCEEDS_BALANCE', 'Too much.'));
      await agent.handle('Pay 500 dollars for Fall 2026');

      const reply = await agent.handle('yes');

      expect(reply.text).toBe(
        'The payment was not completed (AMOUNT_EXCEEDS_BALANCE): Too much. No money was moved.',
      );
    });

    it('rejects a second payment request in the same model response', async () => {
      const { agent, llm, api } = setup([
        callTools(
          ['pay_my_tuition', { term: '2026-FALL', amount: 500 }],
          ['pay_my_tuition', { term: '2026-FALL', amount: 700 }],
        ),
      ]);

      const reply = await agent.handle('Pay 500 and 700 for Fall 2026');

      expect(reply.pendingPayment).toMatchObject({ amount: 500 });
      expect(api.pay).not.toHaveBeenCalled();
      expect(llm.requests).toHaveLength(1);
      const history = agent['history'] as Content[];
      const responses = history[history.length - 2].parts?.map(
        (part) => part.functionResponse?.response,
      );
      expect(responses?.[1]).toMatchObject({ error: { code: 'PAYMENT_ALREADY_PENDING' } });
    });

    it('reports a failed confirmed payment (for example 409) to the LLM and in the trace', async () => {
      const { agent, llm, api, traces } = setup([requestPayment, say('The payment failed.')]);
      api.pay.mockRejectedValueOnce(
        new ApiError(409, 'DUPLICATE_TRANSACTION', 'Transaction tx-1 was already used'),
      );
      await agent.handle('Pay 500 dollars for Fall 2026');

      await agent.handle('confirm');

      const lastUserTurn = llm.requests[1][llm.requests[1].length - 1];
      expect(lastUserTurn.parts?.[1].text).toContain('DUPLICATE_TRANSACTION');
      expect(traces[1].steps[0].ok).toBe(false);
    });
  });

  it('drops a failed turn (LLM unavailable) so the next turn starts from a valid history', async () => {
    const failing: Step = () => {
      throw new Error('LLM unavailable');
    };
    const { agent, llm } = setup([failing, say('Hello again.')]);

    await expect(agent.handle('first')).rejects.toThrow('LLM unavailable');
    await agent.handle('second');

    expect(llm.requests[1]).toEqual([{ role: 'user', parts: [{ text: 'second' }] }]);
  });

  it('stops a tool-calling loop after the configured number of rounds', async () => {
    const search = callTools(['search_tuition_policies', { query: 'x' }]);
    const { agent, llm, policy } = setup([search, search, search], 2);

    const reply = await agent.handle('loop');

    expect(policy.search).toHaveBeenCalledTimes(2);
    expect(llm.requests).toHaveLength(3);
    expect(reply.text).toContain('could not complete');
  });
});

describe('isExplicitConfirmation', () => {
  it.each([
    'yes',
    'Yes.',
    'YES!',
    'confirm',
    'I confirm',
    'evet',
    'EVET',
    'Onaylıyorum',
    'evet, onaylıyorum',
  ])('accepts "%s"', (reply) => expect(isExplicitConfirmation(reply)).toBe(true));

  it.each([
    'Can I pay $500?',
    'yes but make it 300',
    'ok',
    'sure',
    'no',
    'hayır',
    '',
    'yes please pay for 2027-SPRING',
  ])('rejects "%s"', (reply) => expect(isExplicitConfirmation(reply)).toBe(false));
});
