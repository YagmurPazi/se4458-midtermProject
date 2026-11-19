import { GeminiClient } from './llm';

// GeminiClient with the SDK call replaced by a mock: no network and no API key are used.

function client(fallbackModel?: string) {
  const sleep = jest.fn().mockResolvedValue(undefined);
  const warn = jest.fn();
  const gemini = new GeminiClient({
    apiKey: 'test-key',
    model: 'main-model',
    fallbackModel,
    systemInstruction: 'system prompt',
    tools: [],
    sleep,
    warn,
    busyUntil: new Map(),
  });
  const generateContent = jest.fn();
  (
    gemini as unknown as { ai: { models: { generateContent: jest.Mock } } }
  ).ai.models.generateContent = generateContent;
  return { gemini, generateContent, sleep, warn };
}

const textResponse = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }],
  functionCalls: undefined,
  text: 'Hello',
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10 },
};

const statusError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const modelsCalled = (mock: jest.Mock) => mock.mock.calls.map(([request]) => request.model);

describe('GeminiClient', () => {
  it('sends the system prompt and tools with automatic function calling turned off', async () => {
    const { gemini, generateContent } = client();
    generateContent.mockResolvedValue(textResponse);

    await expect(
      gemini.generate([{ role: 'user', parts: [{ text: 'Hi' }] }]),
    ).resolves.toMatchObject({
      text: 'Hello',
      functionCalls: [],
    });
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'main-model',
        config: expect.objectContaining({
          systemInstruction: 'system prompt',
          automaticFunctionCalling: { disable: true },
        }),
      }),
    );
  });

  it('retries a temporary error (503) once on the same model', async () => {
    const { gemini, generateContent, sleep } = client('backup-model');
    generateContent.mockRejectedValueOnce(statusError(503)).mockResolvedValueOnce(textResponse);

    await expect(gemini.generate([])).resolves.toMatchObject({ text: 'Hello' });
    expect(modelsCalled(generateContent)).toEqual(['main-model', 'main-model']);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('switches to the fallback model when the main model stays busy', async () => {
    const { gemini, generateContent, warn } = client('backup-model');
    generateContent
      .mockRejectedValueOnce(statusError(503))
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValueOnce(textResponse);

    await expect(gemini.generate([])).resolves.toMatchObject({ text: 'Hello' });
    expect(modelsCalled(generateContent)).toEqual(['main-model', 'main-model', 'backup-model']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using backup-model'));
  });

  it('moves to the fallback model at once after a 504 deadline error (no slow retry)', async () => {
    const { gemini, generateContent, sleep } = client('backup-model');
    generateContent.mockRejectedValueOnce(statusError(504)).mockResolvedValueOnce(textResponse);

    await gemini.generate([]);

    expect(modelsCalled(generateContent)).toEqual(['main-model', 'backup-model']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('shares the busy state between clients (one client per web chat session)', async () => {
    const busyUntil = new Map<string, number>();
    const first = new GeminiClient({
      apiKey: 'k',
      model: 'main-model',
      fallbackModel: 'backup-model',
      systemInstruction: '',
      tools: [],
      busyUntil,
      warn: jest.fn(),
    });
    const second = new GeminiClient({
      apiKey: 'k',
      model: 'main-model',
      fallbackModel: 'backup-model',
      systemInstruction: '',
      tools: [],
      busyUntil,
      warn: jest.fn(),
    });
    const firstCall = jest
      .fn()
      .mockRejectedValueOnce(statusError(504))
      .mockResolvedValue(textResponse);
    const secondCall = jest.fn().mockResolvedValue(textResponse);
    (
      first as unknown as { ai: { models: { generateContent: jest.Mock } } }
    ).ai.models.generateContent = firstCall;
    (
      second as unknown as { ai: { models: { generateContent: jest.Mock } } }
    ).ai.models.generateContent = secondCall;

    await first.generate([]);
    await second.generate([]);

    expect(modelsCalled(secondCall)).toEqual(['backup-model']);
  });

  it('skips a busy main model for the next requests (cooldown)', async () => {
    const { gemini, generateContent } = client('backup-model');
    generateContent
      .mockRejectedValueOnce(statusError(503))
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValue(textResponse);

    await gemini.generate([]);
    await gemini.generate([]);

    expect(modelsCalled(generateContent)).toEqual([
      'main-model',
      'main-model',
      'backup-model',
      'backup-model',
    ]);
  });

  it('gives up when every model stays busy', async () => {
    const { gemini, generateContent } = client('backup-model');
    generateContent.mockRejectedValue(statusError(429));

    await expect(gemini.generate([])).rejects.toThrow('HTTP 429');
    expect(generateContent).toHaveBeenCalledTimes(4);
  });

  it('does not retry a permanent error (404 unknown model)', async () => {
    const { gemini, generateContent } = client('backup-model');
    generateContent.mockRejectedValue(statusError(404));

    await expect(gemini.generate([])).rejects.toThrow('HTTP 404');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('reports token use per call, counting thinking tokens as output', async () => {
    const { gemini, generateContent } = client();
    generateContent.mockResolvedValue(textResponse);

    await expect(gemini.generate([])).resolves.toMatchObject({
      usage: { model: 'main-model', inputTokens: 120, outputTokens: 40 },
    });
  });

  it('turns an empty answer into a short apology instead of failing', async () => {
    const { gemini, generateContent } = client();
    generateContent.mockResolvedValue({ candidates: [{ content: { role: 'model', parts: [] } }] });

    await expect(gemini.generate([])).resolves.toMatchObject({
      functionCalls: [],
      text: expect.stringContaining('Sorry'),
    });
  });
});
