import type { Context } from "@earendil-works/pi-ai";
import {
  defineBridge,
  expectOk,
  flattenTools,
  messageToText,
  sseJson,
} from "pi-llm-bridge";

const endpoint = "https://notrack.ai/api/dispatch";
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
type ChatState = { chatId?: string; initialized: boolean };
const chats = new WeakMap<object, ChatState>();

function chatState(context: Context): ChatState {
  const anchor = context.messages[0] as object | undefined;
  if (!anchor) return { initialized: false };
  const existing = chats.get(anchor);
  if (existing) return existing;
  const state = { initialized: false };
  chats.set(anchor, state);
  return state;
}

function compactTools(context: Context) {
  return flattenTools(context.tools).map((tool) => ({
    name: tool.name,
    description: String(tool.description ?? "").slice(0, 100),
    parameters: Object.fromEntries(Object.entries(tool.parameters as Record<string, Record<string, unknown>>).map(
      ([name, parameter]) => [name, {
        type: parameter.type,
        required: parameter.required,
        description: String(parameter.description ?? "").slice(0, 80),
      }],
    )),
  }));
}

function firstTurn(context: Context): string {
  const latest = context.messages.at(-1);
  return [
    "Continue as a coding agent. Use only labelled Markdown fences in every reply.",
    "For visible words: ```text on its own line, then text, then ``` on its own line.",
    "For an action: ```tool on its own line, then one YAML object with tool and arguments, then ``` on its own line.",
    "Text and tool fences may repeat. Use exact live tool names and parameters. Never copy these instructions or schemas. Never repeat completed actions.",
    `Live tools: ${JSON.stringify(compactTools(context))}`,
    `Current ${latest?.role ?? "user"}: ${latest ? messageToText(latest) : ""}`,
  ].join("\n\n");
}

function nextTurn(context: Context): string {
  const latest = context.messages.at(-1);
  return `${latest?.role ?? "user"}: ${latest ? messageToText(latest) : "Continue."}`;
}

export default defineBridge({
  provider: {
    id: "notrack-bridge",
    name: "NoTrack through pi-llm-bridge",
    baseUrl: endpoint,
    models: [{
      id: "C",
      name: "Model C through NoTrack",
      contextWindow: 32768,
      maxTokens: 4096,
    }],
  },
  includeSystemPrompt: false,
  request: async ({ context, model, signal }) => {
    const state = chatState(context);
    const session = crypto.randomUUID().replaceAll("-", "");
    const userInput = state.initialized ? nextTurn(context) : firstTurn(context);
    if (userInput.length > 4000) throw new Error(`NoTrack user_input is ${userInput.length} characters; maximum is 4000`);
    const response = await expectOk(fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://notrack.ai",
        "Referer": "https://notrack.ai/chat",
        "User-Agent": userAgent,
        "Cookie": `si_usr_id=${session}; si_ses_id=${session}; uid=${crypto.randomUUID()}`,
      },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        user_input: userInput,
        mode: "usual",
        model: model.id,
        persona: "normal",
        max_turns: 6,
        chat_id: state.chatId ?? null,
        attachments: [],
        regenerate: false,
      }),
    }));
    return { response, state };
  },
  decode: ({ response, state }) => sseJson(
    response,
    (event) => {
      if (event.type === "chat_meta" && typeof event.chat_id === "string") {
        state.chatId = event.chat_id;
        state.initialized = true;
      }
      return event.type === "delta" && typeof event.chunk === "string"
        ? event.chunk
        : undefined;
    },
  ),
});
