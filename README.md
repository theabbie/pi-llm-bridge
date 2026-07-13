# pi-llm-bridge

Bridge any raw LLM stream to be used with Pi.

`pi-llm-bridge` turns a text-only model endpoint into a native [Pi](https://pi.dev) provider. The upstream model decides what should happen in plain language. A small [Cactus Needle](https://github.com/cactus-compute/needle) model converts that intent into the exact tool-call structure Pi expects.

The provider-specific surface is two functions:

```ts
export default defineBridge({
  provider,
  request: ({ prompt, signal }) => callRawApi(prompt, signal),
  decode: (response) => textChunks(response),
});
```

The bridge handles the rest.

## Installation

```bash
pi install npm:pi-llm-bridge
```

Installation automatically creates the isolated Needle environment and downloads the pinned Hugging Face checkpoint. This moves the large dependency and model download out of the first tool call. Python 3.11 or newer, Git, and network access are required during installation.

If npm lifecycle scripts were disabled, or a deployment cache needs to be prepared explicitly, run:

```bash
npx pi-llm-bridge setup
```

Check the cached runtime location with:

```bash
npx pi-llm-bridge status
```

## How it works

```text
Pi context
  → framed protocol prompt with live Pi tool schemas as YAML
  → any raw model endpoint
  → provider-specific stream decoder
  → PI_TEXT block ───────────────────→ Pi text events
  → PI_TOOL block with a near-final YAML tool call
      → Needle tool router
      → validated Pi tool call
      → Pi executes it and continues the conversation
```

The raw model never needs OpenAI compatibility, native function calling, or Pi event knowledge. The bridge serializes Pi's current tool names, descriptions, parameter types, and required fields into every stateless model request. The model emits ordered, multiline blocks:

```text
<<<PI_TEXT>>>
I will inspect the project first.
<<<PI_END>>>
<<<PI_TOOL>>>
tool: read
arguments:
  path: package.json
<<<PI_END>>>
```

Text and tool blocks may repeat and interleave. This lets one upstream response speak to the user and request tools afterward, or request several independent tools at once. Each tool block contains one YAML mapping with `tool` and `arguments`; Needle extracts and normalizes it against Pi's current schema. When one action depends on another action's result, the model emits only the first tool block and continues after Pi returns the result.

If Needle cannot produce a schema-valid call, the bridge returns the rejected YAML and validation error through a one-shot `last_output_feedback.log` bash call. Pi feeds that result back into the normal conversation so the raw model can continue the task with a corrected block; the command empties the file immediately after reading it.

Opening and closing delimiters should appear alone on their lines. The parser accepts adjacent valid delimiters, delimiters split across stream chunks, and an omitted final closing delimiter at end of stream. In strict mode, unrelated text and malformed delimiters outside valid blocks are ignored. Block content can otherwise contain arbitrary text and newlines.

## Exa example

This is the complete adapter for Exa's non-standard demo stream:

```ts
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
      body: JSON.stringify({
        ...conversation,
        exaEnabled: false,
        model: model.id,
        searchType: "instant",
      }),
    }));
  },
  decode: (response) => sseJson(
    response,
    (event) => typeof event.content === "string" ? event.content : undefined,
  ),
});
```

The implementation is also available at [`examples/exa.ts`](examples/exa.ts).

Exa's endpoint keeps no server-side session. `contextToBridgePromptWithHistory` puts only Pi's newest event in `message` and converts all earlier user, assistant, and tool-result events into Exa's client-supplied `history`. The current message still carries the live tool schemas and output protocol on every call.

## Adapter API

### `defineBridge(config)`

Returns a normal Pi extension function that registers a custom provider.

Required configuration:

- `provider.id`, `provider.name`, and at least one model
- `request(input)`, which sends the generated prompt to the raw endpoint
- `decode(response, input)`, which yields strings or `BridgeDelta` objects

Useful optional configuration:

- `stopSequences`: suffixes to discard even when split across stream chunks
- `includeSystemPrompt`: include Pi's system prompt; defaults to `true`
- `extraInstructions`: additional instructions for the raw model
- `strictProtocol`: consume only correctly framed blocks and ignore outside text; defaults to `true`
- `needle`: override the Hugging Face repository, revision, filename, or generation limit
- `router`: inject another compatible intent router

`BridgeRequest` exposes the generated prompt, original Pi context, selected model, `AbortSignal`, resolved API key, headers, timeout, session ID, and original Pi stream options.

`contextToBridgePromptWithHistory(context)` returns `{ message, history }` for endpoints that accept client-managed user/assistant history. `messageToText(message)` is available when an adapter needs custom history mapping.

`BridgeDelta` can report text plus optional usage, response ID, and response model metadata:

```ts
yield {
  text: token,
  responseId: event.id,
  usage: {
    input: 120,
    output: 18,
    totalTokens: 138,
  },
};
```

## Stream helpers

The package exports small composable decoders:

- `sse(response)`: yields SSE `data` payloads
- `sseJson(response, select)`: parses SSE JSON and selects a value
- `jsonLines(source, select)`: parses JSONL or NDJSON streams
- `stopAt(source, sequences)`: removes provider suffixes across chunk boundaries
- `expectOk(response)`: turns non-2xx responses into useful errors

A non-streaming endpoint is valid too:

```ts
decode: async function* (response) {
  const body = await response.json();
  yield body.answer;
}
```

## Needle runtime

Tool intents are routed by [theabbie/needle-pi-coding-agent](https://huggingface.co/theabbie/needle-pi-coding-agent), a fine-tune of [Cactus-Compute/needle](https://huggingface.co/Cactus-Compute/needle) for Pi's `read`, `bash`, `edit`, and `write` tools.

The default model revision is pinned to the published checkpoint commit. Adapter packages can select another repository or revision through the `needle` configuration.

The installation script prepares the runtime and checkpoint. During a Pi session, the bridge starts one persistent Python worker lazily. The worker:

1. downloads the 52.6 MB checkpoint through the Hugging Face cache;
2. loads Needle once per Pi process;
3. accepts intent-routing requests over NDJSON;
4. repairs malformed Needle JSON with [json-repair](https://github.com/mangiucugna/json_repair);
5. validates every repaired tool name and argument against Pi's live schemas;
6. stays warm in interactive sessions;
7. stops holding the process open after non-interactive runs.

The isolated Python environment lives under the platform cache directory. Needle's JAX environment is substantially larger than the model checkpoint.

Prepare or repair the complete runtime and model from Pi:

```text
/llm-bridge setup
```

Check its status:

```text
/llm-bridge
```

Environment overrides:

```bash
PI_LLM_BRIDGE_PYTHON=/path/to/python
PI_LLM_BRIDGE_HOME=/custom/cache/directory
PI_LLM_BRIDGE_AUTO_SETUP=0
```

The selected Python must already provide `needle` and `huggingface_hub` when `PI_LLM_BRIDGE_PYTHON` is set. Installation can be performed without lifecycle scripts and prepared later with `npx pi-llm-bridge setup`, but tool routing remains unavailable until setup succeeds.

## Create a provider package

A provider adapter can be its own Pi package. Keep `pi-llm-bridge` as a bundled dependency because Pi packages use isolated module roots.

```json
{
  "name": "pi-my-raw-provider",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "dependencies": {
    "pi-llm-bridge": "^0.1.0"
  },
  "bundledDependencies": ["pi-llm-bridge"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Its `index.ts` only needs the provider metadata and the two transport functions shown above.

## Local development

```bash
npm install
npm run check
npm test
npm run build
```

Load the package command locally:

```bash
pi -e /absolute/path/to/pi-llm-bridge
```

Load the Exa example:

```bash
pi -e /absolute/path/to/pi-llm-bridge/examples/exa.ts \
  --provider exa-bridge \
  --model google/gemini-2.5-flash
```

## Publishing and pi.dev

The package contains the `pi-package` keyword and `pi.extensions` manifest required by Pi's package gallery. GitHub Actions validates every push and publishes version tags through npm trusted publishing with OIDC and automatic provenance.

Bootstrap the package once from an npm-authenticated machine:

```bash
npm login
npm publish --access public
```

Then connect the published package to the repository workflow without storing an npm token:

```bash
npm trust github pi-llm-bridge \
  --repo theabbie/pi-llm-bridge \
  --file publish.yml \
  --allow-publish \
  --yes
```

Publish subsequent versions by updating `package.json` and pushing its matching tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow rejects a tag that does not match `package.json`. Trusted publishing requires npm CLI 11.5.1 or newer, a GitHub-hosted runner, and the exact repository and workflow filename configured above.

After npm indexes a release, install it with:

```bash
pi install npm:pi-llm-bridge
```

Pi's gallery discovers npm packages tagged `pi-package`; no separate gallery manifest is required. Once its npm index refreshes, it should appear at [pi.dev/packages](https://pi.dev/packages) and receive a page at `https://pi.dev/packages/pi-llm-bridge`.

## Scope and limitations

- The upstream endpoint must produce usable natural language and follow the framed block protocol.
- The bundled fine-tune is strongest on Pi's four built-in coding tools. Dynamic tool schemas are accepted, but unrelated custom tools may need additional Needle fine-tuning.
- Exact paths, commands, file content, and replacement text must be present in the raw model's YAML tool call. Needle is an extractor and normalizer, not a substitute for upstream reasoning.
- Long and whitespace-sensitive write or edit payloads remain harder than short reads and shell commands.
- Tool arguments are validated against Pi's actual TypeBox schema before Pi receives them.
- This package does not sandbox commands. Pi and its installed packages retain normal system access.

## Credits

The tool router is powered by [Cactus Compute's Needle](https://github.com/cactus-compute/needle), an open 26M-parameter function-calling model released under MIT. The default model is our [Needle Pi Coding Agent fine-tune](https://huggingface.co/theabbie/needle-pi-coding-agent), including its 1,500-example dataset, training generator, metrics, and native checkpoint.

Pi provider and package integration follows the official [custom provider](https://pi.dev/docs/latest/custom-provider) and [package](https://pi.dev/docs/latest/packages) APIs.

## License

MIT
