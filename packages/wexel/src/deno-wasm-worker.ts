/**
 * deno-wasm-worker.ts — Wexel
 *
 * Orquestrador do Deno no browser.
 *
 * Cria um Web Worker que recebe:
 *   - WasmFsChannel (SAB) → VFS síncrono via Atomics.wait
 *   - MessagePort (net)   → fetch/WebSocket reais do browser
 *   - MessagePort (io)    → stdout/stderr/exit
 *
 * O Worker instala um shim global `Deno` que usa o WasmFsClient
 * para todas as operações de filesystem — o Deno acha que está
 * num Linux com acesso real ao disco.
 *
 * A rede usa fetch nativo do browser via NetBridgeHost (já existente).
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { createWasmFsChannel, serveWasmFs } from "./deno-wasm-fs.js";
import { NetBridgeHost } from "./deno-net-bridge.js";

export interface DenoWasmWorkerOptions {
  networkAllowed?: boolean;
  fetcher?:        typeof fetch;
  timeoutMs?:      number;
}

export interface DenoWasmExecOptions {
  code:     string;
  language: "javascript" | "typescript";
  args?:    string[];
}

/** Lança o Deno num Web Worker com VFS real e rede real. */
export async function runDenoWasmWorker(
  fs:      WexelFileSystem,
  options: DenoWasmWorkerOptions,
  exec:    DenoWasmExecOptions,
): Promise<ExecResult> {
  const fsChannel = createWasmFsChannel();
  const { port1: netMain,  port2: netWorker  } = new MessageChannel();
  const { port1: ioMain,   port2: ioWorker   } = new MessageChannel();

  // Serve VFS na thread principal
  const stopFs = serveWasmFs(fsChannel, fs);

  // Serve rede na thread principal
  const netHost = new NetBridgeHost(netMain, options.fetcher ?? fetch, options.networkAllowed ?? false);

  // Gera o script do Worker inline (sem arquivo externo)
  const src  = buildWorkerScript();
  const blob = new Blob([src], { type: "application/javascript" });
  const url  = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: "module" });
  URL.revokeObjectURL(url);

  return new Promise<ExecResult>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => finish(1, "Timeout de execução Deno excedido\n"), options.timeoutMs)
      : undefined;

    function finish(exitCode: number, extra?: string): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stopFs();
      netHost.dispose();
      worker.terminate();
      resolve({ stdout: stdout.join(""), stderr: stderr.join("") + (extra ?? ""), exitCode });
    }

    ioMain.onmessage = (ev: MessageEvent<{ kind: string; text?: string; code?: number }>) => {
      const m = ev.data;
      if (m.kind === "stdout") stdout.push(m.text ?? "");
      else if (m.kind === "stderr") stderr.push(m.text ?? "");
      else if (m.kind === "exit") finish(m.code ?? 0);
    };

    worker.onerror = (ev) => finish(1, `Erro no Worker Deno: ${ev.message}\n`);

    // Init — envia channel e ports para o Worker
    worker.postMessage(
      { type: "init", fsSab: fsChannel.sab, home: fs.home, code: exec.code, language: exec.language, args: exec.args ?? [] },
      [netWorker, ioWorker],
    );
    // Ports em mensagem separada para garantir recebimento após init
    worker.postMessage({ type: "ports", netPort: netWorker, ioPort: ioWorker });
  });
}

// ── Script do Worker ──────────────────────────────────────────────────────────

function buildWorkerScript(): string {
  return /* javascript */`
// Wexel — Deno WASM Worker
// VFS síncrono via SAB + rede real via MessagePort

const HEADER = 8, CAP = 512 * 1024;
const S_REQUEST = 1, S_OK_BIN = 2, S_OK_JSON = 3, S_ERROR = 4, S_FREE = 0;
const ENC = new TextEncoder(), DEC = new TextDecoder();

let fsCtrl, fsBuf, netPort, ioPort, initData;

self.onmessage = (ev) => {
  if (ev.data.type === "init") {
    initData = ev.data;
    fsCtrl   = new Int32Array(ev.data.fsSab, 0, 2);
    fsBuf    = new Uint8Array(ev.data.fsSab, HEADER, CAP);
    netPort  = ev.data.netPort;
    ioPort   = ev.data.ioPort;
    if (netPort && ioPort) boot();
  } else if (ev.data.type === "ports") {
    if (!netPort) { netPort = ev.data.netPort; ioPort = ev.data.ioPort; }
    if (initData) boot();
  }
};

// ── VFS síncrono ──────────────────────────────────────────────────────────────

function fsCall(method, args) {
  const req = ENC.encode(JSON.stringify({ method, args }));
  fsBuf.set(req.slice(0, CAP));
  Atomics.store(fsCtrl, 1, Math.min(req.byteLength, CAP));
  Atomics.store(fsCtrl, 0, S_REQUEST);
  Atomics.notify(fsCtrl, 0);
  Atomics.wait(fsCtrl, 0, S_REQUEST, 30000);
  const status = Atomics.load(fsCtrl, 0);
  const size   = Atomics.load(fsCtrl, 1);
  const bytes  = fsBuf.slice(0, size);
  Atomics.store(fsCtrl, 0, S_FREE);
  if (status === S_OK_BIN) return bytes;
  const r = JSON.parse(DEC.decode(bytes));
  if (r.error) throw new Error(r.error.message);
  return r.value;
}

const Vfs = {
  read:    (p)    => fsCall("read",    [p]),
  readText:(p)    => fsCall("readText",[p]),
  write:   (p, d) => fsCall("write",   [p, [...(d instanceof Uint8Array ? d : ENC.encode(d))]]),
  exists:  (p)    => fsCall("exists",  [p]),
  list:    ()     => fsCall("list",    []),
  mkdir:   (p)    => fsCall("mkdir",   [p]),
  remove:  (p)    => fsCall("remove",  [p]),
  pwd:     ()     => fsCall("pwd",     []),
  cd:      (p)    => fsCall("cd",      [p]),
  home:    ()     => fsCall("home",    []),
};

// ── Rede (async via MessagePort) ──────────────────────────────────────────────

let netId = 0;
const netPending = new Map();

function initNet() {
  netPort.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind === "fetch-response") { netPending.get(m.id)?.(m); netPending.delete(m.id); }
  };
}

function bridgedFetch(url, init) {
  const id   = "f" + (++netId);
  const hdrs = {};
  if (init?.headers instanceof Headers) init.headers.forEach((v,k) => hdrs[k]=v);
  else if (init?.headers) Object.assign(hdrs, init.headers);
  let body;
  if (init?.body) {
    const raw = typeof init.body === "string" ? ENC.encode(init.body) : new Uint8Array(init.body);
    body = [...raw];
  }
  return new Promise((resolve, reject) => {
    netPending.set(id, (r) => {
      if (r.error && r.status === 0) { reject(new TypeError(r.error)); return; }
      resolve(new Response(new Uint8Array(r.body), { status: r.status, headers: new Headers(r.headers) }));
    });
    netPort.postMessage({ kind:"fetch", id, url: url.toString(), method: init?.method??"GET", headers:hdrs, body });
  });
}

// ── Shim Deno ─────────────────────────────────────────────────────────────────

function buildDeno(home, args) {
  return {
    // Filesystem
    readFile:      (p)    => Promise.resolve(Vfs.read(p)),
    readTextFile:  (p)    => Promise.resolve(Vfs.readText(p)),
    writeFile:     (p, d) => { Vfs.write(p, d); return Promise.resolve(); },
    writeTextFile: (p, t) => { Vfs.write(p, t); return Promise.resolve(); },
    readFileSync:  (p)    => Vfs.read(p),
    readTextFileSync:(p)  => Vfs.readText(p),
    writeFileSync: (p, d) => Vfs.write(p, d),
    stat:  (p) => Promise.resolve({ isFile: Vfs.exists(p), isDirectory: false, size: 0 }),
    lstat: (p) => Promise.resolve({ isFile: Vfs.exists(p), isDirectory: false, size: 0 }),
    mkdir: (p) => { Vfs.mkdir(p); return Promise.resolve(); },
    remove:(p) => { Vfs.remove(p); return Promise.resolve(); },
    readDir: (p) => (async function*(){ for (const n of Vfs.list()) yield {name:n,isFile:true,isDirectory:false}; })(),
    cwd:   ()  => Vfs.pwd(),
    chdir: (p) => Vfs.cd(p),
    // Processo
    args, pid: 1, ppid: 0,
    build: { os:"linux", arch:"x86_64", target:"x86_64-unknown-linux-gnu" },
    version: { deno:"2.3.5-wexel", v8:"13.7.152.6", typescript:"5.8.3" },
    env: {
      get: (k) => ({HOME:home,PATH:"/bin:/usr/bin",DENO_DIR:home+"/.deno",TERM:"xterm-256color"})[k],
      set:()=>{}, delete:()=>{}, toObject:()=>({HOME:home,PATH:"/bin:/usr/bin"}),
    },
    // Saída
    exit: (code) => { ioPort.postMessage({kind:"exit",code:code??0}); self.close(); },
    // Rede
    fetch: bridgedFetch,
    permissions: { query:async()=>({state:"granted"}), request:async()=>({state:"granted"}), revoke:async()=>({state:"denied"}) },
  };
}

// ── Transpilador TS mínimo ────────────────────────────────────────────────────

function transpileTs(src) {
  return src
    .replace(/import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['"][^'"]*['"]\\s*;?/g,"")
    .replace(/:\\s*[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g,"")
    .replace(/<[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*>/g,"")
    .replace(/\\bas\\s+[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g,"")
    .replace(/^(export\\s+)?(interface|type)\\s+[\\s\\S]*?^}/gm,"");
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  if (!fsCtrl || !netPort || !ioPort) return;
  initNet();

  const home = initData.home ?? "/home/wexel";
  self.Deno  = buildDeno(home, initData.args ?? []);
  self.fetch = bridgedFetch;

  // captura console → ioPort
  const fmt = (a) => a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ");
  self.console = {
    log:  (...a) => ioPort.postMessage({kind:"stdout",text:fmt(a)+"\\n"}),
    info: (...a) => ioPort.postMessage({kind:"stdout",text:fmt(a)+"\\n"}),
    warn: (...a) => ioPort.postMessage({kind:"stderr",text:"[warn] "+fmt(a)+"\\n"}),
    error:(...a) => ioPort.postMessage({kind:"stderr",text:"[error] "+fmt(a)+"\\n"}),
  };

  let code = initData.code;
  if (initData.language === "typescript") code = transpileTs(code);

  try {
    const fn = new Function("Deno","fetch", code);
    const r  = fn(self.Deno, self.fetch);
    if (r?.then) await r;
    ioPort.postMessage({kind:"exit",code:0});
  } catch(err) {
    ioPort.postMessage({kind:"stderr",text:String(err)+"\\n"});
    ioPort.postMessage({kind:"exit",code:1});
  }
}
`;
}
