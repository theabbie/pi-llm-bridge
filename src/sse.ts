import type { BridgeChunk } from "./types.js";

export async function expectOk(input: Response | Promise<Response>): Promise<Response> {
  const response = await input;
  if (response.ok) return response;
  const body = (await response.text()).slice(0, 1000);
  throw new Error(`Upstream ${response.status}${body ? `: ${body}` : ""}`);
}

export async function* sse(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error("Upstream returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const flush = () => {
    if (!data.length) return undefined;
    const value = data.join("\n");
    data = [];
    return value;
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") {
        const event = flush();
        if (event !== undefined) yield event;
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
    if (done) break;
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
  const event = flush();
  if (event !== undefined) yield event;
}

export async function* sseJson<T>(
  response: Response,
  select: (event: any) => T | undefined,
): AsyncGenerator<T> {
  for await (const data of sse(response)) {
    if (!data || data === "[DONE]") continue;
    const selected = select(JSON.parse(data));
    if (selected !== undefined) yield selected;
  }
}

export async function* jsonLines<T>(
  source: AsyncIterable<string | Uint8Array>,
  select: (event: any) => T | undefined,
): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const selected = select(JSON.parse(line));
      if (selected !== undefined) yield selected;
    }
  }
  if (buffer.trim()) {
    const selected = select(JSON.parse(buffer));
    if (selected !== undefined) yield selected;
  }
}

export async function* stopAt(
  source: AsyncIterable<BridgeChunk>,
  sequences: string[],
): AsyncGenerator<BridgeChunk> {
  const stops = sequences.filter(Boolean);
  if (!stops.length) {
    yield* source;
    return;
  }
  const hold = Math.max(...stops.map((value) => value.length)) - 1;
  let pending = "";
  for await (const chunk of source) {
    if (typeof chunk !== "string" && chunk.text === undefined) {
      yield chunk;
      continue;
    }
    const text = typeof chunk === "string" ? chunk : chunk.text ?? "";
    pending += text;
    const indexes = stops.map((stop) => pending.indexOf(stop)).filter((index) => index >= 0);
    if (indexes.length) {
      const end = Math.min(...indexes);
      if (end > 0) yield pending.slice(0, end);
      return;
    }
    if (pending.length > hold) {
      const end = pending.length - hold;
      yield pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
  if (pending) yield pending;
}
