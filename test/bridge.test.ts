import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import test from "node:test";
import { Type } from "typebox";
import { defineBridge } from "../src/bridge.js";
import type { ToolRouter } from "../src/types.js";

function setup(output: string, router?: ToolRouter) {
  let provider: any;
  const extension = defineBridge({
    provider: { id: "raw", name: "Raw", models: [{ id: "chat", name: "Chat" }] },
    request: async ({ prompt }) => prompt,
    decode: async function* () { yield output; },
    ...(router ? { router } : {}),
  });
  extension({ on: () => {}, registerProvider: (_id: string, value: any) => provider = value } as any);
  const model = {
    id: "chat",
    name: "Chat",
    provider: "raw",
    api: "pi-llm-bridge:raw",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return { provider, model };
}

test("emits Pi text lifecycle events", async () => {
  const { provider, model } = setup("<<<PI_TEXT>>>\nhello from raw\n<<<PI_END>>>");
  const stream = provider.streamSimple(model, { messages: [] });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.equal(events.at(-1).message.content[0].text, "hello from raw");
});

test("silently completes when strict output contains no valid blocks", async () => {
  const { provider, model } = setup("unframed text\n<<<<PI_TOOL>>>\nls -la");
  const stream = provider.streamSimple(model, { messages: [] });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
  assert.deepEqual(events.at(-1).message.content, []);
});

test("silently ignores empty text blocks", async () => {
  const { provider, model } = setup("<<<PI_TEXT>>>\n  \n<<<PI_END>>>");
  const stream = provider.streamSimple(model, { messages: [] });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
  assert.deepEqual(events.at(-1).message.content, []);
});

test("turns routing failures into one-shot feedback", async () => {
  const router: ToolRouter = {
    async route() {
      throw new Error("bad generated arguments");
    },
  };
  const { provider, model } = setup(
    "<<<PI_TOOL>>>\ntool: bash\narguments:\n  command: broken\n<<<PI_END>>>",
    router,
  );
  const stream = provider.streamSimple(model, {
    messages: [],
    tools: [{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) }],
  });
  const events = [];
  try {
    for await (const event of stream) events.push(event);
    const call = events.at(-1).message.content[0];
    assert.equal(call.name, "bash");
    assert.equal(call.arguments.command, "cat -- last_output_feedback.log && : > last_output_feedback.log");
    const feedback = await readFile("last_output_feedback.log", "utf8");
    assert.match(feedback, /tool: bash/);
    assert.match(feedback, /bad generated arguments/);
  } finally {
    await unlink("last_output_feedback.log").catch(() => {});
  }
});

test("emits interleaved text and multiple Pi tool calls", async () => {
  const intents: string[] = [];
  const router: ToolRouter = {
    async route(value) {
      intents.push(value);
      return [{ name: "bash", arguments: { command: value.includes("pwd") ? "pwd" : "date" } }];
    },
  };
  const { provider, model } = setup(
    "<<<PI_TEXT>>>\nI will check both.\n<<<PI_END>>>\n" +
    "<<<PI_TOOL>>>\nrun pwd\n<<<PI_END>>>\n" +
    "<<<PI_TOOL>>>\nrun date\n<<<PI_END>>>",
    router,
  );
  const stream = provider.streamSimple(model, {
    messages: [],
    tools: [{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) }],
  });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(intents, ["run pwd", "run date"]);
  assert.deepEqual(events.map((event) => event.type), [
    "start", "text_start", "text_delta", "text_end",
    "toolcall_start", "toolcall_delta", "toolcall_end",
    "toolcall_start", "toolcall_delta", "toolcall_end", "done",
  ]);
  assert.equal(events.at(-1).message.stopReason, "toolUse");
});
