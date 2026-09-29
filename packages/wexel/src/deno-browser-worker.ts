/** Dedicated worker source for a real Deno WASM artifact. */
export interface DenoBrowserWorkerRequest {
  type: "init" | "run" | "dispose";
  wasmBytes?: ArrayBuffer;
  fsSab?: SharedArrayBuffer;
  netPort?: MessagePort;
  code?: string;
  language?: "javascript" | "typescript";
  args?: string[];
}

export const DENO_BROWSER_ENTRYPOINT = "wexel_deno_run";

export function createDenoBrowserWorkerSource(): string {
  return `const ENTRY = ${JSON.stringify(DENO_BROWSER_ENTRYPOINT)};
let instance;
let memory;
let fsSab;

function view() { if (!memory) throw new Error("WASM memory não inicializada"); return new Uint8Array(memory.buffer); }
function text(ptr, len) { return new TextDecoder().decode(view().subarray(ptr, ptr + len)); }
function writeOutput(type, ptr, len) { self.postMessage({ type, data: text(ptr, len) }); }
function fsRequest(method, args) {
  if (!fsSab) throw new Error("VFS SAB não inicializado");
  const ctrl = new Int32Array(fsSab, 0, 2), data = new Uint8Array(fsSab, 8);
  const payload = new TextEncoder().encode(JSON.stringify({ method, args }));
  data.set(payload); Atomics.store(ctrl, 1, payload.byteLength); Atomics.store(ctrl, 0, 1); Atomics.notify(ctrl, 0);
  const status = Atomics.wait(ctrl, 0, 1, 30000); if (status === "timed-out") throw new Error("VFS timeout");
  const size = Atomics.load(ctrl, 1), bytes = data.slice(0, size); Atomics.store(ctrl, 0, 0);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)); if (parsed.error) throw new Error(parsed.error.message); return parsed.value;
}
function allocBytes(bytes) { const alloc = instance?.exports?.wexel_alloc; if (typeof alloc !== "function") throw new Error("wexel_alloc ausente"); const ptr = alloc(bytes.byteLength); view().set(bytes, ptr); return [ptr, bytes.byteLength]; }
function fsRead(ptr, len) { const value = fsRequest("read", [text(ptr, len)]); return allocBytes(value instanceof Uint8Array ? value : new Uint8Array(value ?? [])); }
function fsWrite(pathPtr, pathLen, dataPtr, dataLen) { fsRequest("write", [text(pathPtr, pathLen), [...view().slice(dataPtr, dataPtr + dataLen)]]); }
function fsExists(ptr, len) { return fsRequest("exists", [text(ptr, len)]) ? 1 : 0; }
function fsMkdir(ptr, len) { fsRequest("mkdir", [text(ptr, len)]); }
function fsRemove(ptr, len) { fsRequest("remove", [text(ptr, len)]); }
function fsList(ptr, len) { return allocBytes(new TextEncoder().encode(JSON.stringify(fsRequest("list", [text(ptr, len)])))); }
function fsCwd() { return allocBytes(new TextEncoder().encode(String(fsRequest("pwd", [])))); }
function fsCd(ptr, len) { fsRequest("cd", [text(ptr, len)]); }
function envGet(ptr, len) { return allocBytes(new TextEncoder().encode("")); }

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      fsSab = msg.fsSab;
      const imports = {
        wexel: {
          wexel_linux_adapter_abi: () => 1,
          wexel_stdout_write: (ptr, len) => writeOutput("stdout", ptr, len),
          wexel_stderr_write: (ptr, len) => writeOutput("stderr", ptr, len),
        },
        __wexel_host: {
          fs_read: (ptr, len) => fsRead(ptr, len),
          fs_write: (pathPtr, pathLen, dataPtr, dataLen) => fsWrite(pathPtr, pathLen, dataPtr, dataLen),
          fs_exists: (ptr, len) => fsExists(ptr, len),
          fs_mkdir: (ptr, len) => fsMkdir(ptr, len),
          fs_remove: (ptr, len) => fsRemove(ptr, len),
          fs_list: (ptr, len) => fsList(ptr, len),
          fs_cwd: () => fsCwd(),
          fs_cd: (ptr, len) => fsCd(ptr, len),
          env_get: (ptr, len) => envGet(ptr, len),
          stdout_write: (ptr, len) => writeOutput("stdout", ptr, len),
          stderr_write: (ptr, len) => writeOutput("stderr", ptr, len),
          proc_exit: (code) => self.postMessage({ type: "exit", exitCode: code }),
        },        },
      };
      const result = await WebAssembly.instantiate(msg.wasmBytes, imports);
      instance = result.instance;
      memory = instance.exports.memory;
      if (typeof instance.exports.wexel_runtime_init === "function") instance.exports.wexel_runtime_init();
      if (typeof instance.exports[ENTRY] !== "function") throw new Error("Deno WASM não exporta " + ENTRY);
      self.postMessage({ type: "ready" });
      return;
    }

    if (msg.type === "run") {
      if (!instance) throw new Error("Deno WASM não inicializado");
      const run = instance.exports[ENTRY];
      const alloc = instance.exports.wexel_alloc;
      if (typeof run !== "function" || typeof alloc !== "function" || !memory) {
        throw new Error("Deno WASM precisa exportar wexel_deno_run, wexel_alloc e memory");
      }
      const bytes = new TextEncoder().encode(JSON.stringify({
        code: msg.code ?? "", language: msg.language ?? "javascript", args: msg.args ?? []
      }));
      const ptr = alloc(bytes.byteLength);
      new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes);
      const result = run(ptr, bytes.byteLength);
      self.postMessage({ type: "result", exitCode: typeof result === "number" ? result : 0 });
      return;
    }

    if (msg.type === "dispose") self.close();
  } catch (error) {
    self.postMessage({ type: "error", data: error instanceof Error ? error.message : String(error) });
  }
};
`;
}
