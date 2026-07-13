import assert from "node:assert/strict";
import test from "node:test";
import { sseJson } from "../src/sse.js";

test("decodes fragmented SSE JSON", async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"content\":\"hel"));
      controller.enqueue(encoder.encode("lo\"}\n\ndata: [DONE]\n\n"));
      controller.close();
    },
  }));
  const output = [];
  for await (const value of sseJson(response, (event) => event.content)) output.push(value);
  assert.deepEqual(output, ["hello"]);
});
