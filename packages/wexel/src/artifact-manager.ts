export interface LoadArtifactOptions {
  /** Nome legível opcional, sem substituir o identificador único gerado. */
  name?: string;
  /** Imports/capacidades WASM explicitamente concedidos ao módulo. */
  imports?: WebAssembly.Imports;
  /** Rótulo da origem, usado pelo carregador do VFS. */
  sourceLabel?: string;
}

export interface WexelLoadedArtifact {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly loadedAt: number;
  readonly module: WebAssembly.Module;
  readonly instance: WebAssembly.Instance;
}

export interface WexelArtifactSummary {
  id: string;
  name: string;
  source: string;
  loadedAt: number;
  exports: string[];
}

/**
 * Gerencia módulos WebAssembly carregados pelo runtime. A execução efetiva é
 * feita pelo engine WebAssembly do host, não pelo core VFS Memory64.
 */
export class WexelArtifactManager {
  private readonly loaded = new Map<string, WexelLoadedArtifact>();
  private nextId = 1;

  constructor(private readonly mayLoad: () => boolean = () => true) {}

  async load(source: string | BufferSource, options: LoadArtifactOptions = {}): Promise<WexelLoadedArtifact> {
    if (!this.mayLoad()) throw new Error("Permissão de módulos negada");

    let bytes: BufferSource;
    let sourceLabel: string;
    if (typeof source === "string") {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Falha ao carregar artefato WASM (${response.status}): ${source}`);
      bytes = await response.arrayBuffer();
      sourceLabel = options.sourceLabel ?? source;
    } else {
      bytes = source;
      sourceLabel = options.sourceLabel ?? "buffer";
    }

    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, options.imports ?? {});
    const id = `artifact-${this.nextId++}`;
    const artifact: WexelLoadedArtifact = {
      id,
      name: options.name?.trim() || id,
      source: sourceLabel,
      loadedAt: Date.now(),
      module,
      instance,
    };
    this.loaded.set(id, artifact);
    return artifact;
  }

  get(id: string): WexelLoadedArtifact | undefined {
    return this.loaded.get(id);
  }

  list(): WexelArtifactSummary[] {
    return [...this.loaded.values()].map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      source: artifact.source,
      loadedAt: artifact.loadedAt,
      exports: WebAssembly.Module.exports(artifact.module).map((entry) => entry.name),
    }));
  }

  invoke(id: string, exportName: string, ...args: unknown[]): unknown {
    const artifact = this.loaded.get(id);
    if (!artifact) throw new Error(`Artefato WASM não carregado: ${id}`);
    const candidate = artifact.instance.exports[exportName];
    if (typeof candidate !== "function") throw new Error(`Export WASM não encontrado ou não executável: ${exportName}`);
    return (candidate as (...values: unknown[]) => unknown)(...args);
  }

  unload(id: string): boolean {
    return this.loaded.delete(id);
  }

  clear(): void {
    this.loaded.clear();
  }
}
