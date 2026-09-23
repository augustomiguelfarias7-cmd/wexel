/**
 * Orquestrador do Deno para ambiente browser.
 *
 * Estratégia (inspirada no WebContainers):
 *   - O Deno roda num Web Worker dedicado
 *   - O filesystem é servido pelo WexelFileSystem via SharedArrayBuffer
 *     (Atomics.wait no Worker + serveVfsBridge na thread principal)
 *   - A rede usa um MessageChannel: o Worker pede, a thread principal executa
 *   - stdout/stderr são capturados via outro MessageChannel e devolvidos
 *     como ExecResult igual ao padrão do Wexel
 *
 * O Worker recebe como workerData (via postMessage inicial):
 *   {
 *     type:    "init",
 *     vfs:     VfsBridgeChannel,   // SAB ctrl + SAB data
 *     netPort: MessagePort,         // para NetBridgeWorker
 *     ioPort:  MessagePort,         // para capturar stdout/stderr
 *     code:    string,
 *     language:"javascript"|"typescript",
 *     args:    string[],
 *     home:    string,
 *   }
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { createVfsBridgeChannel, serveVfsBridge } from "./deno-vfs-bridge.js";
import { NetBridgeHost } from "./deno-net-bridge.js";

export interface DenoWorkerOptions {
  /** Fonte do script do Worker (URL ou blob URL do deno-worker-script.js). */
  workerScriptUrl: string | URL;
  /** Permissão de rede real. Padrão: false. */
  networkAllowed?: boolean;
  /** Fetcher de rede (fetch nativo ou WebPink). */
  fetcher?: typeof fetch;
  /** Timeout em ms para execução. Padrão: 30 000. */
  timeoutMs?: number;
}

export interface DenoWorkerExecOptions {
  code:     string;
  language: "javascript" | "typescript";
  args?:    string[];
}

/** Mensagem de I/O enviada do Worker para a thread principal. */
export type WorkerIoMessage =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "exit";   code: number };

/**
 * Lança uma execução Deno num Web Worker isolado e aguarda o resultado.
 * Cada chamada é independente — o Worker é criado e destruído por execução.
 */
export async function runDenoWorker(
  fs: WexelFileSystem,
  options: DenoWorkerOptions,
  exec: DenoWorkerExecOptions,
): Promise<ExecResult> {
  const channel     = createVfsBridgeChannel();
  const { port1: netMain, port2: netWorker } = new MessageChannel();
  const { port1: ioMain,  port2: ioWorker  } = new MessageChannel();

  // Serve o VFS na thread principal (poll assíncrono)
  const stopVfs = serveVfsBridge(channel, fs);

  // Escuta requisições de rede no lado principal
  const netHost = new NetBridgeHost(
    netMain,
    options.fetcher ?? fetch,
    options.networkAllowed ?? false,
  );

  const worker = new Worker(options.workerScriptUrl, { type: "module" });

  return new Promise<ExecResult>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timeout = options.timeoutMs !== undefined
      ? setTimeout(() => finish(1, "Timeout de execução Deno excedido\n"), options.timeoutMs)
      : undefined;

    function finish(exitCode: number, stderrExtra?: string): void {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      stopVfs();
      netHost.dispose();
      worker.terminate();
      resolve({
        stdout:   stdout.join(""),
        stderr:   stderr.join("") + (stderrExtra ?? ""),
        exitCode,
      });
    }

    // Captura stdout/stderr/exit do Worker
    ioMain.onmessage = (ev: MessageEvent<WorkerIoMessage>) => {
      const msg = ev.data;
      if (msg.kind === "stdout") stdout.push(msg.text);
      else if (msg.kind === "stderr") stderr.push(msg.text);
      else if (msg.kind === "exit") finish(msg.code);
    };

    worker.onerror = (ev) => {
      finish(1, `Erro interno do Worker Deno: ${ev.message}\n`);
    };

    // Inicializa o Worker
    worker.postMessage(
      {
        type:     "init",
        vfs:      channel,
        home:     fs.home,
        code:     exec.code,
        language: exec.language,
        args:     exec.args ?? [],
      },
      // Transfere as portas (não são clonable — devem ser transferidas)
      [netWorker, ioWorker],
    );

    // Envia as portas num segundo postMessage (após init) para que o Worker
    // possa registrar os handlers antes de recebê-las
    worker.postMessage({ type: "ports", netPort: netWorker, ioPort: ioWorker });
  });
}

/**
 * Gera o código-fonte do script do Worker como um Blob URL.
 * Isso permite embutir o Worker sem precisar de um arquivo separado
 * quando o consumidor não tem controle sobre o bundler.
 */
export function createDenoWorkerBlobUrl(): string {
  const src = getDenoWorkerScript();
  const blob = new Blob([src], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}

/**
 * Script executado dentro do Web Worker.
 * Intercepta Deno.readFile, Deno.writeFile, fetch e WebSocket,
 * redirecionando tudo para os bridges da thread principal.
 *
 * O script é uma string para ser injetada via Blob URL —
 * não pode importar módulos externos.
 */
function getDenoWorkerScript(): string {
  return /* javascript */`
// Wexel — Deno Worker Script (gerado em runtime)
// Roda dentro de um Web Worker isolado.

let vfsCtrl, vfsBuf, netPort, ioPort;
let initData;

self.onmessage = (ev) => {
  if (ev.data.type === "init") {
    initData = ev.data;
    // As portas chegam transferidas junto com "init"
    netPort = ev.data.netPort;
    ioPort  = ev.data.ioPort;
    const ch = ev.data.vfs;
    vfsCtrl  = new Int32Array(ch.ctrl);
    vfsBuf   = new Uint8Array(ch.data);
    // aguarda as portas antes de executar
    if (netPort && ioPort) startExecution();
  } else if (ev.data.type === "ports") {
    // fallback: portas enviadas em mensagem separada
    if (!netPort) netPort = ev.data.netPort;
    if (!ioPort)  ioPort  = ev.data.ioPort;
    if (initData) startExecution();
  }
};

// ─── VFS client síncrono ────────────────────────────────────────────────────

const IDX_LOCK = 0, IDX_SIZE = 1, IDX_OK = 2;
const MAX_PAYLOAD = 4 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

function vfsCall(req) {
  const reqBytes = enc.encode(JSON.stringify(req));
  vfsBuf.set(reqBytes);
  Atomics.store(vfsCtrl, IDX_SIZE, reqBytes.byteLength);
  Atomics.store(vfsCtrl, IDX_LOCK, 1);
  Atomics.notify(vfsCtrl, IDX_LOCK);
  Atomics.wait(vfsCtrl, IDX_LOCK, 1);
  const ok   = Atomics.load(vfsCtrl, IDX_OK) === 1;
  const size = Atomics.load(vfsCtrl, IDX_SIZE);
  const pay  = vfsBuf.slice(0, size);
  Atomics.store(vfsCtrl, IDX_LOCK, 0);
  return { ok, payload: pay };
}

const DenoVfs = {
  read(path) {
    const r = vfsCall({ op: "read", path });
    if (!r.ok) throw new Error(dec.decode(r.payload));
    return r.payload;
  },
  write(path, data) {
    const r = vfsCall({ op: "write", path, data: [...(data instanceof Uint8Array ? data : enc.encode(data))] });
    if (!r.ok) throw new Error(dec.decode(r.payload));
  },
  exists(path) {
    const r = vfsCall({ op: "exists", path });
    if (!r.ok) return false;
    return dec.decode(r.payload) === "1";
  },
  list(path) {
    const r = vfsCall({ op: "list", path: path ?? "" });
    if (!r.ok) throw new Error(dec.decode(r.payload));
    return JSON.parse(dec.decode(r.payload));
  },
  mkdir(path) {
    const r = vfsCall({ op: "mkdir", path });
    if (!r.ok) throw new Error(dec.decode(r.payload));
  },
  remove(path) {
    const r = vfsCall({ op: "remove", path });
    if (!r.ok) throw new Error(dec.decode(r.payload));
  },
  cwd() {
    const r = vfsCall({ op: "cwd" });
    return r.ok ? dec.decode(r.payload) : "/";
  },
  cd(path) {
    vfsCall({ op: "cd", path });
  },
};

// ─── Net bridge (async via MessagePort) ─────────────────────────────────────

let netCounter = 0;
const netPending = new Map();

function netDispatch(msg) {
  if (msg.kind === "fetch-response") {
    const p = netPending.get(msg.id);
    if (p) { p(msg); netPending.delete(msg.id); }
  }
}

function bridgedFetch(url, init) {
  const id   = "nf-" + (++netCounter);
  const hdrs = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) init.headers.forEach((v,k) => hdrs[k]=v);
    else if (Array.isArray(init.headers)) init.headers.forEach(([k,v]) => hdrs[k]=v);
    else Object.assign(hdrs, init.headers);
  }
  let body;
  if (init?.body) {
    if (typeof init.body === "string") body = [...enc.encode(init.body)];
    else body = [...new Uint8Array(init.body)];
  }
  return new Promise((resolve, reject) => {
    netPending.set(id, (resp) => {
      if (resp.error && resp.status === 0) { reject(new TypeError(resp.error)); return; }
      resolve(new Response(new Uint8Array(resp.body), { status: resp.status, headers: new Headers(resp.headers) }));
    });
    netPort.postMessage({ kind: "fetch", id, url: url instanceof URL ? url.href : url, method: init?.method ?? "GET", headers: hdrs, body });
  });
}

// ─── Shim do Deno ────────────────────────────────────────────────────────────

function shimDeno(home) {
  const DenoShim = {
    // ── I/O ────────────────────────────────────────────────────────────────
    readFile:    (path)       => Promise.resolve(DenoVfs.read(path)),
    readTextFile:(path)       => Promise.resolve(dec.decode(DenoVfs.read(path))),
    writeFile:   (path, data) => { DenoVfs.write(path, data); return Promise.resolve(); },
    writeTextFile:(path, text) => { DenoVfs.write(path, enc.encode(text)); return Promise.resolve(); },
    readFileSync: (path)      => DenoVfs.read(path),
    readTextFileSync:(path)   => dec.decode(DenoVfs.read(path)),
    writeFileSync:(path,data) => DenoVfs.write(path, data),
    stat:  (path) => Promise.resolve({ isFile: DenoVfs.exists(path), isDirectory: false, size: 0 }),
    lstat: (path) => Promise.resolve({ isFile: DenoVfs.exists(path), isDirectory: false, size: 0 }),
    mkdir: (path) => { DenoVfs.mkdir(path); return Promise.resolve(); },
    remove:(path) => { DenoVfs.remove(path); return Promise.resolve(); },
    readDir:(path) => {
      const entries = DenoVfs.list(path);
      return (async function*() { for (const name of entries) yield { name, isFile: true, isDirectory: false }; })();
    },
    cwd:   () => DenoVfs.cwd(),
    chdir: (path) => DenoVfs.cd(path),
    // ── env / processo ─────────────────────────────────────────────────────
    env: {
      get:    (k)    => ({ HOME: home, DENO_DIR: home + "/.deno", PATH: "/bin" })[k] ?? undefined,
      set:    ()     => {},
      delete: ()     => {},
      toObject: ()   => ({ HOME: home, DENO_DIR: home + "/.deno", PATH: "/bin" }),
    },
    args: [],
    pid:  1,
    ppid: 0,
    build: { os: "linux", arch: "x86_64", vendor: "unknown", target: "x86_64-unknown-linux-gnu" },
    version: { deno: "2.0.0-wexel", v8: "12.0.0", typescript: "5.0.0" },
    // ── saída ──────────────────────────────────────────────────────────────
    exit: (code) => {
      ioPort.postMessage({ kind: "exit", code: code ?? 0 });
      self.close();
    },
    // ── fetch ──────────────────────────────────────────────────────────────
    fetch: bridgedFetch,
    // ── permissões (stub — o Wexel controla) ───────────────────────────────
    permissions: {
      query:  async () => ({ state: "granted" }),
      request:async () => ({ state: "granted" }),
      revoke: async () => ({ state: "denied" }),
    },
  };
  return DenoShim;
}

// ─── Captura de console ───────────────────────────────────────────────────────

function shimConsole() {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const fmtArgs = (args) => args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  console.log   = (...args) => { ioPort.postMessage({ kind: "stdout", text: fmtArgs(args) + "\\n" }); };
  console.info  = console.log;
  console.warn  = (...args) => { ioPort.postMessage({ kind: "stderr", text: "[warn] " + fmtArgs(args) + "\\n" }); };
  console.error = (...args) => { ioPort.postMessage({ kind: "stderr", text: "[error] " + fmtArgs(args) + "\\n" }); };
}

// ─── Execução ────────────────────────────────────────────────────────────────

async function startExecution() {
  if (!vfsCtrl || !netPort || !ioPort) return;

  netPort.onmessage = (ev) => netDispatch(ev.data);

  const home = initData.home ?? "/home/wexel";
  self.Deno = shimDeno(home);
  self.fetch = bridgedFetch;
  shimConsole();

  // injeta os args no Deno.args
  self.Deno.args = initData.args ?? [];

  let code = initData.code;

  // TypeScript: transpila para JS (transpilação básica: remove anotações de tipo)
  if (initData.language === "typescript") {
    code = transpileTs(code);
  }

  try {
    const fn = new Function("Deno", "fetch", code);
    const result = fn(self.Deno, self.fetch);
    if (result && typeof result.then === "function") {
      await result;
    }
    ioPort.postMessage({ kind: "exit", code: 0 });
  } catch (err) {
    ioPort.postMessage({ kind: "stderr", text: String(err) + "\\n" });
    ioPort.postMessage({ kind: "exit", code: 1 });
  }
}

// ─── Transpilador TypeScript mínimo ──────────────────────────────────────────
// Remove anotações de tipo suficientes para rodar código TS simples.
// Para produção, substituir por @deno/emit ou esbuild-wasm.

function transpileTs(src) {
  return src
    // remove type imports: import type { X } from "..."
    .replace(/import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['"][^'"]*['"]\\s*;?/g, "")
    // remove inline type annotations: ": Type" em parâmetros e variáveis
    .replace(/:\\s*[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g, "")
    // remove <Type> type assertions (não JSX)
    .replace(/<[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*>/g, "")
    // remove "as Type"
    .replace(/\\bas\\s+[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g, "")
    // interface / type declarations
    .replace(/^(export\\s+)?(interface|type)\\s+[A-Za-z0-9]+[\\s\\S]*?^}/gm, "");
}
`;
}
