import { describe, expect, it, vi } from "vitest";
import { WebPink, parseWebPinkNetlifyPolicy } from "./web-pink.js";

describe("WebPink Netlify policy", () => {
  it("rejects malformed JSON and unknown fields", () => {
    expect(() => parseWebPinkNetlifyPolicy("{")).toThrow(/JSON inválido/);
    expect(() => parseWebPinkNetlifyPolicy(JSON.stringify({ version: 1, surprise: true }))).toThrow(/campo desconhecido/);
  });
  it("denied hosts override allowed hosts", async () => {
    const network = new WebPink({ fetcher: vi.fn(async () => new Response("ok")) });
    const client = network.createClient("sandbox");
    client.importPolicyJson(JSON.stringify({ version: 1, allowHosts: ["api.example.com"], denyHosts: ["api.example.com"] }));
    await expect(client.fetch("https://api.example.com/data")).rejects.toThrow(/negado/);
  });
  it("allows URLs matched by the policy", async () => {
    const fetcher = vi.fn(async () => new Response("ok"));
    const client = new WebPink({ fetcher }).createClient("sandbox");
    client.importPolicyJson(JSON.stringify({ version: 1, allowUrls: ["https://api.example.com/v1"] }));
    expect(await (await client.fetch("https://api.example.com/v1/items")).text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not let a sandbox policy override global deny rules", async () => {
    const fetcher = vi.fn(async () => new Response("should not be reached"));
    const network = new WebPink({
      fetcher,
      policyJson: JSON.stringify({ version: 1, denyHosts: ["api.example.com"] }),
    });
    const client = network.createClient("sandbox");
    client.importPolicyJson(JSON.stringify({ version: 1, allowHosts: ["api.example.com"] }));
    await expect(client.fetch("https://api.example.com/data")).rejects.toThrow(/explicitamente negado/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks local destinations by default", async () => {
    const fetcher = vi.fn(async () => new Response("should not be reached"));
    const client = new WebPink({ fetcher }).createClient("sandbox");
    await expect(client.fetch("http://127.0.0.1/admin")).rejects.toThrow(/local, privado ou suspeito/);
    await expect(client.fetch("http://localhost/admin")).rejects.toThrow(/local, privado ou suspeito/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks redirects", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }));
    const client = new WebPink({ fetcher }).createClient("sandbox");
    await expect(client.fetch("https://public.example.com/")).rejects.toThrow(/bloqueou redirecionamento/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("caps response bodies", async () => {
    const client = new WebPink({ fetcher: async () => new Response("12345"), maxResponseBytes: 4 }).createClient("sandbox");
    await expect(client.fetch("https://public.example.com/")).rejects.toThrow(/limite de resposta/);
  });
});
