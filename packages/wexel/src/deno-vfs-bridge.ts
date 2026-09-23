import type { WexelFileSystem } from "./index.js";

/**
 * Protocolo de mensagem entre o Worker do Deno e a thread principal.
 * O Worker publica um pedido no canal de controle e bloqueia em Atomics.wait
 * até a thread principal escrever a resposta no SAB e sinalizar.
 */
export type VfsBridgeRequest =
  | { op: "read";   path: string }
  | { op: "write";  path: string; data: number[] }
  | { op: "exists"; path: string }
  | { op: "list";   path: string }
  | { op: "mkdir";  path: string }
  | { op: "remove"; path: string }
  | { op: "cwd" }
  | { op: "cd";     path: string }
  | { op: "home" };

export interface VfsBridgeResponse {
  ok: boolean;
  /** Bytes de resultado (read) ou lista JSON (list) codificados em UTF-8. */
  payload?: Uint8Array;
  error?: string;
}

/* Índices no Int32Array de sinalização (4 bytes cada):
 *   0 — lock: 0 = livre, 1 = request pendente, 2 = response pronta
 *   1 — tamanho do payload de resposta em bytes
 *   2 — flag ok: 1 = sucesso, 0 = erro
 */
const IDX_LOCK    = 0;
const IDX_SIZE    = 1;
const IDX_OK      = 2;
const CTRL_CELLS  = 3;
const MAX_PAYLOAD = 4 * 1024 * 1024; // 4 MB por operação

export interface VfsBridgeChannel {
  /** Int32Array de controle compartilhada (12 bytes). */
  ctrl: SharedArrayBuffer;
  /** Payload de dados compartilhado (MAX_PAYLOAD bytes). */
  data: SharedArrayBuffer;
}

/** Cria os dois SharedArrayBuffers que formam o canal VFS. */
export function createVfsBridgeChannel(): VfsBridgeChannel {
  return {
    ctrl: new SharedArrayBuffer(CTRL_CELLS * 4),
    data: new SharedArrayBuffer(MAX_PAYLOAD),
  };
}

/**
 * Lado da thread principal: fica em poll aguardando pedidos do Worker
 * e os executa contra o WexelFileSystem real.
 */
export function serveVfsBridge(
  channel: VfsBridgeChannel,
  fs: WexelFileSystem,
): () => void {
  const ctrl = new Int32Array(channel.ctrl);
  const buf  = new Uint8Array(channel.data);
  let running = true;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function writeResponse(resp: VfsBridgeResponse): void {
    const payload = resp.payload ?? (resp.error ? enc.encode(resp.error) : new Uint8Array(0));
    const slice   = payload.slice(0, MAX_PAYLOAD);
    buf.set(slice);
    Atomics.store(ctrl, IDX_SIZE, slice.byteLength);
    Atomics.store(ctrl, IDX_OK,   resp.ok ? 1 : 0);
    Atomics.store(ctrl, IDX_LOCK, 2); // resposta pronta
    Atomics.notify(ctrl, IDX_LOCK);
  }

  async function loop(): Promise<void> {
    while (running) {
      // espera por um pedido (poll com microtask gap para não bloquear a event loop)
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!running) { resolve(); return; }
          if (Atomics.load(ctrl, IDX_LOCK) === 1) { resolve(); return; }
          setTimeout(check, 1);
        };
        check();
      });

      if (!running) break;

      // lê o JSON do pedido que o Worker escreveu no início do buffer de dados
      const reqSize = Atomics.load(ctrl, IDX_SIZE);
      const reqJson = dec.decode(buf.slice(0, reqSize));
      let req: VfsBridgeRequest;
      try {
        req = JSON.parse(reqJson) as VfsBridgeRequest;
      } catch {
        writeResponse({ ok: false, error: "JSON de pedido VFS inválido" });
        continue;
      }

      try {
        switch (req.op) {
          case "read": {
            const bytes = fs.read(req.path);
            writeResponse({ ok: true, payload: bytes });
            break;
          }
          case "write": {
            fs.write(req.path, new Uint8Array(req.data));
            writeResponse({ ok: true });
            break;
          }
          case "exists": {
            const exists = fs.exists(req.path);
            writeResponse({ ok: true, payload: enc.encode(exists ? "1" : "0") });
            break;
          }
          case "list": {
            const prev = fs.pwd();
            if (req.path) fs.cd(req.path);
            const entries = fs.list();
            if (req.path) fs.cd(prev);
            writeResponse({ ok: true, payload: enc.encode(JSON.stringify(entries)) });
            break;
          }
          case "mkdir": {
            fs.mkdir(req.path);
            writeResponse({ ok: true });
            break;
          }
          case "remove": {
            fs.remove(req.path);
            writeResponse({ ok: true });
            break;
          }
          case "cwd": {
            writeResponse({ ok: true, payload: enc.encode(fs.pwd()) });
            break;
          }
          case "cd": {
            fs.cd(req.path);
            writeResponse({ ok: true });
            break;
          }
          case "home": {
            writeResponse({ ok: true, payload: enc.encode(fs.home) });
            break;
          }
          default: {
            writeResponse({ ok: false, error: `Operação VFS desconhecida` });
          }
        }
      } catch (err) {
        writeResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  void loop();
  return () => { running = false; };
}

/**
 * Lado do Worker: cliente síncrono do bridge VFS.
 * Usa Atomics.wait para bloquear até a thread principal responder —
 * exatamente como o Deno esperaria um syscall de filesystem real.
 */
export class VfsBridgeClient {
  private readonly ctrl: Int32Array;
  private readonly buf:  Uint8Array;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();

  constructor(channel: VfsBridgeChannel) {
    this.ctrl = new Int32Array(channel.ctrl);
    this.buf  = new Uint8Array(channel.data);
  }

  private call(req: VfsBridgeRequest): VfsBridgeResponse {
    const reqBytes = this.enc.encode(JSON.stringify(req));
    if (reqBytes.byteLength > MAX_PAYLOAD) {
      return { ok: false, error: "Pedido VFS excede MAX_PAYLOAD" };
    }

    // escreve o pedido no início do buffer de dados
    this.buf.set(reqBytes);
    Atomics.store(this.ctrl, IDX_SIZE, reqBytes.byteLength);
    // sinaliza que há um pedido pendente
    Atomics.store(this.ctrl, IDX_LOCK, 1);
    Atomics.notify(this.ctrl, IDX_LOCK);

    // bloqueia até a resposta chegar (lock === 2)
    Atomics.wait(this.ctrl, IDX_LOCK, 1);

    const ok      = Atomics.load(this.ctrl, IDX_OK) === 1;
    const size    = Atomics.load(this.ctrl, IDX_SIZE);
    const payload = this.buf.slice(0, size);

    // libera o lock
    Atomics.store(this.ctrl, IDX_LOCK, 0);

    return ok
      ? { ok: true,  payload }
      : { ok: false, error: this.dec.decode(payload) };
  }

  read(path: string): Uint8Array {
    const r = this.call({ op: "read", path });
    if (!r.ok) throw new Error(r.error ?? "VFS read falhou");
    return r.payload!;
  }

  write(path: string, data: Uint8Array): void {
    const r = this.call({ op: "write", path, data: [...data] });
    if (!r.ok) throw new Error(r.error ?? "VFS write falhou");
  }

  exists(path: string): boolean {
    const r = this.call({ op: "exists", path });
    if (!r.ok) throw new Error(r.error ?? "VFS exists falhou");
    return this.dec.decode(r.payload) === "1";
  }

  list(path?: string): string[] {
    const r = this.call({ op: "list", path: path ?? "" });
    if (!r.ok) throw new Error(r.error ?? "VFS list falhou");
    return JSON.parse(this.dec.decode(r.payload)) as string[];
  }

  mkdir(path: string): void {
    const r = this.call({ op: "mkdir", path });
    if (!r.ok) throw new Error(r.error ?? "VFS mkdir falhou");
  }

  remove(path: string): void {
    const r = this.call({ op: "remove", path });
    if (!r.ok) throw new Error(r.error ?? "VFS remove falhou");
  }

  cwd(): string {
    const r = this.call({ op: "cwd" });
    if (!r.ok) throw new Error(r.error ?? "VFS cwd falhou");
    return this.dec.decode(r.payload);
  }

  cd(path: string): void {
    const r = this.call({ op: "cd", path });
    if (!r.ok) throw new Error(r.error ?? "VFS cd falhou");
  }

  home(): string {
    const r = this.call({ op: "home" });
    if (!r.ok) throw new Error(r.error ?? "VFS home falhou");
    return this.dec.decode(r.payload);
  }
}
