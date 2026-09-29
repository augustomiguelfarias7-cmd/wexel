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

/**
 * Generates the browser-side worker.
 *
 * The worker deliberately supports two host ABIs:
 * 1. Wexel's explicit __wexel_host ABI.
 * 2. WASI Preview 1 (wasi_snapshot_preview1), so a Deno build adapted to
 *    wasm32-wasip1 can use the same VFS/stdout/stderr bridge.
 *
 * This does not turn the historical deno-runtime.wasm into Deno. The module
 * supplied to init must be an actual Deno WASM build.
 */
export function createDenoBrowserWorkerSource(): string {
  return `const ENTRY = ${JSON.stringify(DENO_BROWSER_ENTRYPOINT)};
let instance;
let memory;
let fsSab;
let currentArgs = ["deno"];
let currentEnv = {};

const enc = new TextEncoder();
const dec = new TextDecoder();

function view() {
  if (!memory) throw new Error("WASM memory não inicializada");
  return new Uint8Array(memory.buffer);
}
function text(ptr, len) {
  return dec.decode(view().subarray(ptr, ptr + len));
}
function writeU32(ptr, value) {
  new DataView(memory.buffer).setUint32(ptr, value >>> 0, true);
}
function readU32(ptr) {
  return new DataView(memory.buffer).getUint32(ptr, true);
}
function writeOutput(type, ptr, len) {
  self.postMessage({ type, data: text(ptr, len) });
}

function fsRequest(method, args) {
  if (!fsSab) throw new Error("VFS SAB não inicializado");
  const ctrl = new Int32Array(fsSab, 0, 2);
  const data = new Uint8Array(fsSab, 8);
  const payload = enc.encode(JSON.stringify({ method, args }));
  if (payload.byteLength > data.byteLength) throw new Error("Pedido VFS excede o limite do canal");
  data.set(payload);
  Atomics.store(ctrl, 1, payload.byteLength);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
  const status = Atomics.wait(ctrl, 0, 1, 30000);
  if (status === "timed-out") throw new Error("VFS timeout");
  const size = Atomics.load(ctrl, 1);
  const bytes = data.slice(0, size);
  const responseStatus = Atomics.load(ctrl, 0);
  Atomics.store(ctrl, 0, 0);
  if (responseStatus === 2) return bytes;
  const parsed = JSON.parse(dec.decode(bytes));
  if (parsed.error) throw new Error(parsed.error.message);
  return parsed.value;
}

function allocBytes(bytes) {
  const alloc = instance?.exports?.wexel_alloc;
  if (typeof alloc !== "function") throw new Error("wexel_alloc ausente");
  const ptr = alloc(bytes.byteLength);
  view().set(bytes, ptr);
  return [ptr, bytes.byteLength];
}
function fsRead(ptr, len) {
  const value = fsRequest("read", [text(ptr, len)]);
  return allocBytes(value instanceof Uint8Array ? value : new Uint8Array(value ?? []));
}
function fsWrite(pathPtr, pathLen, dataPtr, dataLen) {
  fsRequest("write", [text(pathPtr, pathLen), [...view().slice(dataPtr, dataPtr + dataLen)]]);
}
function fsExists(ptr, len) { return fsRequest("exists", [text(ptr, len)]) ? 1 : 0; }
function fsMkdir(ptr, len) { fsRequest("mkdir", [text(ptr, len)]); }
function fsRemove(ptr, len) { fsRequest("remove", [text(ptr, len)]); }
function fsList(ptr, len) {
  return allocBytes(enc.encode(JSON.stringify(fsRequest("list", [text(ptr, len)]))));
}
function fsCwd() { return allocBytes(enc.encode(String(fsRequest("pwd", [])))); }
function fsCd(ptr, len) { fsRequest("cd", [text(ptr, len)]); }
function envGet(ptr, len) {
  return allocBytes(enc.encode(String(currentEnv[text(ptr, len)] ?? "")));
}

function wasiArgsSizesGet(argcPtr, argvBufSizePtr) {
  writeU32(argcPtr, currentArgs.length);
  writeU32(argvBufSizePtr, currentArgs.reduce((n, a) => n + enc.encode(a).byteLength + 1, 0));
  return 0;
}
function wasiArgsGet(argvPtr, argvBufPtr) {
  let cursor = argvBufPtr;
  for (let i = 0; i < currentArgs.length; i++) {
    writeU32(argvPtr + i * 4, cursor);
    const bytes = enc.encode(currentArgs[i]);
    view().set(bytes, cursor);
    view()[cursor + bytes.byteLength] = 0;
    cursor += bytes.byteLength + 1;
  }
  return 0;
}
function wasiEnvironSizesGet(countPtr, sizePtr) {
  const entries = Object.entries(currentEnv).map(([k, v]) => k + "=" + v);
  writeU32(countPtr, entries.length);
  writeU32(sizePtr, entries.reduce((n, e) => n + enc.encode(e).byteLength + 1, 0));
  return 0;
}
function wasiEnvironGet(envPtr, envBufPtr) {
  const entries = Object.entries(currentEnv).map(([k, v]) => k + "=" + v);
  let cursor = envBufPtr;
  entries.forEach((entry, i) => {
    writeU32(envPtr + i * 4, cursor);
    const bytes = enc.encode(entry);
    view().set(bytes, cursor);
    view()[cursor + bytes.byteLength] = 0;
    cursor += bytes.byteLength + 1;
  });
  return 0;
}
function wasiClockTimeGet(_clockId, _precision, timePtr) {
  const now = BigInt(Date.now()) * 1000000n;
  new DataView(memory.buffer).setBigUint64(timePtr, now, true);
  return 0;
}
function wasiRandomGet(ptr, len) {
  const target = view().subarray(ptr, ptr + len);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(target);
  else {
    for (let i = 0; i < target.length; i++) target[i] = Math.floor(Math.random() * 256);
  }
  return 0;
}
function wasiFdWrite(fd, iovs, iovsLen, nwritten) {
  if (fd !== 1 && fd !== 2) return 8;
  let total = 0;
  let output = "";
  for (let i = 0; i < iovsLen; i++) {
    const base = readU32(iovs + i * 8);
    const len = readU32(iovs + i * 8 + 4);
    output += dec.decode(view().subarray(base, base + len));
    total += len;
  }
  self.postMessage({ type: fd === 1 ? "stdout" : "stderr", data: output });
  writeU32(nwritten, total);
  return 0;
}
function wasiFdRead(fd, iovs, iovsLen, nread) {
  if (fd !== 0) return 8;
  writeU32(nread, 0);
  return 0;
}
function wasiFdClose(_fd) { return 0; }
function wasiFdSeek(_fd, _offset, _whence, newOffset) {
  writeU32(newOffset, 0);
  return 0;
}
function wasiFdFdstatGet(_fd, statPtr) {
  view().fill(0, statPtr, statPtr + 24);
  return 0;
}
function wasiFdPrestatGet(_fd, _prestatPtr) { return 8; }
function wasiFdPrestatDirName(_fd, _pathPtr, _pathLen) { return 8; }
function wasiPathOpen(_fd, _dirflags, _pathPtr, _pathLen, _oflags, _rightsBase, _rightsInheriting, _fdflags, _openedFd) {
  return 76;
}
function wasiPathCreateDirectory(_fd, pathPtr, pathLen) {
  try { fsRequest("mkdir", [text(pathPtr, pathLen)]); return 0; } catch { return 44; }
}
function wasiPathUnlinkFile(_fd, pathPtr, pathLen) {
  try { fsRequest("remove", [text(pathPtr, pathLen)]); return 0; } catch { return 44; }
}
function wasiFdReaddir(_fd, _buf, _bufLen, _cookie, bufUsed) {
  writeU32(bufUsed, 0);
  return 0;
}
function wasiProcExit(code) {
  self.postMessage({ type: "exit", exitCode: code >>> 0 });
}

function makeImports() {
  const host = {
    fs_read: (ptr, len) => fsRead(ptr, len),
    fs_write: (pathPtr, pathLen, dataPtr, dataLen) => fsWrite(pathPtr, pathLen, dataPtr, dataLen),
    fs_exists: (ptr, len) => fsExists(ptr, len),
    fs_mkdir: (ptr, len) => fsMkdir(ptr, len),
    fs_remove: (ptr, len) => fsRemove(ptr, len),
    fs_list: (ptr, len) => fsList(ptr, len),
    fs_cwd: () => fsCwd(),
    fs_cd: (ptr, len) => fsCd(ptr, len),
    env_get: (ptr, len) => envGet(ptr, len),
    stdout_write: (ptr, len) => self.postMessage({ type: "stdout", data: text(ptr, len) }),
    stderr_write: (ptr, len) => self.postMessage({ type: "stderr", data: text(ptr, len) }),
    proc_exit: wasiProcExit,
  };

  return {
    wexel: {
      wexel_linux_adapter_abi: () => 1,
      wexel_stdout_write: (ptr, len) => self.postMessage({ type: "stdout", data: text(ptr, len) }),
      wexel_stderr_write: (ptr, len) => self.postMessage({ type: "stderr", data: text(ptr, len) }),
    },
    __wexel_host: host,
    wasi_snapshot_preview1: {
      args_sizes_get: wasiArgsSizesGet,
      args_get: wasiArgsGet,
      environ_sizes_get: wasiEnvironSizesGet,
      environ_get: wasiEnvironGet,
      clock_time_get: wasiClockTimeGet,
      random_get: wasiRandomGet,
      fd_write: wasiFdWrite,
      fd_read: wasiFdRead,
      fd_close: wasiFdClose,
      fd_seek: wasiFdSeek,
      fd_fdstat_get: wasiFdFdstatGet,
      fd_prestat_get: wasiFdPrestatGet,
      fd_prestat_dir_name: wasiFdPrestatDirName,
      path_open: wasiPathOpen,
      path_create_directory: wasiPathCreateDirectory,
      path_unlink_file: wasiPathUnlinkFile,
      fd_readdir: wasiFdReaddir,
      proc_exit: wasiProcExit,
    },
  };
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      fsSab = msg.fsSab;
      currentEnv = msg.env ?? {};
      currentArgs = Array.isArray(msg.args) ? msg.args : ["deno"];
      const result = await WebAssembly.instantiate(msg.wasmBytes, makeImports());
      instance = result.instance;
      memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("Deno WASM precisa exportar memory");
      if (typeof instance.exports.wexel_runtime_init === "function") instance.exports.wexel_runtime_init();

      const hasCustomRun = typeof instance.exports[ENTRY] === "function";
      const hasWasiStart = typeof instance.exports._start === "function";
      if (!hasCustomRun && !hasWasiStart) {
        throw new Error("Deno WASM precisa exportar wexel_deno_run ou _start");
      }
      self.postMessage({ type: "ready", capabilities: {
        wasiPreview1: true,
        wexelHostAbi: true,
        networkBridge: !!msg.netPort,
      }});
      return;
    }

    if (msg.type === "run") {
      if (!instance || !memory) throw new Error("Deno WASM não inicializado");

      if (typeof msg.code === "string") {
        currentArgs = ["deno", "eval", msg.code, ...(msg.args ?? [])];
        currentEnv = { WEXEL_DENO_LANGUAGE: msg.language ?? "javascript", ...currentEnv };
      }

      const run = instance.exports[ENTRY];
      if (typeof run === "function") {
        const bytes = enc.encode(JSON.stringify({
          code: msg.code ?? "",
          language: msg.language ?? "javascript",
          args: msg.args ?? []
        }));
        const alloc = instance.exports.wexel_alloc;
        if (typeof alloc !== "function") throw new Error("wexel_alloc ausente");
        const ptr = alloc(bytes.byteLength);
        view().set(bytes, ptr);
        const result = run(ptr, bytes.byteLength);
        self.postMessage({ type: "result", exitCode: typeof result === "number" ? result : 0 });
        return;
      }

      const start = instance.exports._start;
      if (typeof start !== "function") throw new Error("Entrypoint Deno não encontrado");
      const result = start();
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
