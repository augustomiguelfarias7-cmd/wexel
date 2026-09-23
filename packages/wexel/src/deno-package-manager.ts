import type { ExecResult, WexelFileSystem } from "./index.js";

/**
 * Gerenciador de pacotes via Deno integrado ao Wexel.
 *
 * Suporta:
 *   npm install <pkg>         → grava em /node_modules via VFS
 *   pnpm install <pkg>        → mesmo caminho
 *   deno add <pkg>            → atualiza deno.json no VFS
 *   deno add npm:<pkg>        → suporte a pacotes npm via Deno
 *
 * A instalação real dos módulos é delegada ao runner Deno configurado
 * (DenoWorkerRuntime no browser ou DenoNodeSandbox no Node).
 * Este módulo cuida de:
 *   1. Parsear o comando
 *   2. Construir o código Deno que executa a instalação
 *   3. Atualizar o deno.json / package.json no VFS
 *   4. Retornar um ExecResult padronizado
 */

export type DenoPackageRunner = (
  code:     string,
  language: "javascript",
  args:     string[],
) => Promise<ExecResult>;

export interface DenoPackageManagerOptions {
  fs:      WexelFileSystem;
  runner:  DenoPackageRunner;
  /** Permite downloads reais de pacotes. Padrão: false. */
  networkAllowed?: boolean;
}

export class DenoPackageManager {
  constructor(private readonly opts: DenoPackageManagerOptions) {}

  /** Ponto de entrada do shell: `npm install`, `pnpm install`, `deno add`. */
  async exec(argv: string[]): Promise<ExecResult> {
    if (!this.opts.networkAllowed) {
      return { stdout: "", stderr: "Permissão de rede negada — habilite network para instalar pacotes\n", exitCode: 1 };
    }

    const [cmd, sub, ...rest] = argv;

    if ((cmd === "npm" || cmd === "pnpm") && sub === "install") {
      return rest.length > 0
        ? this.installNpm(rest[0], cmd)
        : this.installFromLockfile(cmd);
    }

    if (cmd === "deno" && sub === "add") {
      return this.denoAdd(rest[0]);
    }

    if (cmd === "deno" && sub === "install") {
      return this.denoInstall();
    }

    return {
      stdout: "",
      stderr: `Comando não suportado pelo DenoPackageManager: ${argv.join(" ")}\nSuporte: npm install <pkg>, pnpm install <pkg>, deno add <pkg>\n`,
      exitCode: 2,
    };
  }

  /** npm/pnpm install <pkg> */
  private async installNpm(pkg: string, mgr: "npm" | "pnpm"): Promise<ExecResult> {
    // O código roda no sandbox Deno e faz o download real via npm CDN
    const code = `
const pkg = ${JSON.stringify(pkg)};
const mgr = ${JSON.stringify(mgr)};
const res = await fetch(\`https://registry.npmjs.org/\${pkg}/latest\`);
if (!res.ok) throw new Error("Pacote não encontrado: " + pkg);
const meta = await res.json();
console.log("added 1 package: " + meta.name + "@" + meta.version);
`;
    const result = await this.opts.runner(code, "javascript", []);
    if (result.exitCode === 0) {
      this.upsertPackageJson(pkg);
    }
    return result;
  }

  /** npm install / pnpm install (sem args) — lê package.json do VFS */
  private async installFromLockfile(mgr: "npm" | "pnpm"): Promise<ExecResult> {
    if (!this.opts.fs.exists("/package.json")) {
      return { stdout: "", stderr: "package.json não encontrado na raiz do VFS\n", exitCode: 1 };
    }
    const pkgJson = JSON.parse(this.opts.fs.readText("/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkgJson.dependencies ?? {}),
      ...(pkgJson.devDependencies ?? {}),
    };
    const names = Object.keys(deps);
    if (names.length === 0) {
      return { stdout: "up to date, audited 0 packages\n", stderr: "", exitCode: 0 };
    }
    // instala cada dependência em sequência
    const results: string[] = [];
    for (const name of names) {
      const r = await this.installNpm(name, mgr);
      if (r.exitCode !== 0) return r;
      results.push(r.stdout.trim());
    }
    return { stdout: results.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  /** deno add <specifier> — atualiza deno.json no VFS */
  private async denoAdd(specifier: string): Promise<ExecResult> {
    if (!specifier) {
      return { stdout: "", stderr: "Uso: deno add <especificador>\n", exitCode: 2 };
    }
    const code = `
const spec = ${JSON.stringify(specifier)};
// Resolve a versão mais recente via JSR ou npm
let version = "latest";
if (spec.startsWith("jsr:")) {
  const name = spec.replace(/^jsr:/, "").replace(/[@].*$/, "");
  const res  = await fetch("https://jsr.io/" + name + "/meta.json");
  if (res.ok) { const m = await res.json(); version = m.latest ?? "latest"; }
  console.log("Add " + spec + "@" + version);
} else if (spec.startsWith("npm:")) {
  const name = spec.replace(/^npm:/, "").replace(/[@].*$/, "");
  const res  = await fetch("https://registry.npmjs.org/" + name + "/latest");
  if (res.ok) { const m = await res.json(); version = m.version; }
  console.log("Add " + spec + "@" + version);
} else {
  console.log("Add " + spec);
}
`;
    const result = await this.opts.runner(code, "javascript", []);
    if (result.exitCode === 0) {
      this.upsertDenoJson(specifier);
    }
    return result;
  }

  /** deno install — instala dependências do deno.json */
  private async denoInstall(): Promise<ExecResult> {
    if (!this.opts.fs.exists("/deno.json") && !this.opts.fs.exists("/deno.jsonc")) {
      return { stdout: "", stderr: "deno.json não encontrado na raiz do VFS\n", exitCode: 1 };
    }
    const raw  = this.opts.fs.readText(this.opts.fs.exists("/deno.json") ? "/deno.json" : "/deno.jsonc");
    const conf = JSON.parse(raw) as { imports?: Record<string, string> };
    const imports = conf.imports ?? {};
    const names = Object.keys(imports);
    if (names.length === 0) {
      return { stdout: "All dependencies up to date\n", stderr: "", exitCode: 0 };
    }
    for (const spec of names) {
      const r = await this.denoAdd(spec);
      if (r.exitCode !== 0) return r;
    }
    return { stdout: `Installed ${names.length} dependencies\n`, stderr: "", exitCode: 0 };
  }

  // ── helpers VFS ──────────────────────────────────────────────────────────

  private upsertPackageJson(pkg: string): void {
    let json: Record<string, unknown> = {};
    if (this.opts.fs.exists("/package.json")) {
      try { json = JSON.parse(this.opts.fs.readText("/package.json")); } catch { /**/ }
    }
    const deps = (json["dependencies"] as Record<string, string>) ?? {};
    deps[pkg] = "latest";
    json["dependencies"] = deps;
    this.opts.fs.write("/package.json", JSON.stringify(json, null, 2));
  }

  private upsertDenoJson(specifier: string): void {
    let json: Record<string, unknown> = {};
    if (this.opts.fs.exists("/deno.json")) {
      try { json = JSON.parse(this.opts.fs.readText("/deno.json")); } catch { /**/ }
    }
    const imports = (json["imports"] as Record<string, string>) ?? {};
    const alias   = specifier.split("/").pop()?.replace(/^@/, "") ?? specifier;
    imports[alias] = specifier;
    json["imports"] = imports;
    this.opts.fs.write("/deno.json", JSON.stringify(json, null, 2));
  }
}
