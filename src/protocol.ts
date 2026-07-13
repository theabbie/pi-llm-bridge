import { lexer } from "marked";
import type { BridgeChunk, BridgeDelta } from "./types.js";

export type ProtocolKind = "text" | "tool";

export type ProtocolEvent =
  | { type: "block_start"; kind: ProtocolKind }
  | { type: "block_delta"; kind: ProtocolKind; delta: string }
  | { type: "block_end"; kind: ProtocolKind }
  | { type: "metadata"; metadata: BridgeDelta };

function blockKind(lang: string | undefined): ProtocolKind | undefined {
  const label = lang?.trim().toLowerCase();
  if (label === "text" || label === "tool") return label;
  return undefined;
}

export async function* parseProtocol(
  source: AsyncIterable<BridgeChunk>,
  strict = true,
): AsyncGenerator<ProtocolEvent> {
  let markdown = "";
  for await (const chunk of source) {
    const value = typeof chunk === "string" ? { text: chunk } : chunk;
    if (value.usage || value.responseId || value.responseModel) {
      yield { type: "metadata", metadata: value };
    }
    if (value.text) markdown += value.text;
  }

  let blocks: Array<{ kind: ProtocolKind; text: string }> = [];
  try {
    for (const token of lexer(markdown)) {
      if (token.type !== "code") continue;
      const kind = blockKind(token.lang);
      if (kind && token.text.trim()) blocks.push({ kind, text: token.text });
    }
  } catch {
    blocks = [];
  }

  if (!blocks.length && !strict && markdown) {
    yield { type: "block_start", kind: "text" };
    yield { type: "block_delta", kind: "text", delta: markdown };
    yield { type: "block_end", kind: "text" };
    return;
  }

  for (const block of blocks) {
    yield { type: "block_start", kind: block.kind };
    if (block.text) yield { type: "block_delta", kind: block.kind, delta: block.text };
    yield { type: "block_end", kind: block.kind };
  }
}
