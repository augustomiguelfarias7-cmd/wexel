/**
 * Bridge de rede para o Worker do Deno (ambiente browser).
 *
 * O Worker do Deno não pode usar fetch diretamente com política de rede
 * do Wexel. Em vez disso, envia pedidos de rede via MessagePort e este
 * módulo os executa na thread principal, onde o WebPink (ou o fetch
 * nativo) está disponível.
 *
 * WebSocket também é suportado: o Worker recebe um MessagePort que
 * espelha os eventos do WebSocket real aberto na thread principal.
 */

export interface NetFetchRequest {
  kind:    "fetch";
  id:      string;
  url:     string;
  method:  string;
  headers: Record<string, string>;
  body?:   number[]; // Uint8Array serializada
}

export interface NetFetchResponse {
  kind:    "fetch-response";
  id:      string;
  status:  number;
  headers: Record<string, string>;
  body:    number[];
  error?:  string;
}

export interface NetWsOpen {
  kind:    "ws-open";
  id:      string;
  url:     string;
  protocols?: string[];
}

export interface NetWsMessage {
  kind:    "ws-message";
  id:      string;
  data:    string | number[]; // string para text frame, array para binary
}

export interface NetWsClose {
  kind:    "ws-close";
  id:      string;
  code?:   number;
  reason?: string;
}

export interface NetWsError {
  kind: "ws-error";
  id:   string;
  message: string;
}

export type NetBridgeMessage =
  | NetFetchRequest
  | NetFetchResponse
  | NetWsOpen
  | NetWsMessage
  | NetWsClose
  | NetWsError;

export type NetworkFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Lado da thread principal: escuta pedidos de rede do Worker e
 * os executa usando o fetcher fornecido (fetch nativo ou WebPink).
 */
export class NetBridgeHost {
  private readonly sockets = new Map<string, WebSocket>();

  constructor(
    private readonly port: MessagePort,
    private readonly fetcher: NetworkFetcher = fetch,
    private readonly networkAllowed: boolean = false,
  ) {
    this.port.onmessage = (ev: MessageEvent<NetBridgeMessage>) => {
      void this.handle(ev.data);
    };
  }

  private async handle(msg: NetBridgeMessage): Promise<void> {
    if (!this.networkAllowed) {
      if (msg.kind === "fetch") {
        this.port.postMessage({
          kind:  "fetch-response",
          id:    msg.id,
          status: 403,
          headers: {},
          body:  [],
          error: "Permissão de rede negada pelo Wexel",
        } satisfies NetFetchResponse);
      } else if (msg.kind === "ws-open") {
        this.port.postMessage({
          kind:    "ws-error",
          id:      msg.id,
          message: "Permissão de rede negada pelo Wexel",
        } satisfies NetWsError);
      }
      return;
    }

    switch (msg.kind) {
      case "fetch": {
        await this.handleFetch(msg);
        break;
      }
      case "ws-open": {
        this.handleWsOpen(msg);
        break;
      }
      case "ws-message": {
        const ws = this.sockets.get(msg.id);
        if (ws?.readyState === WebSocket.OPEN) {
          if (Array.isArray(msg.data)) {
            ws.send(new Uint8Array(msg.data));
          } else {
            ws.send(msg.data);
          }
        }
        break;
      }
      case "ws-close": {
        const ws = this.sockets.get(msg.id);
        ws?.close(msg.code, msg.reason);
        this.sockets.delete(msg.id);
        break;
      }
    }
  }

  private async handleFetch(req: NetFetchRequest): Promise<void> {
    try {
      const init: RequestInit = {
        method:  req.method,
        headers: req.headers,
        body:    req.body?.length ? new Uint8Array(req.body) : undefined,
      };
      const response = await this.fetcher(req.url, init);
      const body     = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      this.port.postMessage({
        kind:    "fetch-response",
        id:      req.id,
        status:  response.status,
        headers,
        body:    [...body],
      } satisfies NetFetchResponse);
    } catch (err) {
      this.port.postMessage({
        kind:    "fetch-response",
        id:      req.id,
        status:  0,
        headers: {},
        body:    [],
        error:   err instanceof Error ? err.message : String(err),
      } satisfies NetFetchResponse);
    }
  }

  private handleWsOpen(req: NetWsOpen): void {
    let ws: WebSocket;
    try {
      ws = req.protocols ? new WebSocket(req.url, req.protocols) : new WebSocket(req.url);
    } catch (err) {
      this.port.postMessage({
        kind:    "ws-error",
        id:      req.id,
        message: err instanceof Error ? err.message : String(err),
      } satisfies NetWsError);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.sockets.set(req.id, ws);

    ws.onopen = () => {
      this.port.postMessage({ kind: "ws-open", id: req.id, url: req.url } satisfies NetWsOpen);
    };
    ws.onmessage = (ev) => {
      const data = ev.data instanceof ArrayBuffer
        ? [...new Uint8Array(ev.data)]
        : (ev.data as string);
      this.port.postMessage({ kind: "ws-message", id: req.id, data } satisfies NetWsMessage);
    };
    ws.onclose = (ev) => {
      this.sockets.delete(req.id);
      this.port.postMessage({ kind: "ws-close", id: req.id, code: ev.code, reason: ev.reason } satisfies NetWsClose);
    };
    ws.onerror = () => {
      this.port.postMessage({ kind: "ws-error", id: req.id, message: "Erro WebSocket" } satisfies NetWsError);
    };
  }

  dispose(): void {
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
    this.port.onmessage = null;
  }
}

/**
 * Lado do Worker: expõe um fetch e um WebSocket sintéticos que o
 * código do Deno pode usar normalmente — tudo roteado para a thread
 * principal via MessagePort.
 */
export class NetBridgeWorker {
  private readonly pending = new Map<string, {
    resolve: (r: NetFetchResponse) => void;
  }>();
  private readonly wsListeners = new Map<string, {
    onopen?:    () => void;
    onmessage?: (data: string | Uint8Array) => void;
    onclose?:   (code?: number, reason?: string) => void;
    onerror?:   (msg: string) => void;
  }>();
  private counter = 0;

  constructor(private readonly port: MessagePort) {
    this.port.onmessage = (ev: MessageEvent<NetBridgeMessage>) => {
      this.dispatch(ev.data);
    };
  }

  private nextId(): string {
    return `net-${++this.counter}`;
  }

  private dispatch(msg: NetBridgeMessage): void {
    switch (msg.kind) {
      case "fetch-response": {
        const pending = this.pending.get(msg.id);
        if (pending) { pending.resolve(msg); this.pending.delete(msg.id); }
        break;
      }
      case "ws-open": {
        this.wsListeners.get(msg.id)?.onopen?.();
        break;
      }
      case "ws-message": {
        const ls = this.wsListeners.get(msg.id);
        if (ls?.onmessage) {
          const data = Array.isArray(msg.data) ? new Uint8Array(msg.data) : msg.data;
          ls.onmessage(data);
        }
        break;
      }
      case "ws-close": {
        this.wsListeners.get(msg.id)?.onclose?.(msg.code, msg.reason);
        this.wsListeners.delete(msg.id);
        break;
      }
      case "ws-error": {
        this.wsListeners.get(msg.id)?.onerror?.(msg.message);
        this.wsListeners.delete(msg.id);
        break;
      }
    }
  }

  /** fetch sintético que roda dentro do Worker e é roteado para a thread principal. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const id  = this.nextId();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bodyBytes = init?.body
      ? [...new Uint8Array(
          typeof init.body === "string"
            ? new TextEncoder().encode(init.body)
            : (init.body as ArrayBuffer),
        )]
      : undefined;

    const rawHeaders = init?.headers;
    const headers: Record<string, string> = {};
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k] = v;
      } else {
        Object.assign(headers, rawHeaders);
      }
    }

    return new Promise<Response>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error && resp.status === 0) {
            reject(new TypeError(resp.error));
            return;
          }
          const body    = new Uint8Array(resp.body);
          const headers = new Headers(resp.headers);
          resolve(new Response(body, { status: resp.status, headers }));
        },
      });
      this.port.postMessage({
        kind:    "fetch",
        id,
        url,
        method:  init?.method ?? "GET",
        headers,
        body:    bodyBytes,
      } satisfies NetFetchRequest);
    });
  }

  /** Abre um WebSocket sintético roteado para a thread principal. */
  openWebSocket(
    url: string,
    protocols?: string | string[],
  ): {
    send:  (data: string | Uint8Array) => void;
    close: (code?: number, reason?: string) => void;
    onopen?:    () => void;
    onmessage?: (data: string | Uint8Array) => void;
    onclose?:   (code?: number, reason?: string) => void;
    onerror?:   (msg: string) => void;
  } {
    const id      = this.nextId();
    const handle  = { onopen: undefined, onmessage: undefined, onclose: undefined, onerror: undefined } as {
      onopen?:    () => void;
      onmessage?: (data: string | Uint8Array) => void;
      onclose?:   (code?: number, reason?: string) => void;
      onerror?:   (msg: string) => void;
    };
    this.wsListeners.set(id, handle);
    this.port.postMessage({
      kind:      "ws-open",
      id,
      url,
      protocols: protocols ? (Array.isArray(protocols) ? protocols : [protocols]) : undefined,
    } satisfies NetWsOpen);
    return {
      ...handle,
      send: (data) => {
        const payload = typeof data === "string" ? data : [...data];
        this.port.postMessage({ kind: "ws-message", id, data: payload } satisfies NetWsMessage);
      },
      close: (code, reason) => {
        this.port.postMessage({ kind: "ws-close", id, code, reason } satisfies NetWsClose);
        this.wsListeners.delete(id);
      },
    };
  }
}
