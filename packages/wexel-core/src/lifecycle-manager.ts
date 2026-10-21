export type WexelLifecycleState =
  | "created"
  | "starting"
  | "running"
  | "degraded"
  | "recovering"
  | "stopping"
  | "stopped"
  | "failed";

export type WexelComponentState = "registered" | "initializing" | "ready" | "degraded" | "recovering" | "failed";

export interface WexelLifecycleSnapshot {
  state: WexelLifecycleState;
  updatedAt: number;
  reason?: string;
}

export interface WexelComponentSnapshot {
  name: string;
  state: WexelComponentState;
  required: boolean;
  error?: string;
}

type ComponentInitializer = () => void | Promise<void>;
interface RegisteredComponent {
  initialize: ComponentInitializer;
  required: boolean;
  state: WexelComponentState;
  error?: string;
  recovery?: Promise<void>;
}

/**
 * Tracks the lifecycle of one Wexel runtime and its internal integrations.
 * Component registration is generic: language executors, native extensions,
 * adapters, and runtime services can all use the same initialization/recovery
 * path. Process death is outside this manager's scope.
 */
export class WexelLifecycleManager {
  private currentState: WexelLifecycleState = "created";
  private updatedAt = Date.now();
  private reason?: string;
  private recovery?: Promise<void>;
  private readonly components = new Map<string, RegisteredComponent>();

  get state(): WexelLifecycleState {
    return this.currentState;
  }

  snapshot(): WexelLifecycleSnapshot {
    return {
      state: this.currentState,
      updatedAt: this.updatedAt,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  componentSnapshots(): WexelComponentSnapshot[] {
    return [...this.components.entries()].map(([name, item]) => ({
      name,
      state: item.state,
      required: item.required,
      ...(item.error ? { error: item.error } : {}),
    }));
  }

  registerComponent(name: string, initialize: ComponentInitializer, options: { required?: boolean } = {}): void {
    if (!name.trim()) throw new Error("O nome do componente não pode ser vazio.");
    if (this.components.has(name)) throw new Error(`Componente já registrado: ${name}`);
    this.components.set(name, {
      initialize,
      required: options.required ?? true,
      state: "registered",
    });
  }

  async initializeComponent(name: string): Promise<void> {
    const component = this.requireComponent(name);
    if (component.state === "ready") return;
    if (component.state === "initializing" || component.state === "recovering") {
      throw new Error(`Componente ${name} já está em inicialização/recuperação.`);
    }
    component.state = "initializing";
    component.error = undefined;
    try {
      await component.initialize();
      component.state = "ready";
      component.error = undefined;
      this.refreshState();
    } catch (error) {
      component.state = "failed";
      component.error = error instanceof Error ? error.message : String(error);
      this.degraded(`Componente ${name} falhou ao inicializar: ${component.error}`);
      throw error;
    }
  }

  async initializeComponents(): Promise<void> {
    for (const name of this.components.keys()) await this.initializeComponent(name);
  }

  async recoverComponent(name: string): Promise<void> {
    const component = this.requireComponent(name);
    if (component.recovery) return component.recovery;
    if (this.currentState === "stopping" || this.currentState === "stopped") {
      throw new Error(`Não é possível recuperar componentes no estado ${this.currentState}.`);
    }
    component.state = "recovering";
    component.error = undefined;
    const attempt = this.recover(async () => {
      try {
        await component.initialize();
        component.state = "ready";
        component.error = undefined;
      } catch (error) {
        component.state = "failed";
        component.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }).then(() => {
      this.refreshState();
    }).catch((error: unknown) => {
      this.refreshState();
      throw error;
    }).finally(() => {
      component.recovery = undefined;
    });
    component.recovery = attempt;
    return attempt;
  }

  async recoverComponents(names?: string[]): Promise<void> {
    const targets = names ?? [...this.components.entries()]
      .filter(([, item]) => item.required && item.state !== "ready")
      .map(([name]) => name);
    for (const name of targets) await this.recoverComponent(name);
    this.refreshState();
  }

  starting(): void {
    if (this.currentState === "starting" || this.currentState === "recovering" || this.currentState === "stopping") {
      throw new Error(`Transição de ciclo de vida inválida: ${this.currentState} -> starting`);
    }
    this.setState("starting");
  }

  running(): void {
    if (this.currentState === "stopping" || this.currentState === "stopped") {
      throw new Error(`Não é possível marcar runtime como running no estado ${this.currentState}.`);
    }
    this.setState("running");
  }

  degraded(reason: string): void {
    if (this.currentState === "stopped") return;
    this.setState("degraded", reason);
  }

  failed(reason: string): void {
    this.setState("failed", reason);
  }

  async recover(action: () => Promise<void>): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.currentState === "stopping" || this.currentState === "stopped") {
      throw new Error(`Não é possível recuperar runtime no estado ${this.currentState}.`);
    }

    this.setState("recovering");
    const attempt = Promise.resolve()
      .then(action)
      .then(() => {
        this.setState("running");
      })
      .catch((error: unknown) => {
        this.setState("failed", error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        this.recovery = undefined;
      });
    this.recovery = attempt;
    return attempt;
  }

  stopping(): void {
    if (this.currentState === "stopped") return;
    this.setState("stopping");
  }

  stopped(): void {
    this.setState("stopped");
  }

  private requireComponent(name: string): RegisteredComponent {
    const component = this.components.get(name);
    if (!component) throw new Error(`Componente não registrado: ${name}`);
    return component;
  }

  private refreshState(): void {
    if (this.currentState === "stopped" || this.currentState === "stopping") return;
    const failedRequired = [...this.components.entries()].find(([, item]) => item.required && item.state !== "ready");
    if (failedRequired) {
      const [name, item] = failedRequired;
      this.setState("degraded", `Componente obrigatório ${name} está em estado ${item.state}.`);
      return;
    }
    if (this.currentState !== "created" && this.currentState !== "starting") this.setState("running");
  }

  private setState(state: WexelLifecycleState, reason?: string): void {
    this.currentState = state;
    this.updatedAt = Date.now();
    this.reason = reason;
  }
}
