import { defineBridge, expectOk, sseJson } from "pi-llm-bridge";

const endpoint = "https://demo-bitnet-h0h8hcfqeqhrf5gf.canadacentral-01.azurewebsites.net/completion";
const formatInstruction = [
  "You are the decision layer of a coding agent.",
  "Follow the user's labelled Markdown fence protocol exactly.",
  "Never copy protocol instructions, placeholder sentences, schemas, or examples into your answer.",
  "For an action, output a tool fence containing YAML. Never output bash, shell, JSON, or language-labelled fences.",
  "Example:",
  "```tool",
  "tool: bash",
  "arguments:",
  "  command: pwd",
  "```",
  "For a user-visible answer, output only a text fence.",
].join("\n");

export default defineBridge({
  provider: {
    id: "bitnet-bridge",
    name: "BitNet through pi-llm-bridge",
    baseUrl: endpoint,
    models: [{
      id: "bitnet",
      name: "BitNet through Needle",
      contextWindow: 4096,
      maxTokens: 1024,
    }],
  },
  includeSystemPrompt: false,
  extraInstructions: "Be extremely concise. Follow the labelled fence format exactly.",
  request: ({ prompt, signal }) => expectOk(fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      messages: [
        { role: "system", content: formatInstruction },
        { role: "user", content: prompt },
      ],
      userId: `pi_${Date.now()}`,
      chatId: `pi_${crypto.randomUUID()}`,
      device: "cpu",
    }),
  })),
  decode: (response) => sseJson(
    response,
    (event) => typeof event.content === "string" && !event.finished
      ? event.content
      : undefined,
  ),
});
