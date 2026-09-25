/**
 * deno-node-net.ts — Wexel
 *
 * Adapter que conecta a rede do Deno (NetBridgeHost) ao WebPink
 * da sandbox NodeExecution.
 *
 * No browser o Deno usa fetch nativo.
 * No Node.js (NodeExecution) o Deno passa pelo WebPink —
 * que aplica política de rede por sandbox (allowHosts, timeout, maxBytes).
 *
 * Uso:
 *   const net = new DenoNodeNet(webPinkClient);
 *   const netHost = new NetBridgeHost(port, net.fetch, true);
 */

import type { WebPinkClient } from "./web-pink.js";

export class DenoNodeNet {
  constructor(private readonly client: WebPinkClient) {}

  /**
   * Fetcher compatível com NetBridgeHost.
   * Todas as requisições do Deno passam pelo WebPink da sandbox.
   */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return this.client.fetch(input, init);
  };
}

/**
 * Cria um fetcher WebPink para usar no DenoRuntime dentro de um NodeExecution.
 *
 * Exemplo:
 *   const pink   = new WebPink({ allowHosts: ["api.exemplo.com"] });
 *   const client = pink.createClient("deno-sandbox-1", { allowInternal: false });
 *   const net    = createDenoNodeFetcher(client);
 *
 *   const denoRuntime = DenoRuntime.create({ fs, fetcher: net, networkAllowed: true });
 */
export function createDenoNodeFetcher(client: WebPinkClient): typeof fetch {
  const net = new DenoNodeNet(client);
  return net.fetch as typeof fetch;
}
