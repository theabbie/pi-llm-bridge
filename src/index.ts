export { defineBridge } from "./bridge.js";
export {
  contextToBridgePrompt,
  contextToBridgePromptWithHistory,
  flattenTools,
  messageToText,
} from "./context.js";
export { parseProtocol } from "./protocol.js";
export { createNeedleRouter } from "./router.js";
export { expectOk, jsonLines, sse, sseJson, stopAt } from "./sse.js";
export { prepareModel, prepareRuntime, runtimeStatus } from "./runtime.js";
export type {
  BridgeChunk,
  BridgeConfig,
  BridgeDelta,
  BridgeModel,
  BridgeProvider,
  BridgeRequest,
  NeedleModelConfig,
  ToolCallShape,
  ToolRouter,
} from "./types.js";
