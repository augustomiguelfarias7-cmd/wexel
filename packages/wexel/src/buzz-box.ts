export type BuzzEvent = {
  type: string;
  payload?: unknown;
  timestamp: number;
};

/** Barramento local e determinístico para módulos do Wexel Assembly. */
export class BuzzBox {
  private listeners = new Map<string, Set<(event: BuzzEvent) => void>>();
  private history: BuzzEvent[] = [];

  on(type: string, listener: (event: BuzzEvent) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    return () => set.delete(listener);
  }

  emit(type: string, payload?: unknown): BuzzEvent {
    const event = { type, payload, timestamp: Date.now() };
    this.history.push(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    for (const listener of this.listeners.get("*") ?? []) listener(event);
    return event;
  }

  events(type?: string): BuzzEvent[] {
    return this.history.filter((event) => !type || event.type === type).map((event) => ({ ...event }));
  }
}
