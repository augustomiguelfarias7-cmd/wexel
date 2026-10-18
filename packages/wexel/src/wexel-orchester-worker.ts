import { Wexel } from "./index.js";
import type { ExecRequest } from "./index.js";
import { WebPink, type WebPinkOptions } from "./web-pink.js";

type SerializableWebPinkOptions = Omit<WebPinkOptions, "fetcher">;

type Message =
  | { type: "init"; sandboxId: string; coreBytes: Uint8Array; permissions?: { network?: boolean; storage?: boolean; files?: boolean; modules?: boolean }; storageQuotaBytes?: number; homeDirectory?: string; webPinkOptions?: SerializableWebPinkOptions }
  | { type: "exec"; requestId: string; request: ExecRequest }
  | { type: "shutdown" };

let runtime: Awaited<ReturnType<typeof Wexel.create>> | undefined;
let initializing = false;

process.on("message", async (message: Message) => {
  try {
    if (message.type === "init") {
      if (initializing || runtime) throw new Error("Worker já inicializado.");
      initializing = true;
      const webPink = message.webPinkOptions
        ? new WebPink(message.webPinkOptions).createClient(message.sandboxId)
        : undefined;
      const networkFetch: typeof fetch = (async (input, init) => {
        if (message.permissions?.network !== true) {
          throw new Error("Permissão de rede negada para esta sandbox.");
        }
        if (webPink) return webPink.fetch(input, init);
        return fetch(input, init);
      }) as typeof fetch;
      runtime = await Wexel.create({
        coreBytes: message.coreBytes,
        permissions: message.permissions,
        storageQuotaBytes: message.storageQuotaBytes,
        homeDirectory: message.homeDirectory,
        networkFetch,
      });
      if (!process.send) throw new Error("Canal IPC indisponível.");
      process.send({ type: "ready" });
      return;
    }
    if (message.type === "exec") {
      if (!runtime) throw new Error("Sandbox ainda não está pronta.");
      const result = await runtime.exec(message.request);
      process.send?.({ type: "result", requestId: message.requestId, result });
      return;
    }
    if (message.type === "shutdown") {
      process.disconnect?.();
      setImmediate(() => process.exit(0));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (message.type === "exec") {
      process.send?.({ type: "result", requestId: message.requestId, result: { stdout: "", stderr: detail + "\n", exitCode: 1 } });
    } else {
      process.send?.({ type: "fatal", error: detail });
    }
  }
});

process.on("uncaughtException", (error) => {
  process.send?.({ type: "fatal", error: error.message });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.send?.({ type: "fatal", error: reason instanceof Error ? reason.message : String(reason) });
  process.exit(1);
});
