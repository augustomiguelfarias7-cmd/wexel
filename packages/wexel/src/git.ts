/**
 * git.ts — Wexel
 *
 * Implementa os cinco comandos Git essenciais integrados ao VFS do Wexel.
 *
 * Suporte:
 *   git clone  <url> [destino]          — clona via API REST do GitHub/GitLab
 *   git status                          — lista arquivos modificados vs. HEAD
 *   git log    [--oneline] [-n N]       — histórico de commits do repo
 *   git diff   [arquivo]                — diff entre HEAD e working tree no VFS
 *   git commit -m "mensagem"            — registra snapshot no índice interno
 *
 * Importante: este é um cliente Git leve para o ambiente Wexel —
 * não é um git completo com índice de objetos. O "commit" armazena
 * um snapshot do VFS como JSON no próprio VFS (/.git/wexel-commits.json).
 * Para clonar repositórios privados, injete um token via gitToken.
 */

import type { ExecResult, WexelFileSystem } from "./index.js";

export interface GitOptions {
  fs:             WexelFileSystem;
  networkAllowed: boolean;
  fetcher?:       typeof fetch;
  /** Token pessoal (GitHub, GitLab, etc.) para repositórios privados. */
  gitToken?:      string;
}

interface WexelCommit {
  hash:      string;
  message:   string;
  timestamp: string;
  snapshot:  Array<{ path: string; sha256: string }>;
}

interface WexelGitIndex {
  remote?: string;
  branch:  string;
  commits: WexelCommit[];
}

const GIT_INDEX_PATH = "/.git/wexel-index.json";

export class WexelGit {
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: GitOptions) {
    this.fetcher = opts.fetcher ?? fetch;
  }

  async exec(args: string[]): Promise<ExecResult> {
    const [cmd, ...rest] = args;

    if (!cmd) return this.usage();

    switch (cmd) {
      case "clone":  return this.clone(rest);
      case "status": return this.status();
      case "log":    return this.log(rest);
      case "diff":   return this.diff(rest);
      case "commit": return this.commit(rest);
      default:
        return {
          stdout: "",
          stderr: `git: comando não suportado: ${cmd}\nComandos disponíveis: clone, status, log, diff, commit\n`,
          exitCode: 1,
        };
    }
  }

  // ── git clone ───────────────────────────────────────────────────────────────

  private async clone(args: string[]): Promise<ExecResult> {
    const [url, dest] = args;
    if (!url) return { stdout: "", stderr: "Uso: git clone <url> [destino]\n", exitCode: 2 };
    if (!this.opts.networkAllowed) {
      return { stdout: "", stderr: "git clone: permissão de rede negada pelo Wexel\n", exitCode: 1 };
    }

    const parsed = parseGitUrl(url);
    if (!parsed) {
      return { stdout: "", stderr: `git clone: URL não reconhecida: ${url}\n`, exitCode: 1 };
    }

    const target = dest ?? parsed.repo;
    const stdout: string[] = [`Cloning into '${target}'...`];

    try {
      const files = await this.fetchRepoContents(parsed, "");
      let count = 0;
      for (const file of files) {
        const path = `${target}/${file.path}`;
        this.opts.fs.mkdir(`${target}/${file.path.split("/").slice(0, -1).join("/")}`);
        this.opts.fs.write(path, file.content);
        count++;
      }

      // Inicializa o índice git no VFS
      const index: WexelGitIndex = {
        remote:  url,
        branch:  parsed.branch ?? "main",
        commits: [{
          hash:      `wexel-${Date.now().toString(16)}`,
          message:   `clone from ${url}`,
          timestamp: new Date().toISOString(),
          snapshot:  files.map((f) => ({ path: f.path, sha256: "" })),
        }],
      };
      this.opts.fs.mkdir(`${target}/.git`);
      this.opts.fs.write(`${target}/.git/wexel-index.json`, JSON.stringify(index, null, 2));

      stdout.push(`\n${count} arquivo(s) clonado(s) em /${target}`);
      return { stdout: stdout.join("\n") + "\n", stderr: "", exitCode: 0 };
    } catch (err) {
      return { stdout: "", stderr: `git clone: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 };
    }
  }

  private async fetchRepoContents(
    parsed: ParsedGitUrl,
    dir: string,
  ): Promise<Array<{ path: string; content: Uint8Array }>> {
    const base = apiBase(parsed);
    const ref  = parsed.branch ? `?ref=${parsed.branch}` : "";
    const endpoint = dir
      ? `${base}/contents/${dir}${ref}`
      : `${base}/contents${ref}`;

    const headers: Record<string, string> = {
      Accept:     "application/vnd.github+json",
      "User-Agent": "wexel-git",
    };
    if (this.opts.gitToken) {
      headers["Authorization"] = `Bearer ${this.opts.gitToken}`;
    }

    const res = await this.fetcher(endpoint, { headers });
    if (!res.ok) throw new Error(`API retornou HTTP ${res.status} para ${endpoint}`);

    const items = await res.json() as Array<{ name: string; type: string; download_url: string | null; path: string }>;
    const files: Array<{ path: string; content: Uint8Array }> = [];

    for (const item of items) {
      if (item.type === "file" && item.download_url) {
        const fileRes = await this.fetcher(item.download_url, { headers });
        if (!fileRes.ok) continue;
        const buf = new Uint8Array(await fileRes.arrayBuffer());
        files.push({ path: item.path, content: buf });
      } else if (item.type === "dir") {
        const sub = await this.fetchRepoContents(parsed, item.path);
        files.push(...sub);
      }
    }
    return files;
  }

  // ── git status ──────────────────────────────────────────────────────────────

  private status(): ExecResult {
    const index = this.loadIndex();
    if (!index) {
      return { stdout: "", stderr: "fatal: não é um repositório Wexel Git (ou diretório pai)\n", exitCode: 128 };
    }

    const lastCommit    = index.commits.at(-1);
    const committedPaths = new Set(lastCommit?.snapshot.map((s) => s.path) ?? []);
    const currentFiles   = this.opts.fs.snapshot().map((f) => f.path).filter((p) => !p.includes("/.git/"));

    const modified:  string[] = [];
    const untracked: string[] = [];

    for (const p of currentFiles) {
      if (!committedPaths.has(p)) untracked.push(p);
    }
    for (const p of committedPaths) {
      if (!this.opts.fs.exists(p)) modified.push(p);
    }

    const lines = [
      `On branch ${index.branch}`,
      lastCommit ? `\nNothing to commit` : "\nInitial commit",
    ];

    if (modified.length)  lines.push("\nChanges not staged for commit:", ...modified.map((p) => `\tmodified: ${p}`));
    if (untracked.length) lines.push("\nUntracked files:", ...untracked.map((p) => `\t${p}`));
    if (!modified.length && !untracked.length) lines.push("\nnothing to commit, working tree clean");

    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  // ── git log ─────────────────────────────────────────────────────────────────

  private log(args: string[]): ExecResult {
    const index = this.loadIndex();
    if (!index) return { stdout: "", stderr: "fatal: não é um repositório Wexel Git\n", exitCode: 128 };

    const oneline = args.includes("--oneline");
    const nIdx    = args.indexOf("-n");
    const limit   = nIdx >= 0 && args[nIdx + 1] ? Number(args[nIdx + 1]) : Infinity;
    const commits = [...index.commits].reverse().slice(0, limit);

    if (commits.length === 0) {
      return { stdout: "Nenhum commit ainda.\n", stderr: "", exitCode: 0 };
    }

    const lines = commits.map((c) =>
      oneline
        ? `${c.hash.slice(0, 7)} ${c.message}`
        : `commit ${c.hash}\nDate:   ${c.timestamp}\n\n    ${c.message}\n`,
    );

    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  // ── git diff ────────────────────────────────────────────────────────────────

  private diff(args: string[]): ExecResult {
    const index = this.loadIndex();
    if (!index) return { stdout: "", stderr: "fatal: não é um repositório Wexel Git\n", exitCode: 128 };

    const lastCommit = index.commits.at(-1);
    if (!lastCommit) return { stdout: "Nenhum commit para comparar.\n", stderr: "", exitCode: 0 };

    const filter   = args[0];
    const snapshot = new Set(lastCommit.snapshot.map((s) => s.path));
    const current  = this.opts.fs.snapshot().filter((f) => !f.path.includes("/.git/"));

    const lines: string[] = [];

    for (const file of current) {
      if (filter && file.path !== filter) continue;
      if (!snapshot.has(file.path)) {
        lines.push(`--- /dev/null\n+++ ${file.path}\n@@ -0,0 +1 @@\n+[arquivo novo: ${file.path}]`);
      }
    }

    for (const p of snapshot) {
      if (filter && p !== filter) continue;
      if (!this.opts.fs.exists(p)) {
        lines.push(`--- ${p}\n+++ /dev/null\n@@ -1 +0,0 @@\n-[arquivo removido: ${p}]`);
      }
    }

    return {
      stdout: lines.length ? lines.join("\n") + "\n" : "Nenhuma alteração detectada.\n",
      stderr: "",
      exitCode: 0,
    };
  }

  // ── git commit ──────────────────────────────────────────────────────────────

  private async commit(args: string[]): Promise<ExecResult> {
    const mIdx = args.indexOf("-m");
    const message = mIdx >= 0 && args[mIdx + 1] ? args[mIdx + 1] : undefined;
    if (!message) {
      return { stdout: "", stderr: "Uso: git commit -m \"mensagem\"\n", exitCode: 2 };
    }

    const index: WexelGitIndex = this.loadIndex() ?? {
      branch:  "main",
      commits: [],
    };

    const snapshot = this.opts.fs.snapshot()
      .filter((f) => !f.path.includes("/.git/"))
      .map((f) => ({ path: f.path, sha256: "" }));

    const hash = `wexel-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    index.commits.push({ hash, message, timestamp: new Date().toISOString(), snapshot });
    this.saveIndex(index);

    return {
      stdout: `[${index.branch} ${hash.slice(0, 7)}] ${message}\n ${snapshot.length} file(s) changed\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private loadIndex(): WexelGitIndex | null {
    if (!this.opts.fs.exists(GIT_INDEX_PATH)) return null;
    try { return JSON.parse(this.opts.fs.readText(GIT_INDEX_PATH)) as WexelGitIndex; }
    catch { return null; }
  }

  private saveIndex(index: WexelGitIndex): void {
    this.opts.fs.mkdir("/.git");
    this.opts.fs.write(GIT_INDEX_PATH, JSON.stringify(index, null, 2));
  }

  private usage(): ExecResult {
    return {
      stdout: "Uso: git <clone|status|log|diff|commit> [args]\n",
      stderr: "",
      exitCode: 0,
    };
  }
}

// ── URL parsing ───────────────────────────────────────────────────────────────

interface ParsedGitUrl {
  host:    "github" | "gitlab" | "unknown";
  owner:   string;
  repo:    string;
  branch?: string;
}

function parseGitUrl(url: string): ParsedGitUrl | null {
  // GitHub: https://github.com/owner/repo[.git] | git@github.com:owner/repo.git
  const githubHttps = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:\/tree\/([^/]+))?(?:$|\/)/);
  if (githubHttps) {
    return { host: "github", owner: githubHttps[1], repo: githubHttps[2], branch: githubHttps[3] };
  }
  const gitlabHttps = url.match(/gitlab\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:$|\/)/);
  if (gitlabHttps) {
    return { host: "gitlab", owner: gitlabHttps[1], repo: gitlabHttps[2] };
  }
  return null;
}

function apiBase(p: ParsedGitUrl): string {
  if (p.host === "github") return `https://api.github.com/repos/${p.owner}/${p.repo}`;
  if (p.host === "gitlab") return `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${p.owner}/${p.repo}`)}`;
  throw new Error("Host Git não suportado");
}
