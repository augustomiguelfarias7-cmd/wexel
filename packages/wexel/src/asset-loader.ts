/**
 * asset-loader.ts — Wexel
 * Registry + loader dos binários WASM empacotados (sem Wasmtime).
 */

export type WexelAssetId = "core" | "deno-runtime" | "busybox" | "python" | "native-cli";

export interface WexelAssetDescriptor {
  id: WexelAssetId;
  path: string;
  label: string;
  wasi?: boolean;
  companionPaths?: string[];
}

export interface LoadBinaryOptions {
  instantiate?: boolean;
  imports?: WebAssembly.Imports;
  bytes?: BufferSource;
  url?: string;
}

export interface LoadedBinary {
  id: WexelAssetId;
  bytes: ArrayBuffer;
  url?: string;
  instance?: WebAssembly.Instance;
  module?: WebAssembly.Module;
}

export const WEXEL_ASSET_CATALOG: Record<WexelAssetId, WexelAssetDescriptor> = {
  core: { id: "core", path: "core.wasm", label: "Wexel Assembly core" },
  "deno-runtime": { id: "deno-runtime", path: "deno-runtime.wasm", label: "Deno runtime stub WASM" },
  busybox: {
    id: "busybox",
    path: "busybox/busybox.wasm",
    label: "BusyBox Emscripten WASM",
    companionPaths: ["busybox/busybox.js"],
  },
  python: {
    id: "python",
    path: "cpython-3.14.7/python.wasm",
    label: "CPython 3.14.7 WASI",
    wasi: true,
    companionPaths: ["cpython-3.14.7/Lib", "cpython-3.14.7/python.sh"],
  },
  "native-cli": {
    id: "native-cli",
    path: "native/wexel-cli.wasm",
    label: "Native CLI C++ WASM (se gerado no build)",
  },
};

export interface WexelAssetLoaderOptions {
  assetsBaseUrl?: string | URL;
  fetcher?: typeof fetch;
  cache?: boolean;
}

export class WexelAssetLoader {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly cacheEnabled: boolean;
  private readonly byteCache = new Map<WexelAssetId, ArrayBuffer>();
  private readonly instanceCache = new Map<WexelAssetId, LoadedBinary>();

  constructor(options: WexelAssetLoaderOptions = {}) {
    this.base = options.assetsBaseUrl
      ? options.assetsBaseUrl instanceof URL
        ? options.assetsBaseUrl
        : new URL(options.assetsBaseUrl)
      : new URL("../assets/", import.meta.url);
    this.fetcher = options.fetcher ?? fetch;
    this.cacheEnabled = options.cache !== false;
  }

  list(): WexelAssetDescriptor[] {
    return Object.values(WEXEL_ASSET_CATALOG);
  }

  resolveUrl(id: WexelAssetId): URL {
    const desc = WEXEL_ASSET_CATALOG[id];
    if (!desc) throw new Error(`Asset desconhecido: ${id}`);
    return new URL(desc.path, this.base);
  }

  async loadBinary(id: WexelAssetId, options: LoadBinaryOptions = {}): Promise<LoadedBinary> {
    const desc = WEXEL_ASSET_CATALOG[id];
    if (!desc) throw new Error(`Asset desconhecido: ${id}`);

    if (
      options.instantiate &&
      this.cacheEnabled &&
      this.instanceCache.has(id) &&
      !options.bytes &&
      !options.url
    ) {
      return this.instanceCache.get(id)!;
    }

    let bytes: ArrayBuffer;
    let url: string | undefined;

    if (options.bytes) {
      bytes = toArrayBuffer(options.bytes);
    } else if (this.cacheEnabled && this.byteCache.has(id)) {
      bytes = this.byteCache.get(id)!;
      url = this.resolveUrl(id).toString();
    } else {
      const resolved = options.url ? new URL(options.url) : this.resolveUrl(id);
      url = resolved.toString();
      const response = await this.fetcher(url);
      if (!response.ok) {
        throw new Error(`Falha ao carregar asset "${id}" de ${url}: HTTP ${response.status}`);
      }
      bytes = await response.arrayBuffer();
      if (this.cacheEnabled) this.byteCache.set(id, bytes);
    }

    const loaded: LoadedBinary = { id, bytes, url };

    if (options.instantiate) {
      const imports = options.imports ?? {};
      const result = await WebAssembly.instantiate(bytes, imports);
      loaded.module = result.module;
      loaded.instance = result.instance;
      if (this.cacheEnabled) this.instanceCache.set(id, loaded);
    }

    return loaded;
  }

  async loadPythonBytes(options: Omit<LoadBinaryOptions, "instantiate"> = {}): Promise<ArrayBuffer> {
    return (await this.loadBinary("python", { ...options, instantiate: false })).bytes;
  }

  clearCache(): void {
    this.byteCache.clear();
    this.instanceCache.clear();
  }
}

function toArrayBuffer(source: BufferSource): ArrayBuffer {
  if (source instanceof ArrayBuffer) return source;
  return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
}
