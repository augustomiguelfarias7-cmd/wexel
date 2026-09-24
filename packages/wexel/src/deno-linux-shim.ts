/**
 * deno-linux-shim.ts — Wexel
 *
 * Faz o Deno achar que está rodando num Linux real dentro do browser.
 * Não é um microkernel — é uma camada de ilusão que espelha:
 *
 *   1. Filesystem  → VFS do Wexel via SharedArrayBuffer (síncrono)
 *   2. Rede        → fetch/WebSocket reais do browser via MessageChannel
 *   3. Env/Proc    → variáveis de ambiente e processo falsos mas consistentes
 *
 * Instalação num Web Worker:
 *   import { installLinuxShim } from "./deno-linux-shim.js";
 *   installLinuxShim({ vfsChannel, netPort, ioPort, home });
 */

import type { VfsBridgeChannel } from "./deno-vfs-bridge.js";

export interface LinuxShimOptions {
  vfsChannel: VfsBridgeChannel;
  netPort:    MessagePort;
  ioPort:     MessagePort;
  home:       string;
  args?:      string[];
}

/** Instala o shim no contexto global (Web Worker). */
export function installLinuxShim(opts: LinuxShimOptions): void {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ctrl = new Int32Array(opts.vfsChannel.ctrl);
  const buf  = new Uint8Array(opts.vfsChannel.data);

  // ── VFS síncrono (Atomics.wait) ──────────────────────────────────────────

  function vfsCall(req: object): { ok: boolean; payload: Uint8Array } {
    const bytes = enc.encode(JSON.stringify(req));
    buf.set(bytes);
    Atomics.store(ctrl, 1, bytes.byteLength);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
    Atomics.wait(ctrl, 0, 1);
    const ok   = Atomics.load(ctrl, 2) === 1;
    const size = Atomics.load(ctrl, 1);
    const data = buf.slice(0, size);
    Atomics.store(ctrl, 0, 0);
    return { ok, payload: data };
  }

  // ── Net bridge (async via MessagePort) ───────────────────────────────────

  let netId = 0;
  const netPending = new Map<string, (r: unknown) => void>();

  opts.netPort.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { kind: string; id: string };
    if (msg.kind === "fetch-response") {
      netPending.get(msg.id)?.(msg);
      netPending.delete(msg.id);
    }
  };

  function bridgedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const id   = `f${++netId}`;
    const hdrs: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => { hdrs[k] = v; });
    } else if (init?.headers) {
      Object.assign(hdrs, init.headers);
    }
    let body: number[] | undefined;
    if (init?.body) {
      const raw = typeof init.body === "string" ? enc.encode(init.body) : new Uint8Array(init.body as ArrayBuffer);
      body = [...raw];
    }
    return new Promise((resolve, reject) => {
      netPending.set(id, (resp: unknown) => {
        const r = resp as { status: number; headers: Record<string,string>; body: number[]; error?: string };
        if (r.error && r.status === 0) { reject(new TypeError(r.error)); return; }
        resolve(new Response(new Uint8Array(r.body), { status: r.status, headers: new Headers(r.headers) }));
      });
      opts.netPort.postMessage({ kind: "fetch", id, url: url.toString(), method: init?.method ?? "GET", headers: hdrs, body });
    });
  }

  // ── Shim Deno completo ────────────────────────────────────────────────────

  const DenoShim = {
    // Filesystem
    readFile:      (p: string) => Promise.resolve(vfsCall({ op:"read",  path:p }).payload),
    readTextFile:  (p: string) => Promise.resolve(dec.decode(vfsCall({ op:"read", path:p }).payload)),
    writeFile:     (p: string, d: Uint8Array) => { vfsCall({ op:"write", path:p, data:[...d] }); return Promise.resolve(); },
    writeTextFile: (p: string, t: string)     => { vfsCall({ op:"write", path:p, data:[...enc.encode(t)] }); return Promise.resolve(); },
    readFileSync:  (p: string) => vfsCall({ op:"read", path:p }).payload,
    readTextFileSync: (p: string) => dec.decode(vfsCall({ op:"read", path:p }).payload),
    writeFileSync: (p: string, d: Uint8Array) => vfsCall({ op:"write", path:p, data:[...d] }),
    mkdir:  (p: string) => { vfsCall({ op:"mkdir",  path:p }); return Promise.resolve(); },
    remove: (p: string) => { vfsCall({ op:"remove", path:p }); return Promise.resolve(); },
    stat:   (p: string) => Promise.resolve({ isFile: vfsCall({ op:"exists", path:p }).ok, isDirectory: false, size: 0 }),
    lstat:  (p: string) => Promise.resolve({ isFile: vfsCall({ op:"exists", path:p }).ok, isDirectory: false, size: 0 }),
    readDir: (p: string) => {
      const r = vfsCall({ op:"list", path:p });
      const entries: string[] = r.ok ? JSON.parse(dec.decode(r.payload)) as string[] : [];
      return (async function*() { for (const name of entries) yield { name, isFile: true, isDirectory: false }; })();
    },
    cwd:   () => dec.decode(vfsCall({ op:"cwd" }).payload),
    chdir: (p: string) => vfsCall({ op:"cd", path:p }),

    // Processo / env
    args:  opts.args ?? [],
    pid:   1,
    ppid:  0,
    build: { os: "linux", arch: "x86_64", vendor: "unknown", target: "x86_64-unknown-linux-gnu" },
    version: { deno: "2.3.5-wexel", v8: "13.7.152.6", typescript: "5.8.3" },
    env: {
      get:    (k: string) => ({ HOME: opts.home, PATH: "/bin:/usr/bin", DENO_DIR: `${opts.home}/.deno`, TERM: "xterm-256color" })[k],
      set:    () => {},
      delete: () => {},
      toObject: () => ({ HOME: opts.home, PATH: "/bin:/usr/bin", DENO_DIR: `${opts.home}/.deno` }),
    },

    // Saída
    exit: (code?: number) => {
      opts.ioPort.postMessage({ kind: "exit", code: code ?? 0 });
      (self as unknown as { close(): void }).close();
    },

    // Rede real
    fetch: bridgedFetch,

    // Permissões (stub — Wexel controla)
    permissions: {
      query:  async () => ({ state: "granted" }),
      request:async () => ({ state: "granted" }),
      revoke: async () => ({ state: "denied"  }),
    },
  };

  // Captura console → ioPort
  const fmt = (a: unknown[]) => a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
  (self as unknown as Record<string,unknown>).console = {
    log:   (...a: unknown[]) => opts.ioPort.postMessage({ kind: "stdout", text: fmt(a) + "\n" }),
    info:  (...a: unknown[]) => opts.ioPort.postMessage({ kind: "stdout", text: fmt(a) + "\n" }),
    warn:  (...a: unknown[]) => opts.ioPort.postMessage({ kind: "stderr", text: "[warn] " + fmt(a) + "\n" }),
    error: (...a: unknown[]) => opts.ioPort.postMessage({ kind: "stderr", text: "[error] " + fmt(a) + "\n" }),
  };

  // Injeta no global
  (self as unknown as Record<string,unknown>).Deno  = DenoShim;
  (self as unknown as Record<string,unknown>).fetch = bridgedFetch;
}
