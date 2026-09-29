/**
 * Shared Deno WASM pool.
 *
 * Node Execution is multi-sandbox: the compiled Deno guest is shared, while
 * every sandbox receives its own WebAssembly.Instance and Wexel VFS bridge.
 *
 * Browser uses the same abstraction with a single session.
 */
import { loadDenoWasmArtifact, type DenoWasmArtifactSource } from "./deno-portable-wasm.js";

export interface DenoWasmTemplate {
  module: WebAssembly.Module;
  bytes: ArrayBuffer;
}

export class DenoWasmPool {
  private templatePromise?: Promise<DenoWasmTemplate>;

  constructor(private readonly artifact?: DenoWasmArtifactSource) {}

  async template(): Promise<DenoWasmTemplate> {
    if (!this.templatePromise) {
      this.templatePromise = loadDenoWasmArtifact(this.artifact).then((asset) => ({
        module: asset.module,
        bytes: asset.bytes,
      }));
    }
    return this.templatePromise;
  }

  async createInstance(imports: WebAssembly.Imports): Promise<WebAssembly.Instance> {
    const template = await this.template();
    const result = await WebAssembly.instantiate(template.module, imports);
    return result instanceof WebAssembly.Instance ? result : result.instance;
  }

  clear(): void {
    this.templatePromise = undefined;
  }
}
