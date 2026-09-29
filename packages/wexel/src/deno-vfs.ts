/**
 * Deno source files in the Wexel VFS.
 *
 * JavaScript and TypeScript are ordinary VFS files. This module centralizes
 * extension routing so Node Execution and Browser use the same rules.
 */
import type { WexelFileSystem } from "./index.js";

export type DenoSourceLanguage = "javascript" | "typescript";

export interface DenoSourceFile {
  path: string;
  language: DenoSourceLanguage;
  source: string;
}

export function denoLanguageFromPath(path: string): DenoSourceLanguage | undefined {
  const clean = path.split("?")[0];
  const ext = clean.split(".").pop()?.toLowerCase();
  if (ext === "js" || ext === "mjs" || ext === "cjs" || ext === "jsx") return "javascript";
  if (ext === "ts" || ext === "mts" || ext === "cts" || ext === "tsx") return "typescript";
  return undefined;
}

export function isDenoSourcePath(path: string): boolean {
  return denoLanguageFromPath(path) !== undefined;
}

export function saveDenoSource(
  fs: WexelFileSystem,
  path: string,
  source: string,
): DenoSourceFile {
  const language = denoLanguageFromPath(path);
  if (!language) {
    throw new Error(`Arquivo Deno não suportado: ${path}. Use .js/.mjs/.cjs/.jsx ou .ts/.mts/.cts/.tsx.`);
  }
  fs.write(path, source);
  return { path, language, source };
}

export function readDenoSource(
  fs: WexelFileSystem,
  path: string,
): DenoSourceFile {
  const language = denoLanguageFromPath(path);
  if (!language) {
    throw new Error(`Arquivo Deno não suportado: ${path}.`);
  }
  return { path, language, source: fs.readText(path) };
}

export function listDenoSources(fs: WexelFileSystem, directory = "."): DenoSourceFile[] {
  return fs.snapshot()
    .map(({ path }) => path)
    .filter(isDenoSourcePath)
    .filter((path) => directory === "." || path.startsWith(directory))
    .map((path) => readDenoSource(fs, path));
}
