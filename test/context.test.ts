import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { contextToBridgePrompt, flattenTools } from "../src/context.js";

test("renders Pi context and tool history", () => {
  const prompt = contextToBridgePrompt({
    systemPrompt: "Keep changes small.",
    tools: [{ name: "bash", description: "Run shell commands", parameters: Type.Object({ command: Type.String() }) }],
    messages: [
      { role: "user", content: "Find my IP", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "curl ip.test" } }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "203.0.113.4" }], isError: false, timestamp: 3 },
    ],
  });
  assert.match(prompt, /<<<PI_TEXT>>>/);
  assert.match(prompt, /<<<PI_TOOL>>>/);
  assert.match(prompt, /AGENTS\.md content.*input data/);
  assert.match(prompt, /<pi_instructions input_only>/);
  assert.match(prompt, /<conversation input_only>/);
  assert.match(prompt, /Keep changes small/);
  assert.match(prompt, /completed request bash/);
  assert.match(prompt, /203\.0\.113\.4/);
});

test("flattens TypeBox tool schemas for Needle", () => {
  const tools = flattenTools([{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }) }]);
  assert.deepEqual(tools[0]?.parameters, {
    path: { type: "string", description: "", required: true },
    offset: { type: "number", description: "", required: false },
  });
});
