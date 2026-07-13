import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NeedleModelConfig } from "./types.js";

const NEEDLE_COMMIT = "ffb1c5144c5a16cb8ec650dbc8a6f6fd3854f8f2";
const RUNTIME_VERSION = `1:${NEEDLE_COMMIT}`;
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(PACKAGE_ROOT, "python", "worker.py");
let setupPromise: Promise<string> | undefined;

export const DEFAULT_NEEDLE_MODEL: Required<NeedleModelConfig> = {
  repo: "theabbie/needle-pi-coding-agent",
  revision: "54c5de0a97dbf150d64d4d188b2f60e032d8c050",
  filename: "needle-pi-coding-agent.pkl",
  maxTokens: 512,
};

export function resolveNeedleModel(config: NeedleModelConfig = {}): Required<NeedleModelConfig> {
  return { ...DEFAULT_NEEDLE_MODEL, ...config };
}

function runtimeRoot(): string {
  if (process.env.PI_LLM_BRIDGE_HOME) return process.env.PI_LLM_BRIDGE_HOME;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "pi-llm-bridge");
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-llm-bridge");
}

function venvPython(root: string): string {
  return process.platform === "win32"
    ? join(root, "venv", "Scripts", "python.exe")
    : join(root, "venv", "bin", "python");
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}: ${output.trim()}`));
    });
  });
}

async function findSystemPython(): Promise<string> {
  const candidates = [process.env.PYTHON, "python3", "python"].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await run(candidate, ["-c", "import sys; raise SystemExit(sys.version_info < (3, 11))"], 10000);
      return candidate;
    } catch {}
  }
  throw new Error("Python 3.11 or newer is required to install the Needle runtime");
}

export async function prepareRuntime(): Promise<string> {
  if (process.env.PI_LLM_BRIDGE_PYTHON) return process.env.PI_LLM_BRIDGE_PYTHON;
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    const root = runtimeRoot();
    const python = venvPython(root);
    const marker = join(root, "runtime-version");
    try {
      if ((await readFile(marker, "utf8")).trim() === RUNTIME_VERSION) return python;
    } catch {}
    if (process.env.PI_LLM_BRIDGE_AUTO_SETUP === "0") {
      throw new Error("Needle runtime is not installed; run /llm-bridge setup or enable PI_LLM_BRIDGE_AUTO_SETUP");
    }
    await mkdir(root, { recursive: true });
    const systemPython = await findSystemPython();
    try {
      await access(python);
    } catch {
      await run(systemPython, ["-m", "venv", join(root, "venv")], 120000);
    }
    await run(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", `needle @ git+https://github.com/cactus-compute/needle.git@${NEEDLE_COMMIT}`],
      1200000,
    );
    await writeFile(marker, `${RUNTIME_VERSION}\n`, "utf8");
    return python;
  })();
  try {
    return await setupPromise;
  } catch (error) {
    setupPromise = undefined;
    throw error;
  }
}

export async function prepareModel(config: NeedleModelConfig = {}): Promise<string> {
  const python = await prepareRuntime();
  const model = resolveNeedleModel(config);
  const root = runtimeRoot();
  await mkdir(root, { recursive: true });
  const identity = JSON.stringify([python, model.repo, model.revision, model.filename]);
  const marker = join(root, `model-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`);
  try {
    if ((await readFile(marker, "utf8")).trim() === identity) return model.repo;
  } catch {}
  await run(python, [
    WORKER,
    "--repo", model.repo,
    "--revision", model.revision,
    "--filename", model.filename,
  ], 1200000);
  await writeFile(marker, `${identity}\n`, "utf8");
  return model.repo;
}

export async function runtimeStatus(): Promise<{ ready: boolean; python?: string; root: string }> {
  const root = runtimeRoot();
  if (process.env.PI_LLM_BRIDGE_PYTHON) {
    return { ready: true, python: process.env.PI_LLM_BRIDGE_PYTHON, root };
  }
  try {
    const version = (await readFile(join(root, "runtime-version"), "utf8")).trim();
    if (version === RUNTIME_VERSION) return { ready: true, python: venvPython(root), root };
  } catch {}
  return { ready: false, root };
}

export { WORKER };
