import { Content, FunctionCall, FunctionCallingConfigMode, FunctionDeclaration, GoogleGenAI } from '@google/genai';

// The agent talks to the LLM only through this interface, so tests can use a scripted fake LLM.

export interface LlmResponse {
  /** The model turn, appended to the conversation history as-is. */
  content: Content;
  /** Tools the model asks the agent to run (empty when it answers directly). */
  functionCalls: FunctionCall[];
  text: string;
}

export interface LlmClient {
  generate(history: Content[]): Promise<LlmResponse>;
}

/** Google Gemini with function calling. The SDK's automatic function calling is off: the agent runs every tool. */
export class GeminiClient implements LlmClient {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly systemInstruction: string,
    private readonly tools: FunctionDeclaration[],
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(history: Content[]): Promise<LlmResponse> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: history,
      config: {
        systemInstruction: this.systemInstruction,
        tools: [{ functionDeclarations: this.tools }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        automaticFunctionCalling: { disable: true },
        temperature: 0.2,
      },
    });

    const content = response.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      // For example a blocked or empty answer; keep the history valid with a short model turn.
      const text = 'Sorry, I could not produce an answer. Please rephrase your question.';
      return { content: { role: 'model', parts: [{ text }] }, functionCalls: [], text };
    }
    return {
      content: { ...content, role: 'model' },
      functionCalls: response.functionCalls ?? [],
      text: response.text ?? '',
    };
  }
}
