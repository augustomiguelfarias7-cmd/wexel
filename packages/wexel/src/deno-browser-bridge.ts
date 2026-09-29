/**
 * Ponte pública para o host Deno WASM no browser.
 *
 * O único runtime aceito aqui é um módulo WebAssembly Deno real carregado
 * pelo DenoBrowserHost. Não existe Node sandbox, Service Worker como runtime
 * Deno ou objeto global Deno falso.
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { DenoBrowserHost, type DenoBrowserHostOptions } from "./deno-browser-host.js";

const hostCache = new WeakMap<WexelFileSystem, DenoBrowserHost>();

export async function runDenoBrowser(
  fs: WexelFileSystem,
  code: string,
  language: "javascript" | "typescript",
  args: string[] = [],
  options: DenoBrowserHostOptions,
): Promise<ExecResult> {
  let host = hostCache.get(fs);
  if (!host) {
    host = await DenoBrowserHost.create(fs, options);
    hostCache.set(fs, host);
  }
  return host.run(code, language, args);
}

export async function disposeDenoBrowser(fs: WexelFileSystem): Promise<void> {
  const host = hostCache.get(fs);
  if (host) {
    host.dispose();
    hostCache.delete(fs);
  }
}

export function isBrowserDenoSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof SharedArrayBuffer !== "undefined" &&
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated === true
  );
}
