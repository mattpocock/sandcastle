import { readFile, rename, writeFile } from "node:fs/promises";
import { DateTime, Either, Schema } from "effect";
import type {
  DetachRequest,
  SessionOutcome,
  SessionRequest,
} from "./supervisorProtocol.js";
import type { WorkBoard } from "./supervisorRegistry.js";
import type { SupervisorStatus } from "./supervisorStatusSchema.js";
import { STATUS_FILE, SupervisorStatusJson } from "./supervisorStatusSchema.js";

type Detached = NonNullable<SupervisorStatus["detached"]>;

const workOf = (request: SessionRequest) => ({
  id: request.id,
  name: request.name,
  agent: request.agent.id,
});

/** Writes the status file whole: a temp file, renamed over the last one. */
const replaceFile = async (body: string): Promise<void> => {
  await writeFile(`${STATUS_FILE}.tmp`, body, { mode: 0o600 });
  await rename(`${STATUS_FILE}.tmp`, STATUS_FILE);
};

const decodeStatus = Schema.decodeUnknownEither(SupervisorStatusJson);

/**
 * The status an earlier supervisor in this directory left, if any: a
 * restarted one carries on from it.
 */
export const previousStatus = async (): Promise<
  SupervisorStatus | undefined
> => {
  const text = await readFile(STATUS_FILE, "utf8").catch(() => undefined);
  const decoded = text === undefined ? undefined : decodeStatus(text);
  return decoded !== undefined && Either.isRight(decoded)
    ? decoded.right
    : undefined;
};

/**
 * Inside the sandbox: keeps the supervisor's status file up to date. Writes
 * go one after another, each to a temp file renamed over the last, so a
 * reader never sees half a file.
 */
export class StatusBoard implements WorkBoard {
  private readonly running = new Map<string, SessionRequest>();
  private readonly ended: SupervisorStatus["ended"][number][];
  private readonly earlier: Detached[];
  private detachedAs: Detached | undefined;
  private supervisor: SupervisorStatus["supervisor"] = "running";
  private writing: Promise<void> = Promise.resolve();

  /**
   * `previous` is what an earlier supervisor in this directory left: its
   * ended sessions and detaches are kept. Its running ones ended with it.
   */
  constructor(previous: SupervisorStatus | undefined) {
    this.ended = [...(previous?.ended ?? [])];
    this.earlier = [...(previous?.earlier ?? [])];
    this.detachedAs = previous?.detached;
  }

  // Each change resolves once it is on disk, so a reply sent after it never
  // runs ahead of what `status()` reads.

  /** A session is starting. */
  async started(id: string, request: SessionRequest): Promise<void> {
    this.running.set(id, request);
    await this.write();
  }

  /** A session couldn't start after all. */
  async forget(id: string): Promise<void> {
    this.running.delete(id);
    await this.write();
  }

  /** A session has ended, its record (if any) sent. */
  async finished(
    id: string,
    request: SessionRequest,
    outcome: SessionOutcome,
  ): Promise<void> {
    this.running.delete(id);
    this.ended.push({
      ...workOf(request),
      exitReason: outcome.exitReason,
      ...(outcome.record === undefined ? {} : { record: outcome.record }),
    });
    await this.write();
  }

  /** The running sessions have been carried on past a detach. */
  async detached(request: DetachRequest): Promise<void> {
    const now = DateTime.unsafeNow();
    if (this.detachedAs !== undefined) {
      this.earlier.push(this.detachedAs);
    }
    this.detachedAs = {
      detachId: request.detachId,
      detachedAt: DateTime.formatIso(now),
      deadline: DateTime.formatIso(
        DateTime.add(now, { millis: request.deadlineMs }),
      ),
      reportsTo: request.finishReport?.url ?? false,
      delivery: "not-finished",
    };
    await this.write();
  }

  /** How the finish report is getting on. */
  async delivery(delivery: Detached["delivery"]): Promise<void> {
    if (this.detachedAs !== undefined) {
      this.detachedAs = { ...this.detachedAs, delivery };
    }
    await this.write();
  }

  /** The supervisor is stopping. */
  async exited(): Promise<void> {
    this.supervisor = "exited";
    await this.write();
  }

  /** Writes the status as it is now. */
  async flushed(): Promise<void> {
    await this.write();
  }

  private async write(): Promise<void> {
    const status: SupervisorStatus = {
      supervisor: this.supervisor,
      running: [...this.running.values()].map((request) => workOf(request)),
      ended: [...this.ended],
      ...(this.detachedAs === undefined ? {} : { detached: this.detachedAs }),
      ...(this.earlier.length === 0 ? {} : { earlier: [...this.earlier] }),
    };
    const body = JSON.stringify(status);
    this.writing = this.writing
      .then(async () => replaceFile(body))
      .catch(() => undefined);
    await this.writing;
  }
}
