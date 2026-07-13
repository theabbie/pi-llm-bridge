import assert from "node:assert/strict";
import test from "node:test";
import { parseProtocol } from "../src/protocol.js";
import { stopAt } from "../src/sse.js";

async function collect(source: AsyncIterable<any>) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}

test("parses split multiline ordered blocks", async () => {
  async function* chunks() {
    yield "<<<PI_TE";
    yield "XT>>>\nI will inspect it first.\nThis is visible.\n<<<PI_END>>>\n<<<PI_TOOL>>>\nRun this exact command:\ncurl -s ";
    yield "https://api.ipify.org\n<<<PI_END>>>";
  }
  const events = await collect(parseProtocol(chunks()));
  assert.deepEqual(events.map((event) => event.type), [
    "block_start", "block_delta", "block_end",
    "block_start", "block_delta", "block_end",
  ]);
  const text = events.filter((event) => event.kind === "text" && event.delta).map((event) => event.delta).join("");
  const tool = events.filter((event) => event.kind === "tool" && event.delta).map((event) => event.delta).join("");
  assert.equal(text, "I will inspect it first.\nThis is visible.");
  assert.equal(tool, "Run this exact command:\ncurl -s https://api.ipify.org");
});

test("parses repeated tool blocks", async () => {
  async function* chunks() {
    yield "<<<PI_TOOL>>>\nRead package.json\n<<<PI_END>>><<<PI_TOOL>>>\nRun npm test\n<<<PI_END>>>";
  }
  const events = await collect(parseProtocol(chunks()));
  assert.equal(events.filter((event) => event.type === "block_start" && event.kind === "tool").length, 2);
});

test("recognizes adjacent delimiters split anywhere in the stream", async () => {
  async function* chunks() {
    yield "<<<PI_TEXT>>>\nI will check it.<<<PI_EN";
    yield "D>>><<<PI_TO";
    yield "OL>>>curl -s https://api.ipify.org<<<PI_END>>>";
  }
  const events = await collect(parseProtocol(chunks()));
  const text = events.filter((event) => event.kind === "text" && event.delta).map((event) => event.delta).join("");
  const tool = events.filter((event) => event.kind === "tool" && event.delta).map((event) => event.delta).join("");
  assert.equal(text, "I will check it.");
  assert.equal(tool, "curl -s https://api.ipify.org");
});

test("silently ignores malformed markers and outside text", async () => {
  async function* chunks() {
    yield "<<<PI_TEXT>>>\nI will inspect it.\n<<<PI_END>>>\nstray text\n<<<<PI_TOOL>>>\nbash\nls -la\n<<<PI_END>>>";
  }
  const events = await collect(parseProtocol(chunks()));
  const text = events.filter((event) => event.kind === "text" && event.delta).map((event) => event.delta).join("");
  const tool = events.filter((event) => event.kind === "tool" && event.delta).map((event) => event.delta).join("");
  assert.equal(text, "I will inspect it.");
  assert.equal(tool, "");
});

test("silently ignores a response containing no valid blocks", async () => {
  async function* chunks() {
    yield "ordinary outside text\n<<<<PI_TOOL>>>\nls -la";
  }
  assert.deepEqual(await collect(parseProtocol(chunks())), []);
});

test("closes the final block at end of stream", async () => {
  async function* chunks() {
    yield "<<<PI_TOOL>>>\nline one\nline two";
  }
  const events = await collect(parseProtocol(chunks()));
  assert.equal(events.filter((event) => event.delta).map((event) => event.delta).join(""), "line one\nline two");
  assert.equal(events.at(-1)?.type, "block_end");
});

test("stops across chunk boundaries", async () => {
  async function* chunks() {
    yield "<<<PI_TEXT>>>\ndone\n<<<PI_END>>>\n```fol";
    yield "lowups\nignored";
  }
  const values = await collect(stopAt(chunks(), ["```followups"]));
  assert.equal(values.join(""), "<<<PI_TEXT>>>\ndone\n<<<PI_END>>>\n");
});

test("supports non-strict raw text fallback", async () => {
  async function* chunks() {
    yield "A plain multiline answer\nwithout protocol framing.";
  }
  const events = await collect(parseProtocol(chunks(), false));
  assert.equal(events.filter((event) => event.delta).map((event) => event.delta).join(""), "A plain multiline answer\nwithout protocol framing.");
});
