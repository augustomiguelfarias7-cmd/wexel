import { fork, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExecRequest, ExecResult, WexelPermissions } from "./index.js";

export interface WexelOrchesterOptions {
  coreBytes: BufferSource;
  workerPath?: string;
  permissions?: WexelPermissions;
  storageQuotaBytes?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onEvent?: (event: WexelOrchesterEvent) => void;
}

export type WexelOrchesterEvent =
  | { type: "sandbox-starting"; sandboxId: string; pid?: number }
  | { type: "sandbox-ready"; sandboxId: string; pid?: number }
  | { type: "sandbox-exit"; sandboxId: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: "sandbox-error"; sandboxId: string; error: string }
  | { type: "command-result"; sandboxId: string; requestId: string; result: ExecResult };

export interface WexelOrchesterSandbox {
  readonly id: string;
  readonly pid?: number;
  readonly status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  exec(request: ExecRequest): Promise<ExecResult>;
  stop(): Promise<void>;
}

type WorkerMessage =
  | { type: "ready" }
  | { type: "result"; requestId: string; result: ExecResult }
  | { type: "fatal"; error: string };

class ManagedSandbox implements WexelOrchesterSandbox {
  status: WexelOrchesterSandbox["status"] = "starting";
  private readonly pending = new Map<string, { resolve: (result: ExecResult) => void; reject: (error: Error) => void }>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveExit!: () => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  private readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });

  constructor(
    readonly id: string,
    private readonly child: ChildProcess,
    private readonly emit: (event: WexelOrchesterEvent) => void,
    private readonly shutdownTimeoutMs: number,
  ) {
    child.on("message", (raw: unknown) => this.onMessage(raw as WorkerMessage));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      const intentional = this.status === "stopping";
      this.status = intentional ? "stopped" : "failed";
      this.resolveExit();
      this.emit({ type: "sandbox-exit", sandboxId: this.id, code, signal });
      const error = new Error(`Sandbox ${this.id} encerrou inesperadamente.`);
      this.rejectReady(error);
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    });
  }

  get pid(): number | undefined { return this.child.pid; }

  private onMessage(message: WorkerMessage): void {
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      this.fail(new Error("Worker enviou uma mensagem IPC inválida."));
      return;
    }
    if (message.type === "ready") {
      if (this.status !== "starting") return;
      this.status = "ready";
      this.resolveReady();
      this.emit({ type: "sandbox-ready", sandboxId: this.id, pid: this.pid });
    } else if (message.type === "result") {
      const item = this.pending.get(message.requestId);
      if (!item) return;
      this.pending.delete(message.requestId);
      this.emit({ type: "command-result", sandboxId: this.id, requestId: message.requestId, result: message.result });
      item.resolve(message.result);
    } else if (message.type === "fatal") {
      this.fail(new Error(message.error));
    }
  }

  private fail(error: Error): void {
    if (this.status === "failed" || this.status === "stopped") return;
    this.status = "failed";
    this.rejectReady(error);
    this.emit({ type: "sandbox-error", sandboxId: this.id, error: error.message });
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    // Um evento fatal não pode deixar um worker órfão consumindo recursos.
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  async waitReady(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tempo limite ao iniciar sandbox ${this.id}.`)), timeoutMs);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    if (this.status !== "ready") return Promise.reject(new Error(`Sandbox ${this.id} não está pronta.`));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        if (!this.child.connected) throw new Error("Canal IPC da sandbox está desconectado.");
        this.child.send({ type: "exec", requestId, request }, (error) => {
          if (!error) return;
          this.pending.delete(requestId);
          reject(error);
        });
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") return;
    // Preserve the terminal failure state when the child has already exited unexpectedly.
    if (this.status === "failed" && (this.child.exitCode !== null || this.child.signalCode !== null)) return;
    this.status = "stopping";

    try {
      if (this.child.connected) {
        this.child.send({ type: "shutdown" }, (error) => {
          if (error) this.child.kill("SIGTERM");
        });
      } else if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGTERM");
      }
    } catch {
      this.child.kill("SIGTERM");
    }

    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    if (await waitForExit(this.shutdownTimeoutMs)) return;
    this.child.kill("SIGTERM");
    if (await waitForExit(500)) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }

  sendInit(message: object): void {
    if (!this.child.connected) throw new Error("Canal IPC indisponível ao iniciar sandbox.");
    this.child.send(message, (error) => {
      if (error) this.fail(error);
    });
  }
}

/**
 * Coordinates one Node.js child process per sandbox. Process isolation is not,
 * by itself, a complete security boundary for hostile native code.
 */
export class WexelOrchester {
  private readonly sandboxes = new Map<string, ManagedSandbox>();
  private readonly coreBytes: Uint8Array;
  private readonly workerPath: string;

  private constructor(private readonly options: WexelOrchesterOptions) {
    if (!options.coreBytes || options.coreBytes.byteLength === 0) {
      throw new Error("WexelOrchester requer um artefato Wexel Core não vazio.");
    }
    const source = options.coreBytes;
    this.coreBytes = source instanceof ArrayBuffer
      ? new Uint8Array(source.slice(0))
      : new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    this.workerPath = options.workerPath ?? fileURLToPath(new URL("./wexel-orchester-worker.js", import.meta.url));
  }

  static create(options: WexelOrchesterOptions): WexelOrchester {
    return new WexelOrchester(options);
  }

  listSandboxes(): Array<{ id: string; pid?: number; status: WexelOrchesterSandbox["status"] }> {
    return [...this.sandboxes.values()].map(({ id, pid, status }) => ({ id, pid, status }));
  }

  getSandbox(id: string): WexelOrchesterSandbox | undefined { return this.sandboxes.get(id); }

  async createSandbox(options: { id?: string; permissions?: WexelPermissions; storageQuotaBytes?: number } = {}): Promise<WexelOrchesterSandbox> {
    const id = options.id ?? this.generateId();
    if (!/^[A-Z]{3}$/.test(id)) throw new Error("O ID da sandbox deve conter exatamente três letras maiúsculas.");
    if (this.sandboxes.has(id)) throw new Error(`Sandbox já existe: ${id}`);

    const child = fork(this.workerPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
      execArgv: process.execArgv,
    });
    const sandbox = new ManagedSandbox(id, child, (event) => {
      try { this.options.onEvent?.(event); } catch { /* callbacks de observação não podem derrubar o orquestrador */ }
    }, this.options.shutdownTimeoutMs ?? 2000);
    this.sandboxes.set(id, sandbox);
    try {
      try {
        this.options.onEvent?.({ type: "sandbox-starting", sandboxId: id, pid: child.pid });
      } catch {
        // Callbacks de observação não podem impedir a inicialização da sandbox.
      }
      sandbox.sendInit({
        type: "init",
        coreBytes: new Uint8Array(this.coreBytes),
        permissions: options.permissions ?? this.options.permissions,
        storageQuotaBytes: options.storageQuotaBytes ?? this.options.storageQuotaBytes,
        homeDirectory: `/home/${id}`,
      });
      await sandbox.waitReady(this.options.startupTimeoutMs ?? 15000);
      return sandbox;
    } catch (error) {
      this.sandboxes.delete(id);
      await sandbox.stop().catch(() => undefined);
      throw error;
    }
  }

  async destroySandbox(id: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) return false;
    await sandbox.stop();
    this.sandboxes.delete(id);
    return true;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sandboxes.keys()].map((id) => this.destroySandbox(id)));
  }

  private generateId(): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let attempt = 0; attempt < 26 ** 3; attempt++) {
      let id = "";
      for (let i = 0; i < 3; i++) id += alphabet[randomInt(alphabet.length)];
      if (!this.sandboxes.has(id)) return id;
    }
    throw new Error("Não há IDs de três letras disponíveis.");
  }
}
