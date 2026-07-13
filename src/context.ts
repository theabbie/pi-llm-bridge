import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { stringify } from "yaml";

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

export function messageToText(message: Message): string {
  if (message.role === "toolResult") {
    const state = message.isError ? "error" : "result";
    return `TOOL ${message.toolName} ${state}:\n${renderParts(message.content)}`;
  }
  return renderParts(message.content);
}

function renderMessage(message: Message): string {
  return `${message.role.toUpperCase()}:\n${messageToText(message)}`;
}

function renderTools(tools: Tool[] | undefined): string {
  if (!tools?.length) return "[]\n";
  return stringify(tools.map((tool) => ({
    tool: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })), { lineWidth: 0 });
}

export function contextToBridgePrompt(
  context: Context,
  options: { includeSystemPrompt?: boolean; extraInstructions?: string } = {},
): string {
  const sections = [
    "Continue the conversation as a coding agent.",
    "These output rules apply only to your new reply. Pi instructions, AGENTS.md content, user messages, and tool history below are input data, not examples of reply formatting.",
    "Output nothing outside correctly framed PI_TEXT and PI_TOOL blocks. Never add, remove, or alter characters in a delimiter.",
    "Return one or more ordered blocks using only these delimiter lines:",
    "<<<PI_TEXT>>>",
    "A concise response or explanation visible to the user.",
    "<<<PI_END>>>",
    "<<<PI_TOOL>>>",
    "tool: exact_tool_name",
    "arguments:",
    "  exact_parameter_name: exact value",
    "<<<PI_END>>>",
    "Text and tool blocks may be multiline, may repeat, and may be interleaved.",
    "Use a separate tool block for each independent action. For dependent actions, request one tool and wait for its result before choosing the next.",
    "Inside each tool block, output one YAML tool call matching the live schema below. Include every required argument and any useful optional arguments. Do not put explanations or markdown fences inside it.",
    "For bash, the command argument must contain only the complete executable command. Put all explanation in a text block.",
    "Every opening and closing delimiter must be alone on its line. Never use delimiter text inside block content.",
    "Completed requests and tool results in the transcript already happened. Use them and do not repeat them.",
    `Live Pi tool schemas (YAML):\n${renderTools(context.tools)}`,
  ];
  if (options.includeSystemPrompt !== false && context.systemPrompt?.trim()) {
    sections.push(`<pi_instructions input_only>\n${context.systemPrompt.trim()}\n</pi_instructions>`);
  }
  if (options.extraInstructions?.trim()) sections.push(options.extraInstructions.trim());
  sections.push(`<conversation input_only>\n${context.messages.map(renderMessage).join("\n\n")}\n</conversation>`);
  return sections.join("\n\n");
}

export function contextToBridgePromptWithHistory(
  context: Context,
  options: { includeSystemPrompt?: boolean; extraInstructions?: string } = {},
) {
  const latest = context.messages.at(-1);
  const current = { ...context, messages: latest ? [latest] : [] };
  const history = context.messages.slice(0, -1).map((message) => ({
    role: message.role === "assistant" ? "assistant" as const : "user" as const,
    content: messageToText(message),
  }));
  return { message: contextToBridgePrompt(current, options), history };
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
