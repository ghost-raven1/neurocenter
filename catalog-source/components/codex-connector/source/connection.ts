import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { JsonObject, RpcId, RpcMessage } from "./types.js";
import { codexExecutable } from "./executable.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Newline JSON-RPC transport. Stdout is reserved for protocol, stderr is drained. */
export class CodexConnection extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<RpcId, Pending>();
  private sequence = 0;
  private failure?: Error;
  private exited: Promise<void>;
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  constructor(command?: string, args: string[] = []) {
    super();
    const executable = command ? { command, args } : codexExecutable();
    this.child = spawn(executable.command, [...executable.args, "app-server", "--listen", "stdio://"], {
      stdio: "pipe", windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => {
        this.fail(new Error("Codex app-server closed before the request completed"));
        resolve();
      });
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  async initialize(): Promise<void> {
    await this.call("initialize", {
      clientInfo: { name: "codexbridge", title: "CodexBridge", version: "0.2.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized" });
  }

  call(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(new Error(`Codex RPC timed out: ${method}`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  respond(id: RpcId, result: unknown): void { this.send({ id, result }); }
  reject(id: RpcId, message: string): void {
    this.send({ id, error: { code: -32601, message } });
  }

  private send(message: RpcMessage): void {
    if (this.failure) return;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
        this.fail(new Error("Codex RPC frame exceeds 8 MiB")); return;
      }
      let message: RpcMessage;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        message = value as RpcMessage;
      } catch { this.fail(new Error("Invalid JSON-RPC from Codex")); return; }
      const pending = message.method === undefined && message.id !== undefined
        ? this.pending.get(message.id) : undefined;
      if (pending && message.id !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else this.emit("message", message);
    }
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
      this.fail(new Error("Codex RPC frame exceeds 8 MiB"));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(error);
    }
    this.pending.clear();
    this.emit("failure", error);
    this.child.kill("SIGTERM");
  }

  /** Reap the child before returning so cancellation cannot leave hidden work running. */
  async close(): Promise<void> {
    this.fail(new Error("Codex connection closed"));
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 500);
    await this.exited;
    clearTimeout(kill);
    this.removeAllListeners();
  }
}
