import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareModel, runtimeStatus } from "./dist/runtime.js";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("llm-bridge", {
    description: "Show or prepare the pi-llm-bridge Needle runtime",
    handler: async (args, ctx) => {
      if (args.trim() === "setup") {
        ctx.ui.notify("Preparing Cactus Needle runtime…", "info");
        const model = await prepareModel();
        ctx.ui.notify(`Needle runtime and model ready: ${model}`, "info");
        return;
      }
      const status = await runtimeStatus();
      ctx.ui.notify(status.ready ? `Needle runtime ready: ${status.python}` : `Needle runtime not prepared: ${status.root}`, status.ready ? "info" : "warning");
    },
  });
}
