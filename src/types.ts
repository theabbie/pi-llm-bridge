import type {
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";

export type MaybePromise<T> = T | Promise<T>;

export interface BridgeModel {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface BridgeProvider {
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models: BridgeModel[];
}

export interface BridgeRequest {
  prompt: string;
  context: Context;
  model: Model<any>;
  signal?: AbortSignal;
  apiKey?: string;
  headers?: ProviderHeaders;
  timeoutMs?: number;
  sessionId?: string;
  options?: SimpleStreamOptions;
}

export interface BridgeDelta {
  text?: string;
  usage?: Partial<Omit<Usage, "cost">>;
  responseId?: string;
  responseModel?: string;
}

export type BridgeChunk = string | BridgeDelta;

export interface NeedleModelConfig {
  repo?: string;
  revision?: string;
  filename?: string;
  maxTokens?: number;
}

export interface ToolCallShape {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolRouter {
  route(intent: string, tools: Tool[], signal?: AbortSignal): Promise<ToolCallShape[]>;
  close?(): void;
}

export interface BridgeConfig<TResponse> {
  provider: BridgeProvider;
  request(input: BridgeRequest): MaybePromise<TResponse>;
  decode(response: TResponse, input: BridgeRequest): AsyncIterable<BridgeChunk>;
  stopSequences?: string[];
  includeSystemPrompt?: boolean;
  extraInstructions?: string;
  strictProtocol?: boolean;
  router?: ToolRouter;
  needle?: NeedleModelConfig;
}
