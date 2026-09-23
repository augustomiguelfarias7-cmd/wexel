/**
 * deno-browser-bridge.ts — Wexel
 *
 * Cola entre o DenoRuntime (deno-wasm.ts) e o DenoBrowserHost.
 *
 * Quando o DenoRuntime detecta ambiente browser, delega aqui.
 * Esta bridge:
 *   - Inicializa o DenoBrowserHost na primeira execução (lazy)
 *   - Expõe runBrowser() com a mesma assinatura do runDenoWorker()
 *   - Mantém uma instância única por WexelFileSystem
 *
 * Estratégia de enganar o Deno:
 *   ┌─────────────────────────────────────────────┐
 *   │  Browser Tab                                 │
 *   │  ┌─────────────────────────────────────────┐│
 *   │  │  Web Worker (deno-node-sandbox)          ││
 *   │  │  ┌───────────────────────────────────┐  ││
 *   │  │  │  Node.js worker_thread            │  ││
 *   │  │  │  ┌─────────────────────────────┐  │  ││
 *   │  │  │  │  Deno nativo (deno.gz)      │  │  ││
 *   │  │  │  │  Acha que está no Linux     │  │  ││
 *   │  │  │  │  FS = VFS do Wexel (SAB)    │  │  ││
 *   │  │  │  │  Net = fetch do browser     │  │  ││
 *   │  │  │  └─────────────────────────────┘  │  ││
 *   │  │  └───────────────────────────────────┘  ││
 *   │  └─────────────────────────────────────────┘│
 *   │  Service Worker: intercepta /wexel-vfs/*     │
 *   └─────────────────────────────────────────────┘
 */

import type { ExecResult, WexelFileSystem } from "./index.js";
import { DenoBrowserHost, type DenoBrowserHostOptions } from "./deno-browser-host.js";

// Cache de instâncias por filesystem (uma por WexelRuntime)
const hostCache = new WeakMap<WexelFileSystem, DenoBrowserHost>();

/**
 * Roda código Deno no browser usando o DenoBrowserHost.
 * Inicializa o host na primeira chamada (lazy).
 */
export async function runDenoBrowser(
  fs:       WexelFileSystem,
  code:     string,
  language: "javascript" | "typescript",
  args:     string[] = [],
  options:  DenoBrowserHostOptions = {},
): Promise<ExecResult> {
  let host = hostCache.get(fs);
  if (!host) {
    host = await DenoBrowserHost.create(fs, options);
    hostCache.set(fs, host);
  }
  return host.run(code, language, args);
}

/**
 * Destrói o host associado a um filesystem.
 * Chame quando o WexelRuntime for descartado.
 */
export async function disposeDenoBrowser(fs: WexelFileSystem): Promise<void> {
  const host = hostCache.get(fs);
  if (host) {
    await host.dispose();
    hostCache.delete(fs);
  }
}

/**
 * Verifica se o ambiente atual suporta rodar Deno no browser.
 * Retorna true se SharedArrayBuffer + crossOriginIsolated estão disponíveis.
 */
export function isBrowserDenoSupported(): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated === true &&
    "serviceWorker" in navigator
  );
}
