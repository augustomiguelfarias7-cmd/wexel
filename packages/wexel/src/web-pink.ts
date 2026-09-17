export interface WebPinkOptions {
  fetcher?: typeof fetch;
  allowHosts?: string[];
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

export interface WebPinkSandboxPolicy {
  allowHosts?: string[];
  allowInternal?: boolean;
}

export interface WebPinkMessage {
  from: string;
  to: string;
  payload: unknown;
  timestamp: number;
}

export class WebPinkClient {
  private readonly inbox: WebPinkMessage[] = [];
  private readonly listeners = new Set<(message: WebPinkMessage) => void>();
  constructor(readonly id: string, private readonly network: WebPink, readonly policy: WebPinkSandboxPolicy) {}

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> { return this.network.fetch(this.id, input, init); }
  send(to: string, payload: unknown): void { this.network.send(this.id, to, payload); }
  receive(): WebPinkMessage[] { return this.inbox.splice(0); }
  onMessage(listener: (message: WebPinkMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  deliver(message: WebPinkMessage): void { this.inbox.push(message); for (const listener of this.listeners) listener(message); }
}

/** Gateway de rede do host e microrede privada entre sandboxes. */
export class WebPink {
  private readonly clients = new Map<string, WebPinkClient>();
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: WebPinkOptions = {}) { this.fetcher = options.fetcher ?? fetch; }

  createClient(id: string, policy: WebPinkSandboxPolicy = {}): WebPinkClient {
    if (this.clients.has(id)) throw new Error(`Web Pink já possui uma sandbox: ${id}`);
    const client = new WebPinkClient(id, this, policy);
    this.clients.set(id, client);
    return client;
  }

  removeClient(id: string): boolean { return this.clients.delete(id); }

  async fetch(sandboxId: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const client = this.requireClient(sandboxId);
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Web Pink bloqueou protocolo: ${url.protocol}`);
    if (!this.allowed(url.hostname, client.policy.allowHosts) || !this.allowed(url.hostname, this.options.allowHosts)) {
      throw new Error(`Web Pink bloqueou host: ${url.hostname}`);
    }
    const controller = new AbortController();
    const timeout = this.options.requestTimeoutMs ? setTimeout(() => controller.abort(), this.options.requestTimeoutMs) : undefined;
    try {
      const response = await this.fetcher(input, { ...init, signal: controller.signal });
      return await this.limitResponse(response);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  send(from: string, to: string, payload: unknown): void {
    const sender = this.requireClient(from);
    const receiver = this.requireClient(to);
    if (sender.policy.allowInternal === false) throw new Error(`Web Pink bloqueou comunicação interna para ${from}`);
    receiver.deliver({ from, to, payload, timestamp: Date.now() });
  }

  private requireClient(id: string): WebPinkClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`Sandbox Web Pink inexistente: ${id}`);
    return client;
  }

  private allowed(host: string, allowedHosts: string[] | undefined): boolean {
    return !allowedHosts || allowedHosts.includes(host);
  }

  private async limitResponse(response: Response): Promise<Response> {
    if (!this.options.maxResponseBytes) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.options.maxResponseBytes) throw new Error(`Web Pink excedeu limite de resposta (${this.options.maxResponseBytes} bytes)`);
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
