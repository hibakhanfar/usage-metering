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

        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`);
        for (const job of jobs) {
          try {
            const value = await tx.transaction((sp) => consumeInTx(sp, accountId, job.input));
            outcomes.push({ ok: true, value });
          } catch (error) {
            outcomes.push({ ok: false, error });
          }
        }
      });
    } catch (error) {
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