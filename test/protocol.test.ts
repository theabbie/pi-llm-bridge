import assert from "node:assert/strict";
import test from "node:test";
import { parseProtocol } from "../src/protocol.js";
import { stopAt } from "../src/sse.js";

async function collect(source: AsyncIterable<any>) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}

test("parses labelled Markdown fences split across chunks", async () => {
  async function* chunks() {
    yield "ordinary prose is ignored\n```te";
    yield "xt\nI will inspect it first.\nThis is visible.\n```\n```tool\ntool: bash\narguments:\n  command: curl -s ";
    yield "https://api.ipify.org\n```";
  }
  const events = await collect(parseProtocol(chunks()));
  assert.deepEqual(events.map((event) => event.type), [
    "block_start", "block_delta", "block_end",
    "block_start", "block_delta", "block_end",
  ]);
  const text = events.filter((event) => event.kind === "text" && event.delta).map((event) => event.delta).join("");
  const tool = events.filter((event) => event.kind === "tool" && event.delta).map((event) => event.delta).join("");
  assert.equal(text, "I will inspect it first.\nThis is visible.");
  assert.equal(tool, "tool: bash\narguments:\n  command: curl -s https://api.ipify.org");
});

test("parses repeated and interleaved labelled fences", async () => {
  async function* chunks() {
    yield "```text\nChecking both.\n```\n```tool\nrun pwd\n```\n```tool\nrun date\n```";
  }
  const events = await collect(parseProtocol(chunks()));
  assert.equal(events.filter((event) => event.type === "block_start" && event.kind === "text").length, 1);
  assert.equal(events.filter((event) => event.type === "block_start" && event.kind === "tool").length, 2);
});

test("silently ignores prose, followups, and other Markdown fences", async () => {
  async function* chunks() {
    yield "outside\n```text\nvisible\n```\n```followups\n[\"ignored\"]\n```\n```json\n{\"ignored\":true}\n```";
  }
  const events = await collect(parseProtocol(chunks()));
  const content = events.filter((event) => event.delta).map((event) => event.delta).join("");
  assert.equal(content, "visible");
});

test("silently ignores malformed, unlabelled, and incorrectly labelled fences", async () => {
  async function* chunks() {
    yield "``tool\nignored\n``\n```\nunlabelled\n```\n```tool yaml\nalso ignored\n```";
  }
  assert.deepEqual(await collect(parseProtocol(chunks())), []);
});

test("silently ignores a response containing no valid fences", async () => {
  async function* chunks() {
    yield "ordinary outside text";
  }
  assert.deepEqual(await collect(parseProtocol(chunks())), []);
});

test("stops generic streams across chunk boundaries", async () => {
  async function* chunks() {
    yield "```text\ndone\n```\nFOLLOW-UP ";
    yield "SUGGESTIONS\nignored";
  }
  const values = await collect(stopAt(chunks(), ["FOLLOW-UP SUGGESTIONS"]));
  assert.equal(values.join(""), "```text\ndone\n```\n");
});

test("supports non-strict raw text fallback", async () => {
  async function* chunks() {
    yield "A plain multiline answer\nwithout protocol framing.";
  }
  const events = await collect(parseProtocol(chunks(), false));
  assert.equal(events.filter((event) => event.delta).map((event) => event.delta).join(""), "A plain multiline answer\nwithout protocol framing.");
});
