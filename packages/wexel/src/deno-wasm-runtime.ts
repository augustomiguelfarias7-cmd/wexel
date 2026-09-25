/**
 * deno-wasm-runtime.ts — Wexel
 *
 * Instancia o deno-runtime.wasm com memória compartilhada e
 * injeta as bridges de FS e rede como imports do módulo WASM.
 *
 * O módulo WASM expõe as syscalls que o shim Deno chama.
 * As funções host (FS + rede) são implementadas em TypeScript
 * e conectadas via WebAssembly.instantiate imports.
 */

import type { WexelFileSystem, ExecResult } from "./index.js";
import { createWasmFsChannel, serveWasmFs, WasmFsClient } from "./deno-wasm-fs.js";
import { NetBridgeHost } from "./deno-net-bridge.js";

export interface DenoWasmRuntimeOptions {
  networkAllowed?: boolean;
  fetcher?:        typeof fetch;
  timeoutMs?:      number;
}

export interface DenoWasmRuntimeExec {
  code:     string;
  language: "javascript" | "typescript";
  args?:    string[];
}

/** Carrega o deno-runtime.wasm a partir dos assets do Wexel. */
async function loadRuntimeWasm(): Promise<WebAssembly.Module> {
  const url = new URL("../assets/deno-runtime.wasm", import.meta.url);
  const bytes = await fetch(url).then((r) => r.arrayBuffer());
  return WebAssembly.compile(bytes);
}

/**
 * Executa código no ambiente Deno WASM.
 *
 * O módulo WASM usa memória compartilhada entre o Web Worker e a
 * thread principal. O FS e a rede são servidos pela thread principal
 * e acessados pelo Worker via imports do módulo WASM.
 */
export async function runDenoWasmRuntime(
  fs:      WexelFileSystem,
  options: DenoWasmRuntimeOptions,
  exec:    DenoWasmRuntimeExec,
): Promise<ExecResult> {
  // Canal VFS via SAB
  const fsChannel = createWasmFsChannel();
  const stopFs    = serveWasmFs(fsChannel, fs);

  // Canal de rede
  const { port1: netMain, port2: netWorker } = new MessageChannel();
  const { port1: ioMain,  port2: ioWorker  } = new MessageChannel();
  const netHost = new NetBridgeHost(netMain, options.fetcher ?? fetch, options.networkAllowed ?? false);

  // Memória compartilhada — igual ao WebContainers
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true });

  // Carrega o módulo WASM
  const wasmModule = await loadRuntimeWasm();

  // Injeta o VFS e a rede como imports do módulo WASM
  // Estas funções são chamadas pelas exports do WASM que o shim Deno usa
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function strToMem(mem: WebAssembly.Memory, s: string): [number, number] {
    const bytes = enc.encode(s);
    const ptr   = (wasmExports.wexel_alloc as (n: number) => number)(bytes.length);
    new Uint8Array(mem.buffer).set(bytes, ptr);
    return [ptr, bytes.length];
  }

  function memToStr(mem: WebAssembly.Memory, ptr: number, len: number): string {
    return dec.decode(new Uint8Array(mem.buffer, ptr, len));
  }

  // Placeholder — será preenchido após instanciar
  let wasmExports: WebAssembly.Exports;
  const vfsClient = new WasmFsClient(fsChannel);

  const imports: WebAssembly.Imports = {
    __wexel_host: {
      fs_read: (pPtr: number, pLen: number): [number, number] => {
        const path  = memToStr(memory, pPtr, pLen);
        const bytes = vfsClient.read(path);
        const ptr   = (wasmExports.wexel_alloc as (n: number) => number)(bytes.length);
        new Uint8Array(memory.buffer).set(bytes, ptr);
        return [ptr, bytes.length];
      },
      fs_write: (pPtr: number, pLen: number, dPtr: number, dLen: number): void => {
        const path = memToStr(memory, pPtr, pLen);
        const data = new Uint8Array(memory.buffer, dPtr, dLen);
        vfsClient.write(path, data);
      },
      fs_exists: (pPtr: number, pLen: number): number => {
        return vfsClient.exists(memToStr(memory, pPtr, pLen)) ? 1 : 0;
      },
      fs_mkdir: (pPtr: number, pLen: number): void => {
        vfsClient.mkdir(memToStr(memory, pPtr, pLen));
      },
      fs_remove: (pPtr: number, pLen: number): void => {
        vfsClient.remove(memToStr(memory, pPtr, pLen));
      },
      fs_list: (pPtr: number, pLen: number): [number, number] => {
        const list  = vfsClient.list();
        const json  = enc.encode(JSON.stringify(list));
        const ptr   = (wasmExports.wexel_alloc as (n: number) => number)(json.length);
        new Uint8Array(memory.buffer).set(json, ptr);
        return [ptr, json.length];
      },
      fs_cwd: (): [number, number] => {
        const [ptr, len] = strToMem(memory, vfsClient.pwd());
        return [ptr, len];
      },
      fs_cd: (pPtr: number, pLen: number): void => {
        vfsClient.cd(memToStr(memory, pPtr, pLen));
      },
      env_get: (kPtr: number, kLen: number): [number, number] => {
        const key  = memToStr(memory, kPtr, kLen);
        const val  = ({ HOME: fs.home, PATH: "/bin:/usr/bin", DENO_DIR: `${fs.home}/.deno`, TERM: "xterm-256color" } as Record<string, string>)[key] ?? "";
        return strToMem(memory, val);
      },
      stdout_write: (ptr: number, len: number): void => {
        ioMain.postMessage({ kind: "stdout", text: memToStr(memory, ptr, len) });
      },
      stderr_write: (ptr: number, len: number): void => {
        ioMain.postMessage({ kind: "stderr", text: memToStr(memory, ptr, len) });
      },
      proc_exit: (code: number): void => {
        ioMain.postMessage({ kind: "exit", code });
      },
    },
  };

  // Instancia o WASM com memória compartilhada
  const instance  = await WebAssembly.instantiate(wasmModule, { ...imports, env: { memory } });
  wasmExports     = instance.exports;

  // Inicializa o runtime
  (wasmExports.wexel_runtime_init as () => void)();

  // Lança o Worker com o shim Deno
  return new Promise<ExecResult>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => finish(1, "Timeout Deno WASM\n"), options.timeoutMs)
      : undefined;

    function finish(exitCode: number, extra?: string): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stopFs();
      netHost.dispose();
      resolve({ stdout: stdout.join(""), stderr: stderr.join("") + (extra ?? ""), exitCode });
    }

    ioMain.onmessage = (ev: MessageEvent<{ kind: string; text?: string; code?: number }>) => {
      const m = ev.data;
      if      (m.kind === "stdout") stdout.push(m.text ?? "");
      else if (m.kind === "stderr") stderr.push(m.text ?? "");
      else if (m.kind === "exit")   finish(m.code ?? 0);
    };

    // Passa exports WASM + ports para o Worker via script inline
    const src  = buildWorkerScript();
    const blob = new Blob([src], { type: "application/javascript" });
    const url  = URL.createObjectURL(blob);
    const worker = new Worker(url, { type: "module" });
    URL.revokeObjectURL(url);

    worker.onerror = (ev) => finish(1, `Worker error: ${ev.message}\n`);

    worker.postMessage(
      { type: "init", fsSab: fsChannel.sab, home: fs.home, code: exec.code, language: exec.language, args: exec.args ?? [] },
      [netWorker, ioWorker],
    );
    worker.postMessage({ type: "ports", netPort: netWorker, ioPort: ioWorker });
  });
}

/** Script do Worker — reutiliza deno-wasm-worker.ts inline. */
function buildWorkerScript(): string {
  return /* javascript */`
const HEADER=8,CAP=512*1024,S_REQ=1,S_OK_BIN=2,S_OK_JSON=3,S_FREE=0;
const ENC=new TextEncoder(),DEC=new TextDecoder();
let fsCtrl,fsBuf,netPort,ioPort,initData;

self.onmessage=(ev)=>{
  if(ev.data.type==="init"){
    initData=ev.data;
    fsCtrl=new Int32Array(ev.data.fsSab,0,2);
    fsBuf=new Uint8Array(ev.data.fsSab,HEADER,CAP);
    netPort=ev.data.netPort; ioPort=ev.data.ioPort;
    if(netPort&&ioPort) boot();
  } else if(ev.data.type==="ports"){
    if(!netPort){netPort=ev.data.netPort;ioPort=ev.data.ioPort;}
    if(initData) boot();
  }
};

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

let netId=0;const netP=new Map();
function initNet(){netPort.onmessage=(ev)=>{const m=ev.data;if(m.kind==="fetch-response"){netP.get(m.id)?.(m);netP.delete(m.id);}}}
function bridgedFetch(url,init){
  const id="f"+(++netId),hdrs={};
  if(init?.headers instanceof Headers)init.headers.forEach((v,k)=>hdrs[k]=v);
  else if(init?.headers)Object.assign(hdrs,init.headers);
  let body;if(init?.body){const r=typeof init.body==="string"?ENC.encode(init.body):new Uint8Array(init.body);body=[...r];}
  return new Promise((res,rej)=>{
    netP.set(id,(r)=>{if(r.error&&r.status===0){rej(new TypeError(r.error));return;}res(new Response(new Uint8Array(r.body),{status:r.status,headers:new Headers(r.headers)}));});
    netPort.postMessage({kind:"fetch",id,url:url.toString(),method:init?.method??"GET",headers:hdrs,body});
  });
}

function ts(src){
  return src
    .replace(/import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['"][^'"]*['"]\\s*;?/g,"")
    .replace(/:\\s*[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g,"")
    .replace(/\\bas\\s+[A-Z][A-Za-z0-9<>\\[\\]|&,\\s.?]*/g,"");
}

async function boot(){
  if(!fsCtrl||!netPort||!ioPort)return;
  initNet();
  const home=initData.home??"/home/wexel";
  const Vfs={
    read:(p)=>fsCall("read",[p]),readText:(p)=>fsCall("readText",[p]),
    write:(p,d)=>fsCall("write",[p,[...(d instanceof Uint8Array?d:ENC.encode(d))]]),
    exists:(p)=>fsCall("exists",[p]),list:()=>fsCall("list",[]),
    pwd:()=>fsCall("pwd",[]),home:()=>fsCall("home",[]),
    mkdir:(p)=>fsCall("mkdir",[p]),remove:(p)=>fsCall("remove",[p]),cd:(p)=>fsCall("cd",[p]),
  };
  self.Deno={
    readFile:(p)=>Promise.resolve(Vfs.read(p)),
    readTextFile:(p)=>Promise.resolve(Vfs.readText(p)),
    writeFile:(p,d)=>{Vfs.write(p,d);return Promise.resolve();},
    writeTextFile:(p,t)=>{Vfs.write(p,t);return Promise.resolve();},
    readFileSync:(p)=>Vfs.read(p),readTextFileSync:(p)=>Vfs.readText(p),writeFileSync:(p,d)=>Vfs.write(p,d),
    stat:(p)=>Promise.resolve({isFile:Vfs.exists(p),isDirectory:false,size:0}),
    mkdir:(p)=>{Vfs.mkdir(p);return Promise.resolve();},
    remove:(p)=>{Vfs.remove(p);return Promise.resolve();},
    readDir:(p)=>(async function*(){for(const n of Vfs.list())yield{name:n,isFile:true,isDirectory:false};})(),
    cwd:()=>Vfs.pwd(),chdir:(p)=>Vfs.cd(p),
    args:initData.args??[],pid:1,ppid:0,
    build:{os:"linux",arch:"x86_64",target:"x86_64-unknown-linux-gnu"},
    version:{deno:"2.3.5-wexel",v8:"13.7.152.6",typescript:"5.8.3"},
    env:{get:(k)=>({HOME:home,PATH:"/bin:/usr/bin",DENO_DIR:home+"/.deno",TERM:"xterm-256color"})[k],set:()=>{},delete:()=>{},toObject:()=>({HOME:home})},
    exit:(code)=>{ioPort.postMessage({kind:"exit",code:code??0});self.close();},
    fetch:bridgedFetch,
    permissions:{query:async()=>({state:"granted"}),request:async()=>({state:"granted"}),revoke:async()=>({state:"denied"})},
  };
  self.fetch=bridgedFetch;
  const fmt=(a)=>a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ");
  self.console={
    log:(...a)=>ioPort.postMessage({kind:"stdout",text:fmt(a)+"\\n"}),
    info:(...a)=>ioPort.postMessage({kind:"stdout",text:fmt(a)+"\\n"}),
    warn:(...a)=>ioPort.postMessage({kind:"stderr",text:fmt(a)+"\\n"}),
    error:(...a)=>ioPort.postMessage({kind:"stderr",text:fmt(a)+"\\n"}),
  };
  let code=initData.code;
  if(initData.language==="typescript")code=ts(code);
  try{
    const fn=new Function("Deno","fetch",code);
    const r=fn(self.Deno,self.fetch);
    if(r?.then)await r;
    ioPort.postMessage({kind:"exit",code:0});
  }catch(err){
    ioPort.postMessage({kind:"stderr",text:String(err)+"\\n"});
    ioPort.postMessage({kind:"exit",code:1});
  }
}
`;
}
