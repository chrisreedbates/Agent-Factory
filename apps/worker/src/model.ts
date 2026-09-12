import { LeaseLostError, WorkerError, isRecord } from './errors.js';

export interface ModelUsage {
  modelCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}

export const EMPTY_USAGE: ModelUsage = { modelCalls: 0, inputTokens: null, outputTokens: null, cost: null };

export function addUsage(total: ModelUsage, turn: ModelUsage): ModelUsage {
  return {
    modelCalls: total.modelCalls + turn.modelCalls,
    inputTokens: turn.inputTokens === null && total.inputTokens === null ? null : (total.inputTokens ?? 0) + (turn.inputTokens ?? 0),
    outputTokens: turn.outputTokens === null && total.outputTokens === null ? null : (total.outputTokens ?? 0) + (turn.outputTokens ?? 0),
    cost: total.cost === null && turn.cost === null ? null : (total.cost ?? 0) + (turn.cost ?? 0),
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ModelTurn {
  content: string | null;
  toolCalls: ToolCall[];
  usage: ModelUsage;
}

export interface ModelAdapter {
  readonly name: string;
  /** `signal` must abort the provider request when the job lease is lost. */
  turn(input: { system: string; messages: ModelMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal }): Promise<ModelTurn>;
}

/** Tolerant JSON extraction for model replies that wrap JSON in prose or fences. */
export function extractJson<T>(text: string | null): T {
  if (!text || !text.trim()) throw new WorkerError('MODEL_OUTPUT', 'The model returned an empty response', true);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new WorkerError('MODEL_OUTPUT', 'The model did not return a JSON object', true);
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (error) {
    throw new WorkerError('MODEL_OUTPUT', `The model returned invalid JSON: ${(error as Error).message}`, true);
  }
}

export interface OpenAiConfig {
  apiKey: string | null;
  baseURL: string | null;
  model: string;
}

/** One real, configurable provider. Agent identity never depends on the provider. */
export class OpenAiAdapter implements ModelAdapter {
  readonly name: string;
  private client: any;

  constructor(private readonly config: OpenAiConfig) {
    this.name = config.model;
  }

  private async sdk(): Promise<any> {
    if (this.client) return this.client;
    if (!this.config.apiKey) {
      throw new WorkerError('MODEL_UNAVAILABLE', 'OPENAI_API_KEY is not configured; the runtime cannot invoke a real model', false);
    }
    const imported = await import('openai');
    const OpenAI = (imported as any).default ?? imported;
    this.client = new OpenAI({ apiKey: this.config.apiKey, ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}) });
    return this.client;
  }

  async turn(input: { system: string; messages: ModelMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal }): Promise<ModelTurn> {
    const client = await this.sdk();
    const messages: any[] = [{ role: 'system', content: input.system }];
    for (const message of input.messages) {
      if (message.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      } else if (message.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: message.content ?? '',
          ...(message.toolCalls.length
            ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
            : {}),
        });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }
    let response: any;
    try {
      response = await client.chat.completions.create({
        model: this.config.model,
        messages,
        ...(input.tools?.length
          ? { tools: input.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), tool_choice: 'auto' }
          : {}),
      }, input.signal ? { signal: input.signal } : undefined);
    } catch (error) {
      // Cancel local work on lease loss; provider-side processing and billing may continue.
      if (input.signal?.aborted) throw new LeaseLostError(409, 'The model request was cancelled because the job lease was lost');
      const status = (error as any)?.status;
      throw new WorkerError('MODEL_CALL_FAILED', `Model call failed: ${(error as Error).message}`, status === 429 || status >= 500);
    }
    // Some compatible providers report upstream failures inside an HTTP 200
    // response. Keep these retryable instead of treating them as model output.
    if (response?.error) {
      const detail = typeof response.error.message === 'string'
        ? response.error.message.slice(0, 500)
        : 'The provider returned an error response';
      throw new WorkerError('MODEL_CALL_FAILED', `Model call failed: ${detail}`, true);
    }
    if (!Array.isArray(response?.choices) || !isRecord(response.choices[0]?.message)) {
      throw new WorkerError('MODEL_CALL_FAILED', 'Model call failed: the provider response contained no valid message choice', true);
    }
    const choice = response.choices[0].message;
    const rawCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    const toolCalls: ToolCall[] = rawCalls.map((call: any) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parsed = {};
      }
      return { id: String(call?.id ?? ''), name: String(call?.function?.name ?? ''), arguments: isRecord(parsed) ? parsed : {} };
    });
    return {
      content: typeof choice.content === 'string' ? choice.content : null,
      toolCalls,
      usage: {
        modelCalls: 1,
        inputTokens: typeof response?.usage?.prompt_tokens === 'number' ? response.usage.prompt_tokens : null,
        outputTokens: typeof response?.usage?.completion_tokens === 'number' ? response.usage.completion_tokens : null,
        // Preserve reported cost, including free calls; never infer unknown pricing.
        cost: typeof response?.usage?.cost === 'number' && Number.isFinite(response.usage.cost) && response.usage.cost >= 0
          ? response.usage.cost
          : null,
      },
    };
  }
}

export interface ToolLoopResult {
  content: string;
  usage: ModelUsage;
  rounds: number;
}

/**
 * A bounded model/tool loop. The model may only call the tools it was granted;
 * every tool result is fed back verbatim and the loop stops at maxRounds.
 */
export async function runToolLoop(input: {
  model: ModelAdapter;
  system: string;
  prompt: string;
  tools: ToolDefinition[];
  maxRounds: number;
  handleTool: (call: ToolCall) => Promise<string>;
  onTurn?: (turn: ModelTurn) => Promise<void>;
  signal?: AbortSignal;
}): Promise<ToolLoopResult> {
  const messages: ModelMessage[] = [{ role: 'user', content: input.prompt }];
  let usage = EMPTY_USAGE;
  for (let round = 0; round < input.maxRounds; round++) {
    input.signal?.throwIfAborted();
    const turn = await input.model.turn({ system: input.system, messages, tools: input.tools, signal: input.signal });
    usage = addUsage(usage, turn.usage);
    await input.onTurn?.(turn);
    if (!turn.toolCalls.length) {
      return { content: turn.content ?? '', usage, rounds: round + 1 };
    }
    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const result = await input.handleTool(call);
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
    }
  }
  throw new WorkerError('MODEL_TOOL_LIMIT', `The model exceeded ${input.maxRounds} tool rounds`, false);
}
