import type { Context, Message, Tool } from "@earendil-works/pi-ai";

function renderParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const lines: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") lines.push(value.text);
    if (value.type === "image") lines.push(`[image ${String(value.mimeType ?? "unknown")}]`);
    if (value.type === "toolCall") {
      lines.push(`[completed request ${String(value.name ?? "unknown")}: ${JSON.stringify(value.arguments ?? {})}]`);
    }
  }
  return lines.join("\n");
}

function renderMessage(message: Message): string {
  if (message.role === "toolResult") {
    const state = message.isError ? "error" : "result";
    return `TOOL ${message.toolName} ${state}:\n${renderParts(message.content)}`;
  }
  return `${message.role.toUpperCase()}:\n${renderParts(message.content)}`;
}

function renderTools(tools: Tool[] | undefined): string {
  if (!tools?.length) return "- none";
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}

export function contextToBridgePrompt(
  context: Context,
  options: { includeSystemPrompt?: boolean; extraInstructions?: string } = {},
): string {
  const sections = [
    "Continue the conversation as a coding agent.",
    "Return one or more ordered blocks using only these delimiter lines:",
    "<<<PI_TEXT>>>",
    "A concise response or explanation visible to the user.",
    "<<<PI_END>>>",
    "<<<PI_TOOL>>>",
    "One next action with every exact value needed to perform it.",
    "<<<PI_END>>>",
    "Text and tool blocks may be multiline, may repeat, and may be interleaved.",
    "Use a separate tool block for each independent action. For dependent actions, request one tool and wait for its result before choosing the next.",
    "Inside a tool block, describe intent only. Do not emit JSON, schemas, tool-call syntax, or markdown fences.",
    "Every opening and closing delimiter must be alone on its line. Never use delimiter text inside block content.",
    "Completed requests and tool results in the transcript already happened. Use them and do not repeat them.",
    `Available actions:\n${renderTools(context.tools)}`,
  ];
  if (options.includeSystemPrompt !== false && context.systemPrompt?.trim()) {
    sections.push(`Pi instructions:\n${context.systemPrompt.trim()}`);
  }
  if (options.extraInstructions?.trim()) sections.push(options.extraInstructions.trim());
  sections.push(`Conversation:\n${context.messages.map(renderMessage).join("\n\n")}`);
  return sections.join("\n\n");
}

export function flattenTools(tools: Tool[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => {
    const schema = tool.parameters as unknown as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, Record<string, unknown>>
      : schema as Record<string, Record<string, unknown>>;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const parameters = Object.fromEntries(
      Object.entries(properties)
        .filter(([name, value]) => !["type", "properties", "required", "additionalProperties"].includes(name) && value && typeof value === "object")
        .map(([name, value]) => {
          const rawType = value.type;
          const type = Array.isArray(rawType)
            ? rawType.find((entry) => entry !== "null") ?? "string"
            : rawType ?? "string";
          return [name, {
            type,
            description: String(value.description ?? "").slice(0, 300),
            required: required.has(name) || value.required === true,
          }];
        }),
    );
    return {
      name: tool.name,
      description: String(tool.description || `Use ${tool.name}`).slice(0, 500),
      parameters,
    };
  });
}
