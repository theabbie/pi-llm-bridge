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
        if (buffer.startsWith(TEXT_BLOCK) || buffer.startsWith(TOOL_BLOCK)) {
          kind = buffer.startsWith(TEXT_BLOCK) ? "text" : "tool";
          const opener = kind === "text" ? TEXT_BLOCK : TOOL_BLOCK;
          buffer = buffer.slice(opener.length);
          blockStarted = false;
          blocks += 1;
          events.push({ type: "block_start", kind });
          continue;
        }
        const partialOpener = TEXT_BLOCK.startsWith(buffer) || TOOL_BLOCK.startsWith(buffer);
        if (partialOpener && !final) break;
        if (strict || blocks) {
          throw new Error(`Raw model emitted content outside a Pi block: ${buffer.slice(0, 160)}`);
        }
        fallback = true;
        blocks += 1;
        events.push({ type: "block_start", kind: "text" });
        continue;
      }

      if (!blockStarted) {
        if (buffer.startsWith("\r\n")) buffer = buffer.slice(2);
        else if (buffer.startsWith("\n")) buffer = buffer.slice(1);
        else if (buffer === "\r" && !final) break;
        blockStarted = true;
      }

      const end = buffer.indexOf(END_BLOCK);
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
      const safeLength = buffer.length - END_BLOCK.length - 1;
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
  if (!blocks) throw new Error("Raw model returned no Pi content blocks");
}
