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
const MAX_REDIRECTS = 5;

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
  private readonly defaultPolicy?: WebPinkNetlifyPolicy;

  constructor(private readonly options: WebPinkOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
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

    const policy = netlifyPolicy ?? this.defaultPolicy;
    this.assertAllowed(url, sandboxPolicy, policy);

    const controller = new AbortController();
    const timeout = this.options.requestTimeoutMs && this.options.requestTimeoutMs > 0
      ? setTimeout(() => controller.abort(), this.options.requestTimeoutMs)
      : undefined;
    try {
      // Redirecionamentos são bloqueados para impedir que um host permitido
      // redirecione a sandbox para um destino interno ou não autorizado.
      const response = await this.fetcher(url, { ...init, redirect: "manual", signal: controller.signal });
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
    if (sender.policy.allowInternal === false) throw new Error(`Web Pink bloqueou comunicação interna para ${from}`);
    receiver.deliver({ from, to, payload, timestamp: Date.now() });
  }

  private requireClient(id: string): WebPinkClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`Sandbox Web Pink inexistente: ${id}`);
    return client;
  }

  private assertAllowed(url: URL, sandbox: WebPinkSandboxPolicy, policy?: WebPinkNetlifyPolicy): void {
    const host = normalizeHost(url.hostname);
    const denied = matchesHost(host, policy?.denyHosts) || matchesUrl(url, policy?.denyUrls);
    if (denied) throw new Error(`Web Pink Netlify bloqueou destino explicitamente negado: ${url.hostname}`);

    const hostConstraints = [this.options.allowHosts, sandbox.allowHosts].filter(
      (list): list is string[] => Array.isArray(list),
    );
    const hostAllowedByHostLists = hostConstraints.every((list) => matchesHost(host, list));
    const urlAllowed = matchesUrl(url, policy?.allowUrls);
    const policyHasAllowRules = Boolean(policy?.allowHosts?.length || policy?.allowUrls?.length);
    const policyAllows = !policyHasAllowRules || matchesHost(host, policy?.allowHosts) || urlAllowed;
    if (!hostAllowedByHostLists || !policyAllows) {
      throw new Error(`Web Pink bloqueou host/URL fora da lista permitida: ${url.hostname}`);
    }

    // Hosts internos são negados nativamente, mesmo quando a política é ampla.
    // Uma exceção exige allowInternal:true e uma permissão explícita do host.
    if (isUnsafeHost(host) && !(sandbox.allowInternal === true && policy?.allowInternal === true && (urlAllowed || matchesHost(host, policy.allowHosts)))) {
      throw new Error(`Web Pink Netlify bloqueou host local, privado ou suspeito: ${url.hostname}`);
    }
  }

  private async limitResponse(response: Response): Promise<Response> {
    if (!this.options.maxResponseBytes) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.options.maxResponseBytes) {
      throw new Error(`Web Pink excedeu limite de resposta (${this.options.maxResponseBytes} bytes)`);
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
    return ip === "::" || ip === "::1" || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb") || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:10.") || ip.startsWith("::ffff:192.168.");
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
