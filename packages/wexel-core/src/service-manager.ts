export type WexelServiceState = "registered" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface WexelService {
  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
}

export interface WexelServiceSnapshot {
  name: string;
  state: WexelServiceState;
  error?: string;
}

/**
 * Lifecycle manager for services owned by a Wexel Core instance.
 * Services are started in registration order and stopped in reverse order.
 */
export class WexelServiceManager {
  private readonly services = new Map<string, { service: WexelService; state: WexelServiceState; error?: string }>();

  register(name: string, service: WexelService): void {
    if (!name.trim()) throw new Error("O nome do serviço não pode ser vazio.");
    if (this.services.has(name)) throw new Error(`Serviço já registrado: ${name}`);
    this.services.set(name, { service, state: "registered" });
  }

  getState(name: string): WexelServiceState | undefined {
    return this.services.get(name)?.state;
  }

  list(): WexelServiceSnapshot[] {
    return [...this.services.entries()].map(([name, item]) => ({
      name,
      state: item.state,
      ...(item.error ? { error: item.error } : {}),
    }));
  }

  async start(name: string): Promise<void> {
    const item = this.services.get(name);
    if (!item) throw new Error(`Serviço não registrado: ${name}`);
    if (item.state === "running") return;
    if (item.state === "starting" || item.state === "stopping") {
      throw new Error(`Transição de estado inválida para o serviço ${name}: ${item.state}`);
    }
    item.state = "starting";
    item.error = undefined;
    try {
      await item.service.start?.();
      item.state = "running";
    } catch (error) {
      item.state = "failed";
      item.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async startAll(): Promise<void> {
    const started: string[] = [];
    try {
      for (const [name, item] of this.services) {
        // Do not include services that were already running in this startup
        // transaction: a later failure must not stop pre-existing services.
        if (item.state === "running") continue;
        await this.start(name);
        started.push(name);
      }
    } catch (error) {
      for (const name of started.reverse()) {
        try { await this.stop(name); } catch { /* preserve the startup error */ }
      }
      throw error;
    }
  }

  async stop(name: string): Promise<void> {
    const item = this.services.get(name);
    if (!item) throw new Error(`Serviço não registrado: ${name}`);
    if (item.state === "stopped" || item.state === "registered") {
      item.state = "stopped";
      return;
    }
    item.state = "stopping";
    try {
      await item.service.stop?.();
      item.state = "stopped";
      item.error = undefined;
    } catch (error) {
      item.state = "failed";
      item.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    const names = [...this.services.keys()].reverse();
    const errors: unknown[] = [];
    for (const name of names) {
      try { await this.stop(name); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Um ou mais serviços falharam ao parar.");
  }

  remove(name: string): boolean {
    const item = this.services.get(name);
    if (!item || item.state === "running" || item.state === "starting" || item.state === "stopping") return false;
    return this.services.delete(name);
  }
}
