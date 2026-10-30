import type { RawEvent, EventInput, Incident, State, RecoveryPlan } from '../../shared/types';

export interface DocumentChunk {
  id?: string;
  documentId?: string;
  chunkIndex: number;
  pageNumber?: number | null;
  charStart?: number;
  charEnd?: number;
  content: string;
}

export interface AgentEvents {
  'disruption:ingested': { event: RawEvent | EventInput; incident?: Incident; state: State };
  'plans:generated': { incidentId: string; plans: RecoveryPlan[]; state: State };
  'document:extracted': { documentId: string; chunks: DocumentChunk[]; state: State };
}

export type AgentEventHandler<T> = (payload: T) => Promise<unknown> | unknown;

export class AgentEventBus {
  private handlers = new Map<keyof AgentEvents, Set<AgentEventHandler<any>>>();
  private inFlight = new Set<Promise<unknown>>();

  subscribe<K extends keyof AgentEvents>(
    event: K,
    handler: AgentEventHandler<AgentEvents[K]>
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  on<K extends keyof AgentEvents>(
    event: K,
    handler: AgentEventHandler<AgentEvents[K]>
  ): () => void {
    return this.subscribe(event, handler);
  }

  publish<K extends keyof AgentEvents>(event: K, payload: AgentEvents[K]): void {
    const listeners = this.handlers.get(event);
    if (!listeners || listeners.size === 0) return;
    for (const handler of Array.from(listeners)) {
      let resolvePromise: () => void = () => {};
      const p = new Promise<void>(res => {
        resolvePromise = res;
      });
      this.inFlight.add(p);

      const run = async () => {
        try {
          await handler(payload);
        } catch (err) {
          console.error(`[AgentEventBus] Error executing agent handler for event "${String(event)}":`, err);
        } finally {
          this.inFlight.delete(p);
          resolvePromise();
        }
      };

      if (typeof setImmediate === 'function') {
        setImmediate(run);
      } else {
        setTimeout(run, 0);
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all(Array.from(this.inFlight));
    }
  }

  clear(): void {
    this.handlers.clear();
    this.inFlight.clear();
  }
}

export const agentBus = new AgentEventBus();
