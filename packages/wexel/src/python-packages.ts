import { unzipSync } from "fflate";
import type { WexelFileSystem } from "./index.js";

export interface PackageFile {
  filename: string;
  url: string;
  digests?: { sha256?: string };
  packagetype: string;
  python_version: string;
  requires_python?: string;
}

export interface PackageInstallResult {
  name: string;
  version: string;
  files: number;
  bytes: number;
  target: string;
}

export interface PackageManagerOptions {
  fs: WexelFileSystem;
  indexUrl?: string;
  target?: string;
  fetcher?: typeof fetch;
}

/** Instala wheels diretamente na VFS, sem subprocesso e sem executar setup.py. */
export class PythonPackageManager {
  private readonly indexUrl: string;
  private readonly target: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: PackageManagerOptions) {
    this.indexUrl = (options.indexUrl ?? "https://pypi.org/pypi").replace(/\/$/, "");
    this.target = options.target ?? "/site-packages";
    this.fetcher = options.fetcher ?? fetch;
  }

  async install(name: string, version?: string, signal?: AbortSignal): Promise<PackageInstallResult> {
    const endpoint = version ? `${this.indexUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json` : `${this.indexUrl}/${encodeURIComponent(name)}/json`;
    const metadata = await (await this.fetcher(endpoint, { signal })).json() as { info: { name: string; version: string }; urls: PackageFile[] };
    const candidates = metadata.urls.filter((file) => file.packagetype === "bdist_wheel" && /(?:^|-)none-any\.whl$/.test(file.filename) && (file.python_version === "py3" || file.python_version === "py2.py3"));
    const selected = candidates[0];
    if (!selected) throw new Error(`Nenhum wheel Python puro compatível para ${name}; wheels nativos precisam de ABI WASM específica.`);
    const response = await this.fetcher(selected.url, { signal });
    if (!response.ok) throw new Error(`Download falhou: HTTP ${response.status}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    const digest = await sha256(archive);
    if (selected.digests?.sha256 && digest !== selected.digests.sha256) throw new Error(`Hash SHA-256 inválido para ${selected.filename}`);
    const files = unzipSync(archive);
    let bytes = 0;
    let count = 0;
    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith("/") || path.includes("../") || path.startsWith("/")) continue;
      const target = `${this.target}/${path}`;
      this.options.fs.write(target, content);
      bytes += content.byteLength;
      count += 1;
    }
    return { name: metadata.info.name, version: metadata.info.version, files: count, bytes, target: this.target };
  }

  async pip(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (args[0] !== "install" || !args[1]) return { stdout: "", stderr: "Wexel pip suporta: pip install <pacote> [versão]\n", exitCode: 2 };
    try {
      const result = await this.install(args[1], undefined, signal);
      return { stdout: `Successfully installed ${result.name}-${result.version}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
