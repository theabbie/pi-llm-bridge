import type { BridgeChunk, BridgeDelta } from "./types.js";

export type ProtocolKind = "text" | "tool";

export type ProtocolEvent =
  | { type: "block_start"; kind: ProtocolKind }
  | { type: "block_delta"; kind: ProtocolKind; delta: string }
  | { type: "block_end"; kind: ProtocolKind }
  | { type: "metadata"; metadata: BridgeDelta };

export const TEXT_BLOCK = "<<<PI_TEXT>>>";
export const TOOL_BLOCK = "<<<PI_TOOL>>>";
export const END_BLOCK = "<<<PI_END>>>";

function findMarker(value: string, marker: string): number {
  let from = 0;
  while (from < value.length) {
    const index = value.indexOf(marker, from);
    if (index < 0) return -1;
    if (index === 0 || value[index - 1] !== "<") return index;
    from = index + 1;
  }
  return -1;
}

function findOpener(value: string): { index: number; kind: ProtocolKind; marker: string } | undefined {
  const matches = [
    { index: findMarker(value, TEXT_BLOCK), kind: "text" as const, marker: TEXT_BLOCK },
    { index: findMarker(value, TOOL_BLOCK), kind: "tool" as const, marker: TOOL_BLOCK },
  ].filter((match) => match.index >= 0).sort((left, right) => left.index - right.index);
  return matches[0];
}

function trailingOpenerPrefix(value: string): string {
  for (let length = Math.min(value.length, TOOL_BLOCK.length - 1); length > 0; length -= 1) {
    const start = value.length - length;
    const suffix = value.slice(start);
    const boundary = start === 0 || value[start - 1] !== "<";
    if (boundary && (TEXT_BLOCK.startsWith(suffix) || TOOL_BLOCK.startsWith(suffix))) return suffix;
  }
  return "";
}

export async function* parseProtocol(
  source: AsyncIterable<BridgeChunk>,
  strict = true,
): AsyncGenerator<ProtocolEvent> {
  let buffer = "";
  let kind: ProtocolKind | undefined;
  let blockStarted = false;
  let fallback = false;
  let blocks = 0;

  const drain = (final: boolean): ProtocolEvent[] => {
    const events: ProtocolEvent[] = [];
    while (buffer) {
      if (fallback) {
        events.push({ type: "block_delta", kind: "text", delta: buffer });
        buffer = "";
        break;
      }

      if (!kind) {
        buffer = buffer.replace(/^\s+/, "");
        if (!buffer) break;
        const opener = findOpener(buffer);
        if (opener) {
          kind = opener.kind;
          buffer = buffer.slice(opener.index + opener.marker.length);
          blockStarted = false;
          blocks += 1;
          events.push({ type: "block_start", kind });
          continue;
        }
        if (!strict && !blocks) {
          fallback = true;
          blocks += 1;
          events.push({ type: "block_start", kind: "text" });
          continue;
        }
        if (final) {
          buffer = "";
          break;
        }
        buffer = trailingOpenerPrefix(buffer);
        break;
      }

      if (!blockStarted) {
        if (buffer.startsWith("\r\n")) buffer = buffer.slice(2);
        else if (buffer.startsWith("\n")) buffer = buffer.slice(1);
        else if (buffer === "\r" && !final) break;
        blockStarted = true;
      }

      const end = findMarker(buffer, END_BLOCK);
      if (end >= 0) {
        const delta = buffer.slice(0, end).replace(/\r?\n$/, "");
        if (delta) events.push({ type: "block_delta", kind, delta });
        buffer = buffer.slice(end + END_BLOCK.length);
        events.push({ type: "block_end", kind });
        kind = undefined;
        blockStarted = false;
        continue;
      }

      if (final) {
        const delta = buffer.replace(/\r?\n$/, "");
        if (delta) events.push({ type: "block_delta", kind, delta });
        buffer = "";
        events.push({ type: "block_end", kind });
        kind = undefined;
        blockStarted = false;
        continue;
      }
      const safeLength = buffer.length - 96;
      if (safeLength <= 0) break;
      events.push({ type: "block_delta", kind, delta: buffer.slice(0, safeLength) });
      buffer = buffer.slice(safeLength);
    }
    return events;
  };

  for await (const chunk of source) {
    const value = typeof chunk === "string" ? { text: chunk } : chunk;
    if (value.usage || value.responseId || value.responseModel) {
      yield { type: "metadata", metadata: value };
    }
    if (!value.text) continue;
    buffer += value.text;
    for (const event of drain(false)) yield event;
  }

  for (const event of drain(true)) yield event;
  if (fallback) yield { type: "block_end", kind: "text" };
  else if (kind) yield { type: "block_end", kind };
}
