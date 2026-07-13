#!/usr/bin/env node

import { prepareModel, runtimeStatus } from "../dist/index.js";

const command = process.argv[2] ?? "setup";

if (command === "setup") {
  process.stdout.write("Preparing Cactus Needle runtime and model...\n");
  const model = await prepareModel();
  process.stdout.write(`Ready: ${model}\n`);
} else if (command === "status") {
  const status = await runtimeStatus();
  process.stdout.write(`${status.ready ? "Runtime ready" : "Runtime not prepared"}: ${status.root}\n`);
} else {
  process.stderr.write("Usage: pi-llm-bridge [setup|status]\n");
  process.exitCode = 1;
}
