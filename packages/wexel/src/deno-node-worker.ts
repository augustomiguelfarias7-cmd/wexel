/**
 * deno-node-worker.ts — Wexel
 *
 * Equivalente Node.js do deno-wasm-runtime.ts (browser).
 *
 * Usa worker_threads em vez de Web Worker e
 * WebAssembly.Memory({ shared: true }) igual ao browser.
 *
 * Integração com NodeExecution:
 *   const executor = await NodeExecution.create({
 *     coreBytes,
 *     denoNodeWorker: true,   // ativa este adapter
 *   });
 *   const sandbox = await executor.createSandbox();
 *   // O Deno na sandbox usa worker_threads + WASM compartilhado + WebPink
 */

import { Worker, MessageChannel as NodeMC } from "node:worker_threads";
import type { ExecResult, WexelFileSystem } from "./index.js";
import { createWasmFsChannel, serveWasmFs } from "./deno-wasm-fs.js";
import { NetBridgeHost } from "./deno-net-bridge.js";
import { runDenoNative, resolvedenoBin } from "./deno-native-adapter.js";

export interface DenoNodeWorkerOptions {
  networkAllowed?: boolean;
  fetcher?:        typeof fetch;
  timeoutMs?:      number;
}

export interface DenoNodeWorkerExec {
  code:     string;
  language: "javascript" | "typescript";
  args?:    string[];
}

/**
 * Executa código Deno num worker_thread Node.js com:
 *   - WebAssembly.Memory({ shared: true }) — mesma memória entre threads
 *   - VFS via SAB (deno-wasm-fs.ts)
 *   - Rede via NetBridgeHost → WebPink (quando fetcher = webPink.fetch)
 */
export async function runDenoNodeWorker(
  fs:      WexelFileSystem,
  options: DenoNodeWorkerOptions,
  exec:    DenoNodeWorkerExec,
): Promise<ExecResult> {
  // JS e TS: Deno 2.3.5 nativo sempre que disponível
  const bin = await resolvedenoBin().catch(() => null);
  if (bin) {
    return runDenoNative(
      fs,
      { denoBin: bin, networkAllowed: options.networkAllowed, timeoutMs: options.timeoutMs },
      { code: exec.code, language: exec.language, args: exec.args },
    );
  }
  // Fallback: worker_thread com shim (sem binário nativo)

  // Memória WASM compartilhada entre thread principal e worker_thread
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });

  // Canal VFS via SAB
  const fsChannel = createWasmFsChannel();
  const stopFs    = serveWasmFs(fsChannel, fs);

  // Canais de rede e IO
  const { port1: netMain, port2: netWorker } = new NodeMC();
  const { port1: ioMain,  port2: ioWorker  } = new NodeMC();

  const netHost = new NetBridgeHost(
    netMain as unknown as MessagePort,
    options.fetcher ?? fetch,
    options.networkAllowed ?? false,
  );

  return new Promise<ExecResult>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => finish(1, "Timeout Deno (Node worker)\n"), options.timeoutMs)
      : undefined;

    function finish(exitCode: number, extra?: string): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stopFs();
      netHost.dispose();
      resolve({ stdout: stdout.join(""), stderr: stderr.join("") + (extra ?? ""), exitCode });
    }

    ioMain.on("message", (msg: { kind: string; text?: string; code?: number }) => {
      if      (msg.kind === "stdout") stdout.push(msg.text ?? "");
      else if (msg.kind === "stderr") stderr.push(msg.text ?? "");
      else if (msg.kind === "exit")   finish(msg.code ?? 0);
    });

    // worker_thread com o mesmo script inline do browser
    const worker = new Worker(getWorkerScript(), {
      eval: true,
      workerData: {
        fsSab:    fsChannel.sab,
        memBuf:   memory.buffer,
        home:     fs.home,
        code:     exec.code,
        language: exec.language,
        args:     exec.args ?? [],
      },
    });

    // Envia ports ao worker — transferList só aqui, não no workerData
    worker.postMessage(
      { type: "ports", netPort: netWorker, ioPort: ioWorker },
      [netWorker as unknown as ArrayBuffer, ioWorker as unknown as ArrayBuffer],
    );

    worker.on("error",  (err: Error) => finish(1, `worker_thread Deno: ${err.message}\n`));
    worker.on("exit",   (code) => finish(code ?? 1));
  });
}

/** Script do worker_thread — idêntico ao Web Worker do browser. */
function getWorkerScript(): string {
  return /* javascript */`
const { workerData, parentPort } = require("node:worker_threads");

const HEADER=8,CAP=512*1024,S_REQ=1,S_OK_BIN=2,S_FREE=0;
const ENC=new TextEncoder(),DEC=new TextDecoder();

const fsCtrl=new Int32Array(workerData.fsSab,0,2);
const fsBuf=new Uint8Array(workerData.fsSab,HEADER,CAP);

// Memória WASM compartilhada — mesma do thread principal
const wasmMem=new WebAssembly.Memory({initial:16,maximum:256,shared:true});
// (workerData.memBuf é o buffer compartilhado — usado se precisar acessar diretamente)

let netPort,ioPort;

parentPort.once("message",(msg)=>{
  netPort=msg.netPort; ioPort=msg.ioPort;
  netPort.on("message",(m)=>{ if(m.kind==="fetch-response"){netP.get(m.id)?.(m);netP.delete(m.id);} });
  boot();
});

function fsCall(m,a){
  const req=ENC.encode(JSON.stringify({method:m,args:a}));
  fsBuf.set(req.slice(0,CAP));
  Atomics.store(fsCtrl,1,Math.min(req.byteLength,CAP));
  Atomics.store(fsCtrl,0,S_REQ);
  Atomics.notify(fsCtrl,0);
  Atomics.wait(fsCtrl,0,S_REQ,30000);
  const status=Atomics.load(fsCtrl,0),size=Atomics.load(fsCtrl,1),bytes=fsBuf.slice(0,size);
  Atomics.store(fsCtrl,0,S_FREE);
  if(status===S_OK_BIN) return bytes;
  const r=JSON.parse(DEC.decode(bytes));
  if(r.error) throw new Error(r.error.message);
  return r.value;
}

let netId=0; const netP=new Map();
function bridgedFetch(url,init){
  const id="f"+(++netId),hdrs={};
  if(init?.headers)Object.assign(hdrs,init.headers);
  let body; if(init?.body){const r=typeof init.body==="string"?ENC.encode(init.body):new Uint8Array(init.body);body=[...r];}
  return new Promise((res,rej)=>{
    netP.set(id,(r)=>{
      if(r.error&&r.status===0){rej(new TypeError(r.error));return;}
      res(new Response(new Uint8Array(r.body),{status:r.status,headers:new Headers(r.headers)}));
    });
    netPort.postMessage({kind:"fetch",id,url:url.toString(),method:init?.method??"GET",headers:hdrs,body});
  });
}

function ts(src){
  return src
    // remove import type
    .replace(/import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['"][^'"]*['"]\\s*;?/g,"")
    // remove interface e type alias
    .replace(/^(export\\s+)?(interface|type)\\s+\\w[^{]*\\{[^}]*\\}/gm,"")
    // remove anotações ": Tipo" em parâmetros e variáveis (só antes de = ou , ou ) ou newline)
    .replace(/:\\s*[A-Z][A-Za-z0-9_<>\\[\\]|&,\\s.?]*(?=[=,)\\n;{])/g,"")
    // remove "as Tipo"
    .replace(/\\bas\\s+[A-Z][A-Za-z0-9_<>\\[\\]|&,\\s.?]*/g,"");
}

async function boot(){
  const home=workerData.home??"/home/wexel";
  const Vfs={
    read:(p)=>fsCall("read",[p]),
    readText:(p)=>fsCall("readText",[p]),
    write:(p,d)=>fsCall("write",[p,[...(d instanceof Uint8Array?d:ENC.encode(d))]]),
    exists:(p)=>fsCall("exists",[p]),
    list:()=>fsCall("list",[]),
    pwd:()=>fsCall("pwd",[]),
    home:()=>fsCall("home",[]),
    mkdir:(p)=>fsCall("mkdir",[p]),
    remove:(p)=>fsCall("remove",[p]),
    cd:(p)=>fsCall("cd",[p]),
  };
  global.Deno={
    readFile:(p)=>Promise.resolve(Vfs.read(p)),
    readTextFile:(p)=>Promise.resolve(Vfs.readText(p)),
    writeFile:(p,d)=>{Vfs.write(p,d);return Promise.resolve();},
    writeTextFile:(p,t)=>{Vfs.write(p,t);return Promise.resolve();},
    readFileSync:(p)=>Vfs.read(p),
    readTextFileSync:(p)=>Vfs.readText(p),
    writeFileSync:(p,d)=>Vfs.write(p,d),
    stat:(p)=>Promise.resolve({isFile:Vfs.exists(p),isDirectory:false,size:0}),
    mkdir:(p)=>{Vfs.mkdir(p);return Promise.resolve();},
    remove:(p)=>{Vfs.remove(p);return Promise.resolve();},
    readDir:(p)=>(async function*(){for(const n of Vfs.list())yield{name:n,isFile:true,isDirectory:false};})(),
    cwd:()=>Vfs.pwd(),chdir:(p)=>Vfs.cd(p),
    args:workerData.args??[],pid:1,ppid:0,
    build:{os:"linux",arch:"x86_64",target:"x86_64-unknown-linux-gnu"},
    version:{deno:"2.3.5-wexel",v8:"13.7.152.6",typescript:"5.8.3"},
    env:{
      get:(k)=>({HOME:home,PATH:"/bin:/usr/bin",DENO_DIR:home+"/.deno",TERM:"xterm-256color"})[k],
      set:()=>{},delete:()=>{},toObject:()=>({HOME:home,PATH:"/bin:/usr/bin"}),
    },
    exit:(code)=>{ioPort.postMessage({kind:"exit",code:code??0});process.exit(0);},
    fetch:bridgedFetch,
    permissions:{query:async()=>({state:"granted"}),request:async()=>({state:"granted"}),revoke:async()=>({state:"denied"})},
  };
  global.fetch=bridgedFetch;
  const fmt=(a)=>a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ");
  console.log=console.info=(...a)=>ioPort.postMessage({kind:"stdout",text:fmt(a)+"\\n"});
  console.warn=console.error=(...a)=>ioPort.postMessage({kind:"stderr",text:fmt(a)+"\\n"});

  let code=workerData.code;
  if(workerData.language==="typescript")code=ts(code);
  try{
    const AsyncFn=Object.getPrototypeOf(async function(){}).constructor;
    await new AsyncFn("Deno","fetch",code)(global.Deno,global.fetch);
    ioPort.postMessage({kind:"exit",code:0});
  }catch(err){
    ioPort.postMessage({kind:"stderr",text:String(err)+"\\n"});
    ioPort.postMessage({kind:"exit",code:1});
  }
}
`;
}
