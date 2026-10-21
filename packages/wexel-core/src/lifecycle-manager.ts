export type WexelLifecycleState =
  | "created"
  | "starting"
  | "running"
  | "degraded"
  | "recovering"
  | "stopping"
  | "stopped"
  | "failed";

export interface WexelLifecycleSnapshot {
  state: WexelLifecycleState;
  updatedAt: number;
  reason?: string;
}

/**
 * Tracks the lifecycle of one Wexel runtime instance.
 *
 * This manager describes the runtime hosted by the current process. It cannot
 * detect the death of the process that owns it; process supervision belongs to
 * the outer Node Execution/Orchester layer.
 */
export class WexelLifecycleManager {
  private currentState: WexelLifecycleState = "created";
  private updatedAt = Date.now();
  private reason?: string;
  private recovery?: Promise<void>;

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
    const attempt = (async () => {
      try {
        await action();
        this.setState("running");
      } catch (error) {
        this.setState("failed", error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        this.recovery = undefined;
      }
    })();
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

  private setState(state: WexelLifecycleState, reason?: string): void {
    this.currentState = state;
    this.updatedAt = Date.now();
    this.reason = reason;
  }
}
