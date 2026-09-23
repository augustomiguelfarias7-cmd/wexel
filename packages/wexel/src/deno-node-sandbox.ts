/**
 * Orquestrador do Deno para ambiente Node.js (NodeExecution).
 *
 * Estratégia:
 *   - O Deno nativo roda num worker_thread isolado
 *   - O VFS do Wexel é exposto via MessageChannel (IPC assíncrono)
 *     — em Node podemos usar worker_threads sem precisar de SAB+Atomics
 *   - A rede passa pelo WebPink da sandbox (ou fetch nativo se permitido)
 *   - stdout/stderr são capturados via streams do worker_thread
 *   - Cada sandbox do NodeExecution pode ter seu próprio worker thread Deno
 */

import {
  Worker,
  MessageChannel as NodeMessageChannel,
  type MessagePort as NodeMessagePort,
} from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { ExecResult, WexelFileSystem } from "./index.js";
import type { NetworkFetcher } from "./deno-net-bridge.js";
import type {
  VfsBridgeRequest,
  VfsBridgeResponse,
} from "./deno-vfs-bridge.js";

export interface DenoNodeSandboxOptions {
  /** Fetcher de rede: WebPink.fetch ou fetch nativo (quando network permitido). */
  fetcher?:        NetworkFetcher;
  networkAllowed?: boolean;
  /** Timeout em ms por execução. Padrão: 30 000. */
  timeoutMs?:      number;
}

export interface DenoNodeExecOptions {
  code:     string;
  language: "javascript" | "typescript";
  args?:    string[];
}

/** Mensagem de I/O do worker thread Deno para o thread principal. */
type WorkerIo =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "exit";   code: number };

/** Pedido VFS do worker thread para o thread principal. */
type VfsRequest  = VfsBridgeRequest & { id: string };
/** Resposta VFS do thread principal para o worker thread. */
type VfsResponse = VfsBridgeResponse & { id: string };

/** Pedido de rede do worker thread. */
interface NetRequest {
  kind:    "fetch";
  id:      string;
  url:     string;
  method:  string;
  headers: Record<string, string>;
  body?:   Uint8Array;
}
/** Resposta de rede do thread principal. */
interface NetResponse {
  kind:    "fetch-response";
  id:      string;
  status:  number;
  headers: Record<string, string>;
  body:    Uint8Array;
  error?:  string;
}

/**
 * Executa código Deno num worker_thread Node.js isolado.
 * O VFS da sandbox e a rede são servidos na thread principal.
 */
export async function runDenoNodeSandbox(
  fs: WexelFileSystem,
  options: DenoNodeSandboxOptions,
  exec: DenoNodeExecOptions,
): Promise<ExecResult> {
  const { port1: vfsMain, port2: vfsWorker } = new NodeMessageChannel();
  const { port1: netMain, port2: netWorker } = new NodeMessageChannel();
  const { port1: ioMain,  port2: ioWorker  } = new NodeMessageChannel();

  const stdout: string[] = [];
  const stderr: string[] = [];

  return new Promise<ExecResult>((resolve) => {
    let settled = false;

    const timeout = options.timeoutMs !== undefined
      ? setTimeout(() => finish(1, "Timeout Deno (Node sandbox) excedido\n"), options.timeoutMs)
      : undefined;

    function finish(exitCode: number, extraErr?: string): void {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      worker.terminate().catch(() => {});
      vfsMain.close();
      netMain.close();
      ioMain.close();
      resolve({
        stdout:   stdout.join(""),
        stderr:   stderr.join("") + (extraErr ?? ""),
        exitCode,
      });
    }

    // ── VFS server (thread principal) ────────────────────────────────────
    const enc = new TextEncoder();

    vfsMain.on("message", (rawReq: unknown) => {
      const req = rawReq as VfsRequest;
      let resp: VfsResponse;
      try {
        // Helper tipado para acessar propriedades da union
        const r = req as Record<string, unknown> & { id: string; op: string };
        const path   = (r["path"] as string | undefined) ?? "";
        const data   = (r["data"] as number[] | undefined);
        switch (r.op) {
          case "read":   resp = { id: r.id, ok: true,  payload: fs.read(path) }; break;
          case "write":  fs.write(path, new Uint8Array(data ?? [])); resp = { id: r.id, ok: true }; break;
          case "exists": resp = { id: r.id, ok: true,  payload: enc.encode(fs.exists(path) ? "1" : "0") }; break;
          case "list": {
            const prev = fs.pwd();
            if (path) fs.cd(path);
            const list = fs.list();
            if (path) fs.cd(prev);
            resp = { id: r.id, ok: true, payload: enc.encode(JSON.stringify(list)) };
            break;
          }
          case "mkdir":  fs.mkdir(path); resp = { id: r.id, ok: true }; break;
          case "remove": fs.remove(path); resp = { id: r.id, ok: true }; break;
          case "cwd":    resp = { id: r.id, ok: true, payload: enc.encode(fs.pwd()) }; break;
          case "cd":     fs.cd(path); resp = { id: r.id, ok: true }; break;
          case "home":   resp = { id: r.id, ok: true, payload: enc.encode(fs.home) }; break;
          default:       resp = { id: r.id, ok: false, error: "Operação VFS desconhecida" };
        }
      } catch (e) {
        const r = req as Record<string, unknown> & { id: string };
        resp = { id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      vfsMain.postMessage(resp);
    });

    // ── Net server (thread principal) ─────────────────────────────────────
    netMain.on("message", async (req: NetRequest) => {
      if (!options.networkAllowed) {
        netMain.postMessage({
          kind: "fetch-response", id: req.id, status: 403,
          headers: {}, body: Buffer.alloc(0),
          error: "Permissão de rede negada pelo Wexel",
        } satisfies NetResponse);
        return;
      }
      try {
        const fetcher = options.fetcher ?? fetch;
        const response = await fetcher(req.url, {
          method:  req.method,
          headers: req.headers,
          body:    req.body?.byteLength ? req.body.buffer as ArrayBuffer : undefined,
        });
        const rawBody = new Uint8Array(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => { headers[k] = v; });
        netMain.postMessage({
          kind: "fetch-response", id: req.id,
          status: response.status, headers, body: rawBody,
        } satisfies NetResponse);
      } catch (netErr) {
        netMain.postMessage({
          kind: "fetch-response", id: req.id, status: 0,
          headers: {}, body: new Uint8Array(0),
          error: netErr instanceof Error ? netErr.message : String(netErr),
        } satisfies NetResponse);
      }
    });

    // ── I/O do worker ─────────────────────────────────────────────────────
    ioMain.on("message", (msg: WorkerIo) => {
      if (msg.kind === "stdout") stdout.push(msg.text);
      else if (msg.kind === "stderr") stderr.push(msg.text);
      else if (msg.kind === "exit") finish(msg.code);
    });

    // ── Lança o worker thread ─────────────────────────────────────────────
    const worker = new Worker(getWorkerScript(), {
      eval: true,
      workerData: {
        code:     exec.code,
        language: exec.language,
        args:     exec.args ?? [],
        home:     fs.home,
      },
      transferList: [
        vfsWorker as unknown as ArrayBuffer,
        netWorker as unknown as ArrayBuffer,
        ioWorker  as unknown as ArrayBuffer,
      ],
    });

    // Envia as portas para o worker após a criação
    worker.postMessage(
      { vfsPort: vfsWorker, netPort: netWorker, ioPort: ioWorker },
      [
        vfsWorker as unknown as ArrayBuffer,
        netWorker as unknown as ArrayBuffer,
        ioWorker  as unknown as ArrayBuffer,
      ],
    );

    worker.on("error", (workerErr: Error) => {
      finish(1, `Erro interno do worker Deno (Node): ${workerErr.message}\n`);
    });
    worker.on("exit", (code) => {
      finish(code ?? 1);
    });
  });
}

/** Script do worker thread Node.js — emula o ambiente Deno. */
function getWorkerScript(): string {
  return /* javascript */`
const { workerData, parentPort, receiveMessageOnPort, MessageChannel } = require("node:worker_threads");

let vfsPort, netPort, ioPort;

// Recebe as portas enviadas pelo thread principal
parentPort.once("message", (msg) => {
  vfsPort = msg.vfsPort;
  netPort = msg.netPort;
  ioPort  = msg.ioPort;
  // Registra o listener de rede
  netPort.on("message", (resp) => dispatchNet(resp));
  startExecution();
});

// ─── VFS client (async via MessagePort) ──────────────────────────────────────

let vfsCounter = 0;
const vfsPending = new Map();

function vfsCall(req) {
  return new Promise((resolve) => {
    const id = "vfs-" + (++vfsCounter);
    vfsPending.set(id, resolve);
    vfsPort.postMessage({ ...req, id });
  });
}

// Resposta VFS
vfsPort && vfsPort.on("message", (resp) => {
  const p = vfsPending.get(resp.id);
  if (p) { p(resp); vfsPending.delete(resp.id); }
});

const dec = new TextDecoder();
const enc = new TextEncoder();

const DenoVfs = {
  async read(path)  { const r = await vfsCall({ op:"read",  path }); if (!r.ok) throw new Error(r.error); return r.payload; },
  async write(path,d){ await vfsCall({ op:"write", path, data:[...d] }); },
  async exists(path){ const r = await vfsCall({ op:"exists",path }); return r.ok && dec.decode(r.payload)==="1"; },
  async list(path)  { const r = await vfsCall({ op:"list",  path:path??"" }); return JSON.parse(dec.decode(r.payload)); },
  async mkdir(path) { await vfsCall({ op:"mkdir", path }); },
  async remove(path){ await vfsCall({ op:"remove",path }); },
  async cwd()       { const r = await vfsCall({ op:"cwd" }); return r.ok ? dec.decode(r.payload) : "/"; },
  async cd(path)    { await vfsCall({ op:"cd", path }); },
};

// ─── Net client ───────────────────────────────────────────────────────────────

let netCounter = 0;
const netPending = new Map();

function dispatchNet(msg) {
  const p = netPending.get(msg.id);
  if (p) { p(msg); netPending.delete(msg.id); }
}

function bridgedFetch(url, init) {
  const id = "nf-" + (++netCounter);
  const hdrs = {};
  if (init?.headers) Object.assign(hdrs, init.headers);
  let body;
  if (init?.body) {
    if (typeof init.body === "string") body = Buffer.from(enc.encode(init.body));
    else body = Buffer.from(init.body);
  }
  return new Promise((resolve, reject) => {
    netPending.set(id, (resp) => {
      if (resp.error && resp.status === 0) { reject(new TypeError(resp.error)); return; }
      resolve(new Response(resp.body, { status: resp.status, headers: new Headers(resp.headers) }));
    });
    netPort.postMessage({ kind: "fetch", id, url: url.toString(), method: init?.method??"GET", headers: hdrs, body });
  });
}

// ─── Shim Deno ────────────────────────────────────────────────────────────────

function buildDenoShim(home) {
  return {
    readFile:     (p)   => DenoVfs.read(p),
    readTextFile: (p)   => DenoVfs.read(p).then(b => dec.decode(b)),
    writeFile:    (p,d) => DenoVfs.write(p, d instanceof Uint8Array ? d : enc.encode(d)),
    writeTextFile:(p,t) => DenoVfs.write(p, enc.encode(t)),
    stat:  (p) => DenoVfs.exists(p).then(e => ({ isFile: e, isDirectory: false, size: 0 })),
    lstat: (p) => DenoVfs.exists(p).then(e => ({ isFile: e, isDirectory: false, size: 0 })),
    mkdir: (p) => DenoVfs.mkdir(p),
    remove:(p) => DenoVfs.remove(p),
    readDir:(p) => {
      return (async function*() {
        const entries = await DenoVfs.list(p);
        for (const name of entries) yield { name, isFile: true, isDirectory: false };
      })();
    },
    cwd:   () => DenoVfs.cwd(),
    chdir: (p) => DenoVfs.cd(p),
    env: {
      get: (k) => ({ HOME: home, PATH: "/bin", DENO_DIR: home+"/.deno" })[k],
      set: ()=>{}, delete:()=>{},
      toObject: () => ({ HOME: home, PATH: "/bin", DENO_DIR: home+"/.deno" }),
    },
    args: workerData.args ?? [],
    pid: 1, ppid: 0,
    build: { os: "linux", arch: "x86_64" },
    version: { deno: "2.0.0-wexel", v8: "12.0.0", typescript: "5.0.0" },
    exit: (code) => {
      ioPort.postMessage({ kind: "exit", code: code ?? 0 });
      process.exit(0);
    },
    fetch: bridgedFetch,
    permissions: {
      query:  async () => ({ state: "granted" }),
      request:async () => ({ state: "granted" }),
      revoke: async () => ({ state: "denied" }),
    },
  };
}

// ─── Captura console ──────────────────────────────────────────────────────────

function shimConsole() {
  const fmt = (args) => args.map(a => typeof a==="string"?a:JSON.stringify(a)).join(" ");
  console.log  = console.info = (...a) => ioPort.postMessage({ kind:"stdout", text: fmt(a)+"\\n" });
  console.warn = console.error     = (...a) => ioPort.postMessage({ kind:"stderr", text: fmt(a)+"\\n" });
}

// ─── Transpilador TS mínimo ───────────────────────────────────────────────────

function transpileTs(src) {
  return src
    .replace(/import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['"][^'"]*['"]\\s*;?/g, "")
    .replace(/:\\s*[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g, "")
    .replace(/<[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*>/g, "")
    .replace(/\\bas\\s+[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g, "")
    .replace(/^(export\\s+)?(interface|type)\\s+[A-Za-z0-9]+[\\s\\S]*?^}/gm, "");
}

// ─── Execução ─────────────────────────────────────────────────────────────────

async function startExecution() {
  const home = workerData.home ?? "/home/wexel";
  global.Deno  = buildDenoShim(home);
  global.fetch = bridgedFetch;
  shimConsole();

  let code = workerData.code;
  if (workerData.language === "typescript") code = transpileTs(code);

  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    await new AsyncFunction("Deno", "fetch", code)(global.Deno, global.fetch);
    ioPort.postMessage({ kind: "exit", code: 0 });
  } catch (err) {
    ioPort.postMessage({ kind: "stderr", text: String(err) + "\\n" });
    ioPort.postMessage({ kind: "exit",   code: 1 });
  }
}
`;
}
