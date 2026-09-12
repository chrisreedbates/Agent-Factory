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

/** A provider attempt failed after dispatch; retain billable usage for settlement. */
export class ModelCallError extends WorkerError {
  constructor(message: string, retryable: boolean, public readonly usage: ModelUsage) {
    super('MODEL_CALL_FAILED', message, retryable);
  }
}

function reportedUsage(value: any): ModelUsage {
  const tokens = (count: unknown): number | null =>
    typeof count === 'number' && Number.isFinite(count) && Number.isInteger(count) && count >= 0 ? count : null;
  return {
    modelCalls: 1,
    inputTokens: tokens(value?.prompt_tokens),
    outputTokens: tokens(value?.completion_tokens),
    cost: typeof value?.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : null,
  };
}

/** Structured provider codes take precedence over generic transport statuses. */
function transientProviderFailure(value: any): boolean {
  const nested = value?.error;
  const codes = [value?.code, value?.type, nested?.code, nested?.type]
    .filter((code): code is string => typeof code === 'string').map(code => code.toLowerCase());
  const permanent = new Set(['invalid_api_key', 'authentication_error', 'permission_denied', 'permission_error',
    'model_not_found', 'invalid_model', 'invalid_request_error', 'invalid_request', 'insufficient_quota',
    'insufficient_credits', 'billing_error', 'configuration_error', 'unsupported_model']);
  if (codes.some(code => permanent.has(code))) return false;
  const statusValue = value?.status ?? value?.status_code ?? nested?.status ?? nested?.status_code
    ?? (typeof value?.code === 'number' || (typeof value?.code === 'string' && /^\d{3}$/.test(value.code)) ? value.code : undefined)
    ?? (typeof nested?.code === 'number' || (typeof nested?.code === 'string' && /^\d{3}$/.test(nested.code)) ? nested.code : undefined);
  const status = typeof statusValue === 'string' && /^\d{3}$/.test(statusValue) ? Number(statusValue) : statusValue;
  if (typeof status === 'number' && status >= 400 && status < 500 && ![408, 409, 429].includes(status)) return false;
  const transient = new Set(['rate_limit_exceeded', 'rate_limit_error', 'overloaded_error', 'server_error',
    'internal_server_error', 'service_unavailable', 'temporarily_unavailable', 'timeout', 'request_timeout',
    'etimedout', 'econnreset', 'econnrefused', 'eai_again', 'enetunreach', 'epipe']);
  return [408, 409, 429].includes(status) || (status >= 500 && status < 600)
    || codes.some(code => transient.has(code))
    || ['APIConnectionError', 'APIConnectionTimeoutError'].includes(value?.name);
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
    this.client = new OpenAI({ maxRetries: 0, apiKey: this.config.apiKey, ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}) });
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
      throw new ModelCallError(`Model call failed: ${(error as Error).message}`, transientProviderFailure(error),
        reportedUsage((error as any)?.usage ?? (error as any)?.error?.usage));
    }
    // Compatible providers can return permanent or transient errors inside HTTP 200.
    const usage = reportedUsage(response?.usage ?? response?.error?.usage);
    if (response?.error) {
      const detail = typeof response.error.message === 'string'
        ? response.error.message.slice(0, 500)
        : 'The provider returned an error response';
      throw new ModelCallError(`Model call failed: ${detail}`, transientProviderFailure(response), usage);
    }
    if (!Array.isArray(response?.choices) || !isRecord(response.choices[0]?.message)) {
      throw new ModelCallError('Model call failed: the provider response contained no valid message choice', true, usage);
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
      usage,
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
