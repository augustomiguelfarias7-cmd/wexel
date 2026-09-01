export interface NativeExtensionManifest {
  name: string;
  version: string;
  abi: "wexel-2";
  entry: string;
  sha256?: string;
  commands?: string[];
  dependencies?: string[];
}

export interface NativeExtension {
  manifest: NativeExtensionManifest;
  bytes: Uint8Array;
  instance: WebAssembly.Instance;
}

export class NativeExtensionRegistry {
  private readonly extensions = new Map<string, NativeExtension>();

  async load(manifest: NativeExtensionManifest, source: BufferSource): Promise<NativeExtension> {
    if (!manifest.name || !manifest.version || manifest.abi !== "wexel-2") {
      throw new Error("Manifesto de extensão inválido: requer ABI wexel-2, nome e versão.");
    }
    const bytes = new Uint8Array(source instanceof ArrayBuffer ? source : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    if (manifest.sha256 && await sha256(bytes) !== manifest.sha256.toLowerCase()) {
      throw new Error(`Hash SHA-256 inválido para a extensão ${manifest.name}.`);
    }
    const instance = (await WebAssembly.instantiate(bytes, {})).instance;
    const extension = { manifest, bytes: bytes.slice(), instance };
    this.extensions.set(manifest.name, extension);
    return extension;
  }

  get(name: string): NativeExtension | undefined { return this.extensions.get(name); }
  list(): NativeExtensionManifest[] { return [...this.extensions.values()].map(({ manifest }) => manifest); }

  invoke(name: string, exportName: string, args: number[] = []): number {
    const extension = this.extensions.get(name);
    if (!extension) throw new Error(`Extensão não carregada: ${name}`);
    if (!extension.manifest.commands?.includes(exportName) && exportName !== "wexel_cli_abi_version") {
      throw new Error(`Export não autorizado pelo manifesto: ${exportName}`);
    }
    const fn = (extension.instance.exports as Record<string, unknown>)[exportName];
    if (typeof fn !== "function") throw new Error(`Export não encontrado: ${exportName}`);
    return Number((fn as (...values: number[]) => number)(...args));
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
