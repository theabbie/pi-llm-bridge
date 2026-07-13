import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Value } from "typebox/value";
import type { Tool } from "@earendil-works/pi-ai";
import { flattenTools } from "./context.js";
import { prepareRuntime, resolveNeedleModel, WORKER } from "./runtime.js";
import type { NeedleModelConfig, ToolCallShape, ToolRouter } from "./types.js";

interface Pending {
  resolve(value: ToolCallShape[]): void;
  reject(error: Error): void;
  abort?: () => void;
  signal?: AbortSignal;
}

class NeedleWorker implements ToolRouter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private pending = new Map<string, Pending>();
  private buffer = "";

  constructor(private readonly model: Required<NeedleModelConfig>) {}

  async route(intent: string, tools: Tool[], signal?: AbortSignal): Promise<ToolCallShape[]> {
    if (!tools.length) throw new Error("Pi supplied no tools to pi-llm-bridge");
    await this.start();
    this.reference(true);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const id = crypto.randomUUID();
    let calls: ToolCallShape[];
    try {
      calls = await new Promise<ToolCallShape[]>((resolve, reject) => {
        const pending: Pending = { resolve, reject, ...(signal ? { signal } : {}) };
        if (signal) {
          pending.abort = () => {
            this.pending.delete(id);
            reject(new DOMException("Aborted", "AbortError"));
            this.releaseIfIdle();
          };
          signal.addEventListener("abort", pending.abort, { once: true });
        }
        this.pending.set(id, pending);
        this.child!.stdin.write(`${JSON.stringify({
          id,
          intent,
          tools: flattenTools(tools),
          max_tokens: this.model.maxTokens,
        })}\n`);
      });
    } finally {
      this.releaseIfIdle();
    }
    for (const call of calls) {
      const tool = tools.find((candidate) => candidate.name === call.name);
      if (!tool) throw new Error(`Needle selected unavailable tool: ${call.name}`);
      if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
        throw new Error(`Needle returned invalid arguments for ${call.name}`);
      }
      if (!Value.Check(tool.parameters, call.arguments)) {
        const issues = [...Value.Errors(tool.parameters, call.arguments)].slice(0, 3).map((issue) => issue.message);
        throw new Error(`Needle returned arguments that do not match ${call.name}: ${issues.join("; ")}`);
      }
    }
    return calls.slice(0, 1);
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGTERM");
  }

  private async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const python = await prepareRuntime();
      const args = [
        WORKER,
        "--repo", this.model.repo,
        "--revision", this.model.revision,
        "--filename", this.model.filename,
      ];
      const child = spawn(python, args, { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      process.once("exit", () => child.kill("SIGTERM"));
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let stderr = "";
      child.stderr.on("data", (chunk) => stderr = (stderr + chunk).slice(-10000));
      child.stdout.on("data", (chunk) => this.consume(chunk));
      child.on("error", (error) => this.fail(error));
      child.on("close", (code) => this.fail(new Error(`Needle worker exited ${code}: ${stderr.trim()}`)));
      await new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Needle worker startup timed out: ${stderr.trim()}`));
        }, 180000);
        this.pending.set(id, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ id, ping: true })}\n`);
      });
      this.releaseIfIdle();
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error(`Needle worker emitted invalid JSON: ${line.slice(0, 500)}`));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
      if (message.error) pending.reject(new Error(`Needle: ${message.error}`));
      else pending.resolve(message.calls ?? []);
      this.releaseIfIdle();
    }
  }

  private fail(error: Error): void {
    this.child = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private releaseIfIdle(): void {
    if (!this.pending.size) this.reference(false);
  }

  private reference(active: boolean): void {
    const child = this.child;
    if (!child) return;
    const method = active ? "ref" : "unref";
    child[method]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const target = stream as typeof stream & { ref?(): void; unref?(): void };
      target[method]?.();
    }
  }
}

const routers = new Map<string, ToolRouter>();

export function createNeedleRouter(config: NeedleModelConfig = {}): ToolRouter {
  const model = resolveNeedleModel(config);
  const key = JSON.stringify(model);
  const existing = routers.get(key);
  if (existing) return existing;
  const router = new NeedleWorker(model);
  routers.set(key, router);
  return router;
}
