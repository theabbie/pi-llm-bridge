import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { directWriteCall } from "../src/write-envelope.js";

test("preserves an exact raw write payload", () => {
  const payload = "def main():\n    print('hello')\n\nmain()";
  const call = directWriteCall(
    `tool: write\npayloadArgument: content\narguments:\n  path: app.py\n---\n${payload}`,
    [{ name: "write", description: "Write a file", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
  );
  assert.deepEqual(call, { name: "write", arguments: { path: "app.py", content: payload } });
});

test("uses the live write schema instead of a hardcoded content parameter", () => {
  const call = directWriteCall(
    "tool: write\npayloadArgument: body\narguments:\n  file: notes.txt\n---\nhello",
    [{ name: "write", description: "Write a file", parameters: Type.Object({ file: Type.String(), body: Type.String() }) }],
  );
  assert.deepEqual(call, { name: "write", arguments: { file: "notes.txt", body: "hello" } });
});

test("infers a unique omitted write payload parameter", () => {
  const call = directWriteCall(
    "tool: write\narguments:\n  path: empty.txt\n---\n",
    [{ name: "write", description: "Write a file", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
  );
  assert.deepEqual(call, { name: "write", arguments: { path: "empty.txt", content: "" } });
});

test("directly executes schema-valid ordinary write YAML", () => {
  const content = "<!doctype html>\n<title>Snake</title>\n<script>\n  startGame();\n</script>";
  const call = directWriteCall(
    `tool: write\narguments:\n  path: public/index.html\n  content: |\n${content.split("\n").map((line) => `    ${line}`).join("\n")}`,
    [{ name: "write", description: "Write a file", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
  );
  assert.deepEqual(call, { name: "write", arguments: { path: "public/index.html", content: `${content}\n` } });
});

test("rejects ordinary write YAML that does not match the live schema", () => {
  const call = directWriteCall(
    "tool: write\narguments:\n  path: public/index.html",
    [{ name: "write", description: "Write a file", parameters: Type.Object({ path: Type.String(), content: Type.String() }) }],
  );
  assert.equal(call, undefined);
});

test("rejects invalid and non-write envelopes", () => {
  const tools = [
    { name: "write", description: "Write a file", parameters: Type.Object({ path: Type.String(), content: Type.String() }) },
    { name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
  ];
  assert.equal(directWriteCall("tool: bash\narguments:\n  command: pwd\n---\nignored", tools), undefined);
  assert.equal(directWriteCall("tool: write\npayloadArgument: missing\narguments:\n  path: app.py\n---\nbody", tools), undefined);
});
