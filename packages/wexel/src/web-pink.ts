export interface WebPinkNetlifyPolicy {
  version: 1;
  /** Domínios/hosts permitidos. Suporta "*.example.com". */
  allowHosts?: string[];
  /** Domínios/hosts bloqueados. Sempre prevalecem sobre permissões. */
  denyHosts?: string[];
  /** URLs permitidas por origem e caminho. */
  allowUrls?: string[];
  /** URLs bloqueadas por origem e caminho. Sempre prevalecem. */
  denyUrls?: string[];
  /** Só habilite para ambientes controlados. Nunca é necessário para sites públicos. */
  allowInternal?: boolean;
}

export interface WebPinkOptions {
  fetcher?: typeof fetch;
  allowHosts?: string[];
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  policyJson?: string;
  /** Resolved IPs for a hostname. Node's default fetch uses DNS validation automatically when no custom fetcher is supplied. */
  resolveHost?: (hostname: string) => Promise<string[]>;
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".test", ".invalid", ".example", ".onion", ".arpa"];

export class WebPinkClient {
  private readonly inbox: WebPinkMessage[] = [];
  private readonly listeners = new Set<(message: WebPinkMessage) => void>();
  private netlifyPolicy?: WebPinkNetlifyPolicy;

  constructor(readonly id: string, private readonly network: WebPink, readonly policy: WebPinkSandboxPolicy) {}

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.network.fetch(this.id, input, init, this.policy, this.netlifyPolicy);
  }

  /** Importa o conteúdo de um arquivo JSON de política WebPink Netlify. */
  importPolicyJson(json: string): WebPinkNetlifyPolicy {
    this.netlifyPolicy = parseWebPinkNetlifyPolicy(json);
    return structuredClone(this.netlifyPolicy);
  }

  clearImportedPolicy(): void { this.netlifyPolicy = undefined; }
  send(to: string, payload: unknown): void { this.network.send(this.id, to, payload); }
  receive(): WebPinkMessage[] { return this.inbox.splice(0); }
  onMessage(listener: (message: WebPinkMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  deliver(message: WebPinkMessage): void { this.inbox.push(message); for (const listener of this.listeners) listener(message); }
}

/** Camada de reforço de rede: política JSON, bloqueios nativos e limites HTTP. */
export class WebPink {
  private readonly clients = new Map<string, WebPinkClient>();
  private readonly fetcher: typeof fetch;
  private readonly resolveHost?: (hostname: string) => Promise<string[]>;
  private readonly defaultPolicy?: WebPinkNetlifyPolicy;

  constructor(private readonly options: WebPinkOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.resolveHost = options.resolveHost ?? (options.fetcher ? undefined : createDefaultHostResolver());
    this.defaultPolicy = options.policyJson ? parseWebPinkNetlifyPolicy(options.policyJson) : undefined;
  }

  createClient(id: string, policy: WebPinkSandboxPolicy = {}): WebPinkClient {
    if (this.clients.has(id)) throw new Error(`Web Pink já possui uma sandbox: ${id}`);
    const client = new WebPinkClient(id, this, policy);
    if (this.defaultPolicy) client.importPolicyJson(JSON.stringify(this.defaultPolicy));
    this.clients.set(id, client);
    return client;
  }

  removeClient(id: string): boolean { return this.clients.delete(id); }

  async fetch(
    sandboxId: string,
    input: RequestInfo | URL,
    init?: RequestInit,
    sandboxPolicy: WebPinkSandboxPolicy = {},
    netlifyPolicy?: WebPinkNetlifyPolicy,
  ): Promise<Response> {
    this.requireClient(sandboxId);
    let url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Web Pink bloqueou protocolo: ${url.protocol}`);
    if (url.username || url.password) throw new Error("Web Pink Netlify bloqueou URL com credenciais embutidas.");

    // A política importada pela sandbox pode restringir a política global,
    // mas nunca pode sobrescrever permissões/negações globais.
    const policies = [this.defaultPolicy, netlifyPolicy].filter(
      (item): item is WebPinkNetlifyPolicy => item !== undefined,
    );
    this.assertAllowed(url, sandboxPolicy, policies);
    await this.assertResolvedAddressesAllowed(url, sandboxPolicy, policies);

    const controller = new AbortController();
    const timeout = this.options.requestTimeoutMs && this.options.requestTimeoutMs > 0
      ? setTimeout(() => controller.abort(), this.options.requestTimeoutMs)
      : undefined;
    try {
      // Redirecionamentos são bloqueados para impedir que um host permitido
      // redirecione a sandbox para um destino interno ou não autorizado.
      const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      const response = await this.fetcher(input, { ...init, redirect: "manual", signal });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        throw new Error("Web Pink Netlify bloqueou redirecionamento HTTP; valide o destino e faça uma nova requisição.");
      }
      return await this.limitResponse(response);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  send(from: string, to: string, payload: unknown): void {
    const sender = this.requireClient(from);
    const receiver = this.requireClient(to);
    if (sender.policy.allowInternal !== true || receiver.policy.allowInternal !== true) {
      throw new Error("Web Pink bloqueou comunicação interna: remetente e destinatário devem habilitar allowInternal.");
    }
    // Nunca compartilhar referências mutáveis entre sandboxes.
    let isolatedPayload: unknown;
    try {
      isolatedPayload = structuredClone(payload);
    } catch {
      throw new Error("Web Pink exige payload clonável para comunicação entre sandboxes.");
    }
    receiver.deliver({ from, to, payload: isolatedPayload, timestamp: Date.now() });
  }

  private requireClient(id: string): WebPinkClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`Sandbox Web Pink inexistente: ${id}`);
    return client;
  }

  private assertAllowed(url: URL, sandbox: WebPinkSandboxPolicy, policies: WebPinkNetlifyPolicy[]): void {
    const host = normalizeHost(url.hostname);
    const denied = policies.some((policy) =>
      matchesHost(host, policy.denyHosts) || matchesUrl(url, policy.denyUrls),
    );
    if (denied) throw new Error(`Web Pink Netlify bloqueou destino explicitamente negado: ${url.hostname}`);

    const hostConstraints = [this.options.allowHosts, sandbox.allowHosts].filter(
      (list): list is string[] => Array.isArray(list),
    );
    const hostAllowedByHostLists = hostConstraints.every((list) => matchesHost(host, list));
    const policyAllows = policies.every((policy) => {
      const hasAllowRules = Boolean(policy.allowHosts?.length || policy.allowUrls?.length);
      return !hasAllowRules || matchesHost(host, policy.allowHosts) || matchesUrl(url, policy.allowUrls);
    });
    if (!hostAllowedByHostLists || !policyAllows) {
      throw new Error(`Web Pink bloqueou host/URL fora da lista permitida: ${url.hostname}`);
    }

    // Uma política local não pode ampliar a política global. Para liberar um
    // destino local/suspeito, todas as políticas ativas devem aprová-lo.
    const internalException = sandbox.allowInternal === true && policies.length > 0 &&
      policies.every((policy) => policy.allowInternal === true &&
        (matchesUrl(url, policy.allowUrls) || matchesHost(host, policy.allowHosts)));
    if (isUnsafeHost(host) && !internalException) {
      throw new Error(`Web Pink Netlify bloqueou host local, privado ou suspeito: ${url.hostname}`);
    }
  }

  private async assertResolvedAddressesAllowed(url: URL, sandbox: WebPinkSandboxPolicy, policies: WebPinkNetlifyPolicy[]): Promise<void> {
    const host = normalizeHost(url.hostname);
    if (!this.resolveHost || isIpLiteral(host)) return;
    let addresses: string[];
    try {
      addresses = await this.resolveHost(host);
    } catch {
      throw new Error(`Web Pink bloqueou host que não pôde ser resolvido com segurança: ${host}`);
    }
    if (addresses.length === 0) throw new Error(`Web Pink bloqueou host sem endereços DNS: ${host}`);
    const internalException = sandbox.allowInternal === true && policies.length > 0 &&
      policies.every((policy) => policy.allowInternal === true &&
        (matchesUrl(url, policy.allowUrls) || matchesHost(host, policy.allowHosts)));
    if (addresses.some((address) => isUnsafeHost(normalizeHost(address))) && !internalException) {
      throw new Error(`Web Pink bloqueou DNS que resolve para endereço local, privado ou reservado: ${host}`);
    }
  }

  private async limitResponse(response: Response): Promise<Response> {
    const maxBytes = this.options.maxResponseBytes;
    if (!maxBytes || !response.body) return response;

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel();
      throw new Error(`Web Pink excedeu limite de resposta (${maxBytes} bytes)`);
    }

    // Ler em blocos evita carregar uma resposta ilimitada inteira na memória
    // antes de descobrir que excedeu o limite configurado.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`Web Pink excedeu limite de resposta (${maxBytes} bytes)`);
        }
        chunks.push(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* fluxo já encerrado */ }
      throw error;
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}

/** Valida o formato e rejeita campos desconhecidos para evitar erros silenciosos. */
export function parseWebPinkNetlifyPolicy(json: string): WebPinkNetlifyPolicy {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Web Pink Netlify: JSON inválido."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Web Pink Netlify: a política deve ser um objeto JSON.");
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["version", "allowHosts", "denyHosts", "allowUrls", "denyUrls", "allowInternal"]);
  for (const key of Object.keys(input)) if (!allowedKeys.has(key)) throw new Error(`Web Pink Netlify: campo desconhecido: ${key}`);
  if (input.version !== 1) throw new Error("Web Pink Netlify: version deve ser 1.");
  for (const key of ["allowHosts", "denyHosts", "allowUrls", "denyUrls"]) {
    const list = input[key];
    if (list !== undefined && (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.trim().length > 0))) {
      throw new Error(`Web Pink Netlify: ${key} deve ser uma lista de strings não vazias.`);
    }
  }
  if (input.allowInternal !== undefined && typeof input.allowInternal !== "boolean") throw new Error("Web Pink Netlify: allowInternal deve ser boolean.");
  const normalizeList = (key: string) => (input[key] as string[] | undefined)?.map((item) => item.trim());
  for (const item of [...(normalizeList("allowUrls") ?? []), ...(normalizeList("denyUrls") ?? [])]) {
    let url: URL;
    try { url = new URL(item); } catch { throw new Error(`Web Pink Netlify: URL inválida: ${item}`); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Web Pink Netlify: protocolo não permitido: ${item}`);
  }
  return {
    version: 1,
    allowHosts: normalizeList("allowHosts"),
    denyHosts: normalizeList("denyHosts"),
    allowUrls: normalizeList("allowUrls"),
    denyUrls: normalizeList("denyUrls"),
    allowInternal: input.allowInternal as boolean | undefined,
  };
}

function normalizeHost(host: string): string { return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""); }

function createDefaultHostResolver(): ((hostname: string) => Promise<string[]>) | undefined {
  if (typeof process === "undefined" || !process.versions?.node) return undefined;
  return async (hostname: string) => {
    // Variable-based import keeps the Node-only resolver out of browser bundles.
    const moduleName = "node:dns/promises";
    const dns = await import(moduleName) as { lookup: (host: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string }>> };
    return (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  };
}

function matchesHost(host: string, patterns?: string[]): boolean {
  if (!patterns) return false;
  return patterns.some((pattern) => {
    const candidate = normalizeHost(pattern.replace(/^\*\./, ""));
    return pattern.startsWith("*.") ? host.endsWith(`.${candidate}`) : host === candidate;
  });
}

function matchesUrl(url: URL, patterns?: string[]): boolean {
  if (!patterns) return false;
  return patterns.some((pattern) => {
    try {
      const candidate = new URL(pattern);
      return candidate.origin === url.origin && (candidate.pathname === "/" || url.pathname === candidate.pathname || url.pathname.startsWith(candidate.pathname.endsWith("/") ? candidate.pathname : `${candidate.pathname}/`));
    } catch { return false; }
  });
}

function isUnsafeHost(host: string): boolean {
  if (!host || host === "localhost" || host.includes("%") || !host.includes(".") || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host.startsWith("xn--") || host.split(".").some((part) => part.startsWith("xn--"))) return true;
  if (isIpLiteral(host)) return isPrivateIp(host);
  return false;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isPrivateIp(host: string): boolean {
  if (host.includes(":")) {
    const ip = host.toLowerCase();
    // Only globally routable IPv6 unicast (2000::/3) is allowed by default.
    // This also blocks unspecified, loopback, link-local, ULA, multicast,
    // IPv4-mapped IPv6, NAT64 and other special-purpose ranges by default.
    const firstHextet = Number.parseInt(ip.split(":")[0] || "0", 16);
    if (!Number.isInteger(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return true;
    if (ip.startsWith("2001:db8:") || ip.startsWith("2001:10:") || ip.startsWith("2002:")) return true;
    return false;
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = octets;
  // Private, loopback, link-local, shared address space, documentation,
  // benchmarking, multicast, reserved and other non-public IPv4 ranges.
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
    (a === 192 && b === 0 && c === 2) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}
