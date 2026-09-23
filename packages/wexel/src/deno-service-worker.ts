/**
 * deno-service-worker.ts — Wexel
 *
 * Service Worker que faz o Deno achar que está num Linux real dentro do browser.
 *
 * O que ele intercepta:
 *   1. Requisições de rede do Deno  → redireciona para fetch real do browser
 *   2. Requisições de arquivo (/vfs/...) → serve do VFS do Wexel via SharedArrayBuffer
 *
 * Como instalar (no app host):
 *   await DenoServiceWorker.install();
 *
 * O SW é gerado como Blob URL — sem arquivo externo necessário.
 */

/** Instala o Service Worker do Deno e aguarda ativação. */
export async function installDenoServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers não suportados neste browser");
  }

  const src  = getServiceWorkerScript();
  const blob = new Blob([src], { type: "application/javascript" });
  const url  = URL.createObjectURL(blob);

  const reg = await navigator.serviceWorker.register(url, { scope: "/" });

  // Aguarda ativação
  await new Promise<void>((resolve) => {
    if (reg.active) { resolve(); return; }
    const sw = reg.installing ?? reg.waiting;
    sw?.addEventListener("statechange", function handler() {
      if ((this as ServiceWorker).state === "activated") {
        resolve();
        sw.removeEventListener("statechange", handler);
      }
    });
  });

  URL.revokeObjectURL(url);
  return reg;
}

/** Remove o Service Worker do Deno. */
export async function uninstallDenoServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));
}

/**
 * Configura os headers COOP/COEP necessários para SharedArrayBuffer no browser.
 * Deve ser chamado no servidor que serve o app (ou via meta tags equivalentes).
 *
 * Headers necessários:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 */
export function getRequiredHeaders(): Record<string, string> {
  return {
    "Cross-Origin-Opener-Policy":  "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
}

/** Verifica se o browser suporta SharedArrayBuffer (necessário para o VFS síncrono). */
export function checkBrowserSupport(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (typeof SharedArrayBuffer === "undefined") missing.push("SharedArrayBuffer");
  if (typeof Atomics === "undefined") missing.push("Atomics");
  if (!("serviceWorker" in navigator)) missing.push("ServiceWorker");
  if (!crossOriginIsolated) missing.push("crossOriginIsolated (headers COOP/COEP)");
  return { ok: missing.length === 0, missing };
}

// ── Script do Service Worker ──────────────────────────────────────────────────

function getServiceWorkerScript(): string {
  return /* javascript */`
// Wexel — Deno Service Worker
// Intercepta fetch do Deno e roteia para rede real ou VFS.

const WEXEL_VFS_PREFIX = "/wexel-vfs/";
const WEXEL_NET_PREFIX = "/wexel-net/";

// Canal de comunicação com a thread principal para servir o VFS
// O SAB é recebido via postMessage após a instalação
let vfsCtrl = null;
let vfsBuf  = null;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener("install", (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Recebe o SharedArrayBuffer do VFS enviado pela thread principal
self.addEventListener("message", (e) => {
  if (e.data?.type === "wexel-vfs-init") {
    vfsCtrl = new Int32Array(e.data.ctrl);
    vfsBuf  = new Uint8Array(e.data.data);
  }
});

// ── Intercept fetch ──────────────────────────────────────────────────────────

self.addEventListener("fetch", (e) => {
  const url = e.request.url;

  // Requisições de arquivo virtual: /wexel-vfs/<path>
  if (url.includes(WEXEL_VFS_PREFIX)) {
    const path = "/" + url.split(WEXEL_VFS_PREFIX)[1];
    e.respondWith(serveVfs(path, e.request));
    return;
  }

  // Todas as outras requisições: rede real
  e.respondWith(fetch(e.request));
});

// ── Serve arquivo do VFS via SAB ─────────────────────────────────────────────

const IDX_LOCK = 0, IDX_SIZE = 1, IDX_OK = 2;

function vfsRead(path) {
  if (!vfsCtrl || !vfsBuf) return null;
  const req = enc.encode(JSON.stringify({ op: "read", path }));
  vfsBuf.set(req);
  Atomics.store(vfsCtrl, IDX_SIZE, req.byteLength);
  Atomics.store(vfsCtrl, IDX_LOCK, 1);
  Atomics.notify(vfsCtrl, IDX_LOCK);
  Atomics.wait(vfsCtrl, IDX_LOCK, 1);
  const ok   = Atomics.load(vfsCtrl, IDX_OK) === 1;
  const size = Atomics.load(vfsCtrl, IDX_SIZE);
  const data = vfsBuf.slice(0, size);
  Atomics.store(vfsCtrl, IDX_LOCK, 0);
  return ok ? data : null;
}

async function serveVfs(path, request) {
  // Tenta servir do VFS via SAB síncrono
  const data = vfsRead(path);
  if (data) {
    const type = guessMime(path);
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(data.byteLength),
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }
  return new Response("Arquivo não encontrado no VFS: " + path, { status: 404 });
}

function guessMime(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  const types = {
    js: "application/javascript",
    mjs: "application/javascript",
    ts: "application/typescript",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    txt: "text/plain",
    wasm: "application/wasm",
  };
  return types[ext] ?? "application/octet-stream";
}
`;
}
