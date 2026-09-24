/**
 * deno-wasm-fs.ts — Wexel
 *
 * Bridge de filesystem síncrona entre o Web Worker que roda o Deno
 * e o VFS do Wexel na thread principal.
 *
 * Protocolo: idêntico ao usado internamente pelo Wexel para WASIX —
 * SharedArrayBuffer com cabeçalho de controle Int32 + payload binário.
 *
 * Layout do SharedArrayBuffer:
 *   [0] Int32 — lock: 0=livre, 1=pedido pendente, 2=resposta binária, 3=erro
 *   [1] Int32 — tamanho do payload em bytes
 *   [8..] Uint8 — payload (request JSON ou response bytes)
 */

import type { WexelFileSystem } from "./index.js";

const HEADER   = 8;           // bytes reservados para controle (2× Int32)
const CAPACITY = 512 * 1024;  // 512 KB por canal — mesmo limite do protocolo wasmer-js
const TIMEOUT  = 30_000;

const STATUS_FREE    = 0;
const STATUS_REQUEST = 1;
const STATUS_OK_BIN  = 2;
const STATUS_OK_JSON = 3;
const STATUS_ERROR   = 4;

export interface WasmFsChannel {
  sab: SharedArrayBuffer; // controle (8 bytes) + dados (CAPACITY bytes)
}

/** Cria o canal SAB que conecta o Worker ao VFS. */
export function createWasmFsChannel(): WasmFsChannel {
  return { sab: new SharedArrayBuffer(HEADER + CAPACITY) };
}

// ── Thread principal: serve o VFS ────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeResponse(ctrl: Int32Array, sab: SharedArrayBuffer, payload: Uint8Array, binary: boolean): void {
  const data = new Uint8Array(sab, HEADER, CAPACITY);
  const slice = payload.slice(0, CAPACITY);
  data.set(slice);
  Atomics.store(ctrl, 1, slice.byteLength);
  Atomics.store(ctrl, 0, binary ? STATUS_OK_BIN : STATUS_OK_JSON);
  Atomics.notify(ctrl, 0);
}

function writeError(ctrl: Int32Array, sab: SharedArrayBuffer, message: string): void {
  const bytes = enc.encode(JSON.stringify({ error: { message } }));
  const data  = new Uint8Array(sab, HEADER, CAPACITY);
  data.set(bytes.slice(0, CAPACITY));
  Atomics.store(ctrl, 1, Math.min(bytes.byteLength, CAPACITY));
  Atomics.store(ctrl, 0, STATUS_ERROR);
  Atomics.notify(ctrl, 0);
}

/**
 * Instala o servidor VFS na thread principal.
 * Fica em poll assíncrono aguardando pedidos do Worker.
 * Retorna uma função para parar o servidor.
 */
export function serveWasmFs(channel: WasmFsChannel, fs: WexelFileSystem): () => void {
  const ctrl    = new Int32Array(channel.sab, 0, 2);
  let   running = true;

  async function loop(): Promise<void> {
    while (running) {
      // espera request sem bloquear a event loop
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (!running) { resolve(); return; }
          if (Atomics.load(ctrl, 0) === STATUS_REQUEST) { resolve(); return; }
          setTimeout(check, 1);
        };
        check();
      });
      if (!running) break;

      // lê o pedido
      const size    = Atomics.load(ctrl, 1);
      const payload = new Uint8Array(channel.sab, HEADER, size);
      let req: { method: string; args: unknown[] };
      try {
        req = JSON.parse(dec.decode(payload)) as typeof req;
      } catch {
        writeError(ctrl, channel.sab, "JSON de pedido inválido");
        continue;
      }

      try {
        const result = dispatchFs(fs, req.method, req.args);
        if (result instanceof Uint8Array) {
          writeResponse(ctrl, channel.sab, result, true);
        } else {
          writeResponse(ctrl, channel.sab, enc.encode(JSON.stringify({ value: result })), false);
        }
      } catch (err) {
        writeError(ctrl, channel.sab, err instanceof Error ? err.message : String(err));
      }
    }
  }

  void loop();
  return () => { running = false; };
}

function dispatchFs(fs: WexelFileSystem, method: string, args: unknown[]): unknown {
  switch (method) {
    case "read":    return fs.read(args[0] as string);
    case "readText":return fs.readText(args[0] as string);
    case "write": {
      const data = args[1] instanceof Uint8Array
        ? args[1]
        : new Uint8Array(args[1] as number[]);
      fs.write(args[0] as string, data);
      return null;
    }
    case "exists":  return fs.exists(args[0] as string);
    case "list":    return fs.list();
    case "mkdir":   fs.mkdir(args[0] as string); return null;
    case "remove":  fs.remove(args[0] as string); return null;
    case "pwd":     return fs.pwd();
    case "cd":      fs.cd(args[0] as string); return null;
    case "home":    return fs.home;
    default:        throw new Error(`Método VFS desconhecido: ${method}`);
  }
}

// ── Worker: cliente síncrono do VFS ──────────────────────────────────────────

/**
 * Usado dentro do Web Worker que roda o Deno.
 * Cada chamada bloqueia via Atomics.wait até a resposta chegar.
 */
export class WasmFsClient {
  private readonly ctrl: Int32Array;
  private readonly data: Uint8Array;
  private readonly enc  = new TextEncoder();
  private readonly dec  = new TextDecoder();

  constructor(channel: WasmFsChannel) {
    this.ctrl = new Int32Array(channel.sab, 0, 2);
    this.data = new Uint8Array(channel.sab, HEADER, CAPACITY);
  }

  private call(method: string, args: unknown[]): unknown {
    const req   = this.enc.encode(JSON.stringify({ method, args }));
    this.data.set(req.slice(0, CAPACITY));
    Atomics.store(this.ctrl, 1, Math.min(req.byteLength, CAPACITY));
    Atomics.store(this.ctrl, 0, STATUS_REQUEST);
    Atomics.notify(this.ctrl, 0);

    const result = Atomics.wait(this.ctrl, 0, STATUS_REQUEST, TIMEOUT);
    if (result === "timed-out") throw Object.assign(new Error(`VFS ${method} timed out`), { code: "ETIMEDOUT" });

    const status = Atomics.load(this.ctrl, 0);
    const size   = Atomics.load(this.ctrl, 1);
    const bytes  = this.data.slice(0, size);
    Atomics.store(this.ctrl, 0, STATUS_FREE);

    if (status === STATUS_OK_BIN)  return bytes;
    const parsed = JSON.parse(this.dec.decode(bytes)) as { value?: unknown; error?: { message: string } };
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.value;
  }

  read(path: string): Uint8Array     { return this.call("read", [path]) as Uint8Array; }
  readText(path: string): string     { return this.call("readText", [path]) as string; }
  write(path: string, data: Uint8Array | number[]): void { this.call("write", [path, [...(data instanceof Uint8Array ? data : data)]]); }
  exists(path: string): boolean      { return this.call("exists", [path]) as boolean; }
  list(): string[]                   { return this.call("list", []) as string[]; }
  mkdir(path: string): void          { this.call("mkdir", [path]); }
  remove(path: string): void         { this.call("remove", [path]); }
  pwd(): string                      { return this.call("pwd", []) as string; }
  cd(path: string): void             { this.call("cd", [path]); }
  home(): string                     { return this.call("home", []) as string; }
}
