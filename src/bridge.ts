import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { contextToBridgePrompt } from "./context.js";
import { parseProtocol } from "./protocol.js";
import { createNeedleRouter } from "./router.js";
import { stopAt } from "./sse.js";
import type { BridgeConfig, BridgeDelta, BridgeModel, BridgeRequest, ToolRouter } from "./types.js";

function modelConfig(model: BridgeModel) {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text" as const],
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxTokens ?? 8192,
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function initialMessage(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function applyMetadata(output: AssistantMessage, metadata: BridgeDelta, model: Model<any>): void {
  if (metadata.responseId) output.responseId = metadata.responseId;
  if (metadata.responseModel) output.responseModel = metadata.responseModel;
  if (!metadata.usage) return;
  output.usage.input = metadata.usage.input ?? output.usage.input;
  output.usage.output = metadata.usage.output ?? output.usage.output;
  output.usage.cacheRead = metadata.usage.cacheRead ?? output.usage.cacheRead;
  output.usage.cacheWrite = metadata.usage.cacheWrite ?? output.usage.cacheWrite;
  output.usage.totalTokens = metadata.usage.totalTokens
    ?? output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function emitTool(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  name: string,
  args: Record<string, unknown>,
): void {
  const toolCall = {
    type: "toolCall" as const,
    id: `pi-llm-bridge-${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
  const contentIndex = output.content.length;
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

function streamBridge<TResponse>(
  config: BridgeConfig<TResponse>,
  router: ToolRouter,
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = initialMessage(model);
    try {
      stream.push({ type: "start", partial: output });
      const prompt = contextToBridgePrompt(context, {
        ...(config.includeSystemPrompt !== undefined ? { includeSystemPrompt: config.includeSystemPrompt } : {}),
        ...(config.extraInstructions !== undefined ? { extraInstructions: config.extraInstructions } : {}),
      });
      const request: BridgeRequest = {
        prompt,
        context,
        model,
        ...(options ? { options } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options?.headers ? { headers: options.headers } : {}),
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      };
      const response = await config.request(request);
      const decoded = config.decode(response, request);
      const stopped = stopAt(decoded, config.stopSequences ?? []);
      let kind: "text" | "tool" | undefined;
      let textIndex = -1;
      let intent = "";
      let blocks = 0;
      let toolCalls = 0;
      for await (const event of parseProtocol(stopped, config.strictProtocol !== false)) {
        if (event.type === "metadata") {
          applyMetadata(output, event.metadata, model);
          continue;
        }
        if (event.type === "block_start") {
          if (kind) throw new Error("Raw model started a Pi block before closing the previous block");
          kind = event.kind;
          blocks += 1;
          if (kind === "text") {
            textIndex = output.content.length;
            output.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
          } else {
            intent = "";
          }
          continue;
        }
        if (event.type === "block_delta" && kind === "tool") {
          intent += event.delta;
          continue;
        }
        if (event.type === "block_delta" && kind === "text") {
          const block = output.content[textIndex];
          if (!block || block.type !== "text") throw new Error("Invalid Pi text block state");
          block.text += event.delta;
          stream.push({ type: "text_delta", contentIndex: textIndex, delta: event.delta, partial: output });
          continue;
        }
        if (event.type !== "block_end" || event.kind !== kind) throw new Error("Invalid Pi block state");
        if (kind === "tool") {
          const action = intent.trim();
          if (!action) throw new Error("Raw model returned an empty tool block");
          const calls = await router.route(action, context.tools ?? [], options?.signal);
          if (!calls.length) throw new Error("Needle returned no tool calls");
          for (const call of calls) {
            emitTool(stream, output, call.name, call.arguments);
            toolCalls += 1;
          }
        } else {
          const block = output.content[textIndex];
          if (!block || block.type !== "text" || !block.text.trim()) throw new Error("Raw model returned an empty text block");
          stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
        }
        kind = undefined;
      }
      if (!blocks) throw new Error("Raw model returned no Pi content blocks");
      output.stopReason = toolCalls ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export function defineBridge<TResponse>(config: BridgeConfig<TResponse>) {
  if (!config.provider.id || !config.provider.models.length) {
    throw new Error("pi-llm-bridge requires a provider id and at least one model");
  }
  const router = config.router ?? createNeedleRouter(config.needle);
  return (pi: ExtensionAPI): void => {
    pi.on("session_shutdown", () => router.close?.());
    pi.registerProvider(config.provider.id, {
      name: config.provider.name,
      baseUrl: config.provider.baseUrl ?? "https://pi-llm-bridge.invalid",
      apiKey: config.provider.apiKey ?? "pi-llm-bridge",
      authHeader: config.provider.authHeader ?? false,
      api: `pi-llm-bridge:${config.provider.id}`,
      ...(config.provider.headers ? { headers: config.provider.headers } : {}),
      models: config.provider.models.map(modelConfig),
      streamSimple: (model, context, options) => streamBridge(config, router, model, context, options),
    });
  };
}
