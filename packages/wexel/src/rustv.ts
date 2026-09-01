export interface RustVOptions {
  source: BufferSource;
  expectedAbi?: number;
}

export class RustV {
  private constructor(private readonly instance: WebAssembly.Instance) {}

  static async load(options: RustVOptions): Promise<RustV> {
    const instance = (await WebAssembly.instantiate(options.source, {})).instance;
    const exports = instance.exports as unknown as { rustv_abi_version?: () => number };
    const abi = exports.rustv_abi_version?.() ?? 0;
    if (options.expectedAbi !== undefined && abi !== options.expectedAbi) {
      throw new Error(`ABI RustV incompatível: esperado ${options.expectedAbi}, recebido ${abi}.`);
    }
    if (!exports.rustv_abi_version) throw new Error("Módulo RustV sem rustv_abi_version.");
    return new RustV(instance);
  }

  version(): number {
    return Number((this.instance.exports as any).rustv_abi_version());
  }

  add(left: number, right: number): number {
    const fn = (this.instance.exports as any).rustv_add;
    if (typeof fn !== "function") throw new Error("RustV não exporta rustv_add.");
    return Number(fn(left, right));
  }

  exitCode(): number {
    const fn = (this.instance.exports as any).rustv_exit_code;
    return typeof fn === "function" ? Number(fn()) : 0;
  }
}
