import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  contextToBridgePrompt,
  contextToBridgePromptWithHistory,
  flattenTools,
  messageToText,
} from "../src/context.js";

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
  assert.match(prompt, /```text/);
  assert.match(prompt, /```tool/);
  assert.match(prompt, /AGENTS\.md content.*input data/);
  assert.match(prompt, /<pi_instructions input_only>/);
  assert.match(prompt, /<conversation input_only>/);
  assert.match(prompt, /Keep changes small/);
  assert.match(prompt, /completed request bash/);
  assert.match(prompt, /203\.0\.113\.4/);
  assert.match(prompt, /Live Pi tool schemas \(YAML\)/);
  assert.match(prompt, /tool: bash/);
  assert.match(prompt, /parameters:\n\s+type: object/);
  assert.match(prompt, /command:\n\s+type: string/);
});

test("flattens TypeBox tool schemas for Needle", () => {
  const tools = flattenTools([{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }) }]);
  assert.deepEqual(tools[0]?.parameters, {
    path: { type: "string", description: "", required: true },
    offset: { type: "number", description: "", required: false },
  });
});

test("renders individual messages for provider history", () => {
  assert.equal(messageToText({ role: "user", content: "hello", timestamp: 1 }), "hello");
  assert.equal(messageToText({
    role: "toolResult",
    toolCallId: "1",
    toolName: "read",
    content: [{ type: "text", text: "file content" }],
    isError: false,
    timestamp: 2,
  }), "TOOL read result:\nfile content");
});

test("moves prior Pi messages into provider history", () => {
  const payload = contextToBridgePromptWithHistory({
    systemPrompt: "Keep it concise.",
    tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
    messages: [
      { role: "user", content: "My secret is pineapple.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Understood." }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: "What was it?", timestamp: 3 },
    ],
  });
  assert.deepEqual(payload.history, [
    { role: "user", content: "My secret is pineapple." },
    { role: "assistant", content: "Understood." },
  ]);
  assert.match(payload.message, /USER:\nWhat was it\?/);
  assert.doesNotMatch(payload.message, /pineapple/);
  assert.match(payload.message, /Live Pi tool schemas/);
});

test("teaches the raw write payload envelope only when write is available", () => {
  const writePrompt = contextToBridgePrompt({
    messages: [],
    tools: [{ name: "write", description: "Write a file", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
  });
  const bashPrompt = contextToBridgePrompt({
    messages: [],
    tools: [{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) }],
  });
  assert.match(writePrompt, /payloadArgument: exact_live_parameter_name_for_file_content/);
  assert.match(writePrompt, /raw file content starts here with no YAML indentation/);
  assert.match(writePrompt, /Never put a tool fence inside a text fence/);
  assert.match(writePrompt, /longer outer fence is exclusive to a write payload/);
  assert.doesNotMatch(bashPrompt, /payloadArgument/);
});
