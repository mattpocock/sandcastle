import { WorkflowAgentLimitError, WorkflowStoppedError } from "./errors.js";

export interface WorkflowSchedulerOptions {
  readonly concurrency: number;
  readonly maxAgents: number;
  readonly signal?: AbortSignal;
}

type WorkflowTask<T> = () => Promise<T> | T;

interface QueueEntry {
  run(): Promise<void>;
  reject(reason?: unknown): void;
}

export class WorkflowScheduler {
  readonly concurrency: number;
  readonly maxAgents: number;

  #activeCount = 0;
  #agentCount = 0;
  #scheduledCount = 0;
  #stoppedError: WorkflowStoppedError | undefined;
  #queue: QueueEntry[] = [];
  readonly #signal?: AbortSignal;
  readonly #abortHandler: () => void;

  constructor(options: WorkflowSchedulerOptions) {
    this.concurrency = validatePositiveInteger(
      options.concurrency,
      "concurrency",
    );
    this.maxAgents = validatePositiveInteger(options.maxAgents, "maxAgents");
    this.#signal = options.signal;
    this.#abortHandler = () => {
      this.stop(this.#signal?.reason);
    };

    if (this.#signal?.aborted === true) {
      this.stop(this.#signal.reason);
    } else {
      this.#signal?.addEventListener("abort", this.#abortHandler, {
        once: true,
      });
    }
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  get scheduledCount(): number {
    return this.#scheduledCount;
  }

  get agentCount(): number {
    return this.#agentCount;
  }

  schedule<T>(thunk: WorkflowTask<T>): Promise<T> {
    if (this.#stoppedError !== undefined) {
      return Promise.reject(this.#stoppedError);
    }

    this.#scheduledCount++;

    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        run: () => Promise.resolve().then(thunk).then(resolve, reject),
        reject,
      });
      this.#drain();
    });
  }

  scheduleAgent<T>(thunk: WorkflowTask<T>): Promise<T> {
    if (this.#stoppedError !== undefined) {
      return Promise.reject(this.#stoppedError);
    }

    if (this.#agentCount >= this.maxAgents) {
      throw new WorkflowAgentLimitError(
        `Workflow agent limit exceeded: attempted to schedule more than ${this.maxAgents} agent task${
          this.maxAgents === 1 ? "" : "s"
        }.`,
        {
          details: {
            maxAgents: this.maxAgents,
            agentCount: this.#agentCount,
          },
        },
      );
    }

    this.#agentCount++;
    return this.schedule(thunk);
  }

  parallel<T>(thunks: readonly WorkflowTask<T>[]): Promise<T[]> {
    return Promise.all(thunks.map((thunk) => this.schedule(thunk)));
  }

  stop(reason?: unknown): void {
    if (this.#stoppedError !== undefined) {
      return;
    }

    this.#stoppedError = createStoppedError(reason);
    this.#signal?.removeEventListener("abort", this.#abortHandler);

    const queued = this.#queue;
    this.#queue = [];

    for (const entry of queued) {
      entry.reject(this.#stoppedError);
    }
  }

  #drain(): void {
    while (
      this.#stoppedError === undefined &&
      this.#activeCount < this.concurrency &&
      this.#queue.length > 0
    ) {
      const entry = this.#queue.shift();

      if (entry === undefined) {
        return;
      }

      this.#run(entry);
    }
  }

  #run(entry: QueueEntry): void {
    this.#activeCount++;

    Promise.resolve()
      .then(entry.run)
      .finally(() => {
        this.#activeCount--;
        this.#drain();
      });
  }
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `WorkflowScheduler ${name} must be a positive finite integer.`,
    );
  }

  return value;
}

function createStoppedError(reason: unknown): WorkflowStoppedError {
  if (reason instanceof WorkflowStoppedError) {
    return reason;
  }

  return new WorkflowStoppedError("Workflow scheduler stopped.", {
    cause: reason,
  });
}
