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

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      const imports = {
        wexel: {
          wexel_linux_adapter_abi: () => 1,
          wexel_fs_sab: () => msg.fsSab,
          wexel_net_port: () => msg.netPort,
        },
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
