import type { Tool } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { parse } from "yaml";
import type { ToolCallShape } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function splitEnvelope(value: string): { header: string; payload: string } | undefined {
  const separator = /(^|\r?\n)---(?:\r?\n|$)/.exec(value);
  if (!separator) return undefined;
  return {
    header: value.slice(0, separator.index).trim(),
    payload: value.slice(separator.index + separator[0].length),
  };
}

function propertyNames(tool: Tool): string[] {
  const schema = tool.parameters as unknown as Record<string, unknown>;
  return record(schema.properties) ? Object.keys(schema.properties) : [];
}

export function directWriteCall(value: string, tools: Tool[]): ToolCallShape | undefined {
  const envelope = splitEnvelope(value);
  if (!envelope) return undefined;

  let header: unknown;
  try {
    header = parse(envelope.header);
  } catch {
    return undefined;
  }
  if (!record(header) || header.tool !== "write") return undefined;
  if (Object.keys(header).some((key) => !["tool", "arguments", "payloadArgument"].includes(key))) return undefined;
  const args = header.arguments;
  if (!record(args)) return undefined;

  const tool = tools.find((candidate) => candidate.name === "write");
  if (!tool) return undefined;
  const explicit = typeof header.payloadArgument === "string" ? header.payloadArgument : undefined;
  const candidates = explicit
    ? explicit in args ? [] : [explicit]
    : propertyNames(tool).filter((name) => !(name in args));
  const matches = candidates.flatMap((name) => {
    const completed = { ...args, [name]: envelope.payload };
    return Value.Check(tool.parameters, completed) ? [{ name: tool.name, arguments: completed }] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}
