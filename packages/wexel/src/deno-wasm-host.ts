/**
 * deno-wasm-host.ts — Wexel
 *
 * Host WASM dedicado para o Deno. Esta camada fica entre o hospedeiro
 * (Node/Browser Worker) e o Deno WASM, mantendo o módulo dentro da
 * fronteira WebAssembly e deixando os recursos externos somente nas
 * funções explicitamente fornecidas pelo Linux Adapter.
 *
 * O host NÃO cria um objeto global Deno e NÃO executa código com
 * new Function(). O módulo recebido precisa ser um WebAssembly real.
 */

import {
  DENO_LINUX_ADAPTER_ABI,
  type DenoLinuxAdapter,
} from "./deno-linux-adapter.js";

export const DENO_WASM_HOST_ABI = 1;

export interface DenoWasmHostOptions {
  adapter: DenoLinuxAdapter;
  /**
   * Imports adicionais necessários pelo build específico do Deno.
   *
   * O host não inventa a ABI do binário. O build real deve declarar
   * explicitamente quais imports usa.
   */
  imports?: WebAssembly.Imports;
  memory?: WebAssembly.Memory;
}

export interface DenoWasmHostInstance {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  memory?: WebAssembly.Memory;
  adapterAbi: number;
}

function assertWasm(bytes: BufferSource): ArrayBuffer {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    view.byteLength < 8 ||
    view[0] !== 0x00 ||
    view[1] !== 0x61 ||
    view[2] !== 0x73 ||
    view[3] !== 0x6d
  ) {
    throw new TypeError(
      "O artefato fornecido não é um módulo WebAssembly válido.",
    );
  }

  return view.slice().buffer;
}

/**
 * Instancia o Deno WASM dentro da fronteira WASM.
 *
 * O adapter continua sendo o único dono do VFS/rede. Nenhum acesso direto
 * ao filesystem ou à rede do host é passado para o módulo.
 */
export async function instantiateDenoWasm(
  source: BufferSource,
  options: DenoWasmHostOptions,
): Promise<DenoWasmHostInstance> {
  const bytes = assertWasm(source);
  const module = await WebAssembly.compile(bytes);

  const adapterInit = options.adapter.workerInit();
  const imports: WebAssembly.Imports = {
    ...(options.imports ?? {}),
    wexel: {
      ...(options.imports?.wexel as Record<string, WebAssembly.ImportValue> | undefined),
      wexel_linux_adapter_abi: () => DENO_LINUX_ADAPTER_ABI,
      wexel_fs_sab: () => adapterInit.fsSab,
    },
  };

  const memory = options.memory;
  if (memory) {
    const env = (imports.env ?? {}) as Record<string, WebAssembly.ImportValue>;
    imports.env = { ...env, memory };
  }

  const instance = await WebAssembly.instantiate(module, imports);

  return {
    module,
    instance,
    memory,
    adapterAbi: DENO_LINUX_ADAPTER_ABI,
  };
}

/**
 * Carrega um artefato WASM por URL/Request dentro do host.
 */
export async function loadDenoWasm(
  source: string | URL | Request,
  options: DenoWasmHostOptions,
): Promise<DenoWasmHostInstance> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Falha ao carregar Deno WASM: HTTP ${response.status}`);
  }
  return instantiateDenoWasm(await response.arrayBuffer(), options);
}
