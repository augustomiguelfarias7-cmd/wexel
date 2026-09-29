/**
 * deno-portable-wasm.ts
 *
 * Portable loader for a REAL Deno runtime compiled to WebAssembly.
 *
 * Wexel deliberately does not ship a fake Deno implementation here.
 * The artifact is expected at:
 *   assets/deno/deno.wasm
 *   assets/deno/deno.wasm.gz
 *
 * A compressed artifact is decompressed with fflate, so the same loader
 * works in the browser and in Node.js without node:zlib.
 */

import { gunzipSync } from "fflate";

export interface DenoWasmArtifactSource {
  bytes?: BufferSource;
  url?: string | URL;
}

export interface DenoWasmArtifact {
  bytes: ArrayBuffer;
  module: WebAssembly.Module;
  source: "explicit" | "asset";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function readSource(source: DenoWasmArtifactSource): Promise<{ bytes: Uint8Array; source: "explicit" }> {
  if (source.bytes) {
    const view = source.bytes instanceof ArrayBuffer
      ? new Uint8Array(source.bytes)
      : new Uint8Array(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
    return { bytes: new Uint8Array(view), source: "explicit" };
  }

  if (!source.url) throw new Error("Deno WASM: forneça bytes ou url.");
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`Deno WASM: falha ao carregar ${source.url} (${response.status}).`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), source: "explicit" };
}

/**
 * Loads the portable Deno artifact. No Node-only APIs are used, so this is
 * safe for Browser, Worker and Node Execution.
 */
export async function loadDenoWasmArtifact(
  source?: DenoWasmArtifactSource,
): Promise<DenoWasmArtifact> {
  let bytes: Uint8Array;
  let origin: "explicit" | "asset";

  if (source) {
    const loaded = await readSource(source);
    bytes = loaded.bytes;
    origin = loaded.source;
  } else {
    const candidates = [
      new URL("../assets/deno/deno.wasm", import.meta.url),
      new URL("../assets/deno/deno.wasm.gz", import.meta.url),
    ];

    let lastError: unknown;
    for (const url of candidates) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer());
        origin = "asset";
        if (url.pathname.endsWith(".gz") || isGzip(bytes)) {
          bytes = gunzipSync(bytes);
        }
        const arrayBuffer = toArrayBuffer(bytes);
        return {
          bytes: arrayBuffer,
          module: await WebAssembly.compile(arrayBuffer),
          source: origin,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      "Deno WASM real não encontrado. Esperado assets/deno/deno.wasm ou deno.wasm.gz." +
      (lastError ? ` Último erro: ${String(lastError)}` : ""),
    );
  }

  if (isGzip(bytes)) bytes = gunzipSync(bytes);

  const arrayBuffer = toArrayBuffer(bytes);
  return {
    bytes: arrayBuffer,
    module: await WebAssembly.compile(arrayBuffer),
    source: origin,
  };
}

/**
 * Returns a compact diagnostic without pretending that a generic WASM file
 * is Deno. The build that produces the artifact must expose this Wexel ABI.
 */
export function validateDenoWasmExports(exports: WebAssembly.Exports): string[] {
  const required = ["wexel_runtime_init", "wexel_run", "wexel_alloc"];
  return required.filter((name) => typeof (exports as Record<string, unknown>)[name] !== "function");
}
