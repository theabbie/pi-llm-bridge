import { contextToBridgePromptWithHistory, defineBridge, expectOk, sseJson } from "pi-llm-bridge";

const endpoint = "https://demos.exa.ai/chatbot-demo/api/chat/stream";

export default defineBridge({
  provider: {
    id: "exa-bridge",
    name: "Exa through pi-llm-bridge",
    baseUrl: endpoint,
    models: [{ id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash through Exa" }],
  },
  stopSequences: ["```followups", "\nFOLLOW-UP SUGGESTIONS", "\nFollow-up suggestions"],
  request: ({ context, model, signal }) => {
    const conversation = contextToBridgePromptWithHistory(context);
    return expectOk(fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ ...conversation, exaEnabled: false, model: model.id, searchType: "instant" }),
    }));
  },
  decode: (response) => sseJson(response, (event) => typeof event.content === "string" ? event.content : undefined),
});
