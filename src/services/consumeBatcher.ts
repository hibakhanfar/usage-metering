import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { consumeInTx, type ConsumeInput, type ConsumeResult } from "./consumeService";
import { AppError } from "../lib/errors";

type Job = {
  input: ConsumeInput;
  resolve: (r: ConsumeResult) => void;
  reject: (e: unknown) => void;
};

type Outcome = { ok: true; value: ConsumeResult } | { ok: false; error: unknown };

// Group commit, per account.
//
// Why: a COMMIT must wait for the WAL to be flushed to disk (fsync), and Postgres keeps row locks until
// that flush is done. All accepted requests of one account lock the same shared counter rows, so with
// one transaction per request they run strictly one after another, each paying a full fsync.
//
// How: requests for the same account that arrive while a batch is being processed wait in a queue.
// When the batch finishes, everything queued is processed in ONE transaction, so ONE fsync is shared
// by the whole batch. There is no artificial delay: under light load a batch is just one request.
//
// Correctness is unchanged:
//  - every request still goes through consumeInTx (same checks, same row locks, same SQL), so the
//    database remains the single arbiter, also if several service instances run side by side;
//  - each request runs in its own SAVEPOINT, so one failing request (unknown user, requestId reused
//    with different parameters) is rolled back alone and does not affect the others;
//  - nobody gets an answer before the transaction has committed. If the commit fails, every request
//    of the batch is rejected with the error, and nothing was persisted.
export class ConsumeBatcher {
  private queues = new Map<string, Job[]>();
  private draining = new Set<string>();
  private pendingCount = 0;

  constructor(
  private db: Db,
  private maxBatch = 50,
  private maxPending = 1000,
) {
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1) {
    throw new Error("maxBatch must be a positive safe integer");
  }

  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new Error("maxPending must be a positive safe integer");
  }
}

consume(
  accountId: string,
  input: ConsumeInput,
): Promise<ConsumeResult> {
  if (this.pendingCount >= this.maxPending) {
    return Promise.reject(
      new AppError(
        503,
        "service_busy",
        "Too many pending consume requests; retry with the same requestId",
      ),
    );
  }

  this.pendingCount++;

  return new Promise<ConsumeResult>((resolve, reject) => {
    let queue = this.queues.get(accountId);

    if (!queue) {
      queue = [];
      this.queues.set(accountId, queue);
    }

    queue.push({ input, resolve, reject });
    void this.drain(accountId);
  }).finally(() => {
    this.pendingCount--;
  });
}

  // At most one batch per account is in flight in this process; different accounts run in parallel.
  private async drain(accountId: string): Promise<void> {
    if (this.draining.has(accountId)) return;
    this.draining.add(accountId);
    try {
      for (;;) {
        const queue = this.queues.get(accountId);
        if (!queue || queue.length === 0) {
          this.queues.delete(accountId);
          return;
        }
        await this.runBatch(accountId, queue.splice(0, this.maxBatch));
      }
    } finally {
      this.draining.delete(accountId);
    }
  }

  private async runBatch(accountId: string, jobs: Job[]): Promise<void> {
    const outcomes: Outcome[] = [];
    try {
      await this.db.transaction(async (tx) => {
        // One batch per account at a time, ACROSS service instances too (released at commit).
        // Without it, two batches of the same account could each hold some counter rows and wait for the
        // other's: inside a batch the locks of several requests pile up, so the user-then-account order
        // that makes single requests deadlock-free is no longer global.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`);
        for (const job of jobs) {
          try {
            // nested transaction = SAVEPOINT: a failure rolls back this request only
            const value = await tx.transaction((sp) => consumeInTx(sp, accountId, job.input));
            outcomes.push({ ok: true, value });
          } catch (error) {
            outcomes.push({ ok: false, error });
          }
        }
      });
    } catch (error) {
      // connection or COMMIT failure: nothing was persisted, nobody may be told they succeeded
      for (const job of jobs) job.reject(error);
      return;
    }

    jobs.forEach((job, i) => {
      const outcome = outcomes[i]!;
      if (outcome.ok) job.resolve(outcome.value);
      else job.reject(outcome.error);
    });
  }
}