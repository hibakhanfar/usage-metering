import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import { accounts, plans, requests, usageCounters, users } from "../db/schema";
import { conflict, notFound } from "../lib/errors";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type Scope = "account" | "user";
export type RuleName = "max_per_request" | "monthly_allowance" | "daily_allowance";

export type Violation = {
  scope: Scope;
  rule: RuleName;
  limit: number;
  requested: number;
  used?: number;
};

type Limits = {
  monthlyAllowance: number | null;
  dailyAllowance: number | null;
  maxPerRequest: number | null;
};

type PlanInfo = Limits & { id: string; name: string };

type CounterSpec = {
  scope: Scope;
  period: "month" | "day";
  periodStart: string;
  userId: string | null; // null = the account-level (shared) counter
  limit: number | null; // null = unlimited
  rule: RuleName;
};

export type ConsumeInput = { userId: string; units: number; requestId: string };

// ---------- helpers ----------

// One round trip for everything we need before touching any counter:
// the account's plan, the user (and their plan), and the current UTC day/month from the database clock.
async function loadContext(tx: Tx, accountId: string, externalUserId: string) {
  const userPlan = alias(plans, "user_plan");
  const [row] = await tx
    .select({
      accountPlanId: plans.id,
      accountPlanName: plans.name,
      accountMonthly: plans.monthlyAllowance,
      accountDaily: plans.dailyAllowance,
      accountMax: plans.maxPerRequest,
      userId: users.id,
      userPlanId: userPlan.id,
      userPlanName: userPlan.name,
      userMonthly: userPlan.monthlyAllowance,
      userDaily: userPlan.dailyAllowance,
      userMax: userPlan.maxPerRequest,
      today: sql<string>`to_char(now() at time zone 'utc', 'YYYY-MM-DD')`,
      month: sql<string>`to_char(date_trunc('month', now() at time zone 'utc'), 'YYYY-MM-DD')`,
    })
    .from(accounts)
    .innerJoin(plans, eq(accounts.accountPlanId, plans.id))
    .leftJoin(users, and(eq(users.accountId, accounts.id), eq(users.externalId, externalUserId)))
    .leftJoin(userPlan, eq(users.userPlanId, userPlan.id))
    .where(eq(accounts.id, accountId));

  if (!row) {
    throw notFound("Account not found");
  }
  if (!row.userId || !row.userPlanId || row.userPlanName === null) {
    throw notFound(`User "${externalUserId}" not found`);
  }

  return {
    userId: row.userId,
    userPlan: {
      id: row.userPlanId,
      name: row.userPlanName,
      monthlyAllowance: row.userMonthly,
      dailyAllowance: row.userDaily,
      maxPerRequest: row.userMax,
    } as PlanInfo,
    accountPlan: {
      id: row.accountPlanId,
      name: row.accountPlanName,
      monthlyAllowance: row.accountMonthly,
      dailyAllowance: row.accountDaily,
      maxPerRequest: row.accountMax,
    } as PlanInfo,
    periods: { today: row.today, month: row.month },
  };
}

// Order matters: this is both the locking order and the order rejection reasons are reported in.
// User counters first, shared account counters last (the account rows are the hot spot,
// so we hold their locks for as short a time as possible).
function buildSpecs(
  userId: string,
  userPlan: Limits,
  accountPlan: Limits,
  p: { today: string; month: string },
): CounterSpec[] {
  return [
    { scope: "user", period: "month", periodStart: p.month, userId, limit: userPlan.monthlyAllowance, rule: "monthly_allowance" },
    { scope: "user", period: "day", periodStart: p.today, userId, limit: userPlan.dailyAllowance, rule: "daily_allowance" },
    { scope: "account", period: "month", periodStart: p.month, userId: null, limit: accountPlan.monthlyAllowance, rule: "monthly_allowance" },
    { scope: "account", period: "day", periodStart: p.today, userId: null, limit: accountPlan.dailyAllowance, rule: "daily_allowance" },
  ];
}

function counterWhere(accountId: string, spec: CounterSpec) {
  return and(
    eq(usageCounters.accountId, accountId),
    spec.userId === null ? isNull(usageCounters.userId) : eq(usageCounters.userId, spec.userId),
    eq(usageCounters.periodType, spec.period),
    eq(usageCounters.periodStart, spec.periodStart),
  );
}
// Returns the id of each counter row, in the same order as `specs`
// (creating the ones that do not exist yet: first request of a user / day / month).
async function counterIds(
  tx: Tx,
  accountId: string,
  specs: CounterSpec[],
): Promise<{ ids: string[]; used: number[] }> {
  const find = () =>
    tx
      .select({
        id: usageCounters.id,
        userId: usageCounters.userId,
        periodType: usageCounters.periodType,
        periodStart: usageCounters.periodStart,
        unitsUsed: usageCounters.unitsUsed,
      })
      .from(usageCounters)
      .where(or(...specs.map((spec) => counterWhere(accountId, spec))));

  const match = (rows: Awaited<ReturnType<typeof find>>, spec: CounterSpec) =>
    rows.find(
      (r) => r.userId === spec.userId && r.periodType === spec.period && r.periodStart === spec.periodStart,
    );

  let rows = await find();
  const missing = specs.filter((spec) => !match(rows, spec));

  if (missing.length > 0) {
    await tx
      .insert(usageCounters)
      .values(
        missing.map((spec) => ({
          accountId,
          userId: spec.userId,
          periodType: spec.period,
          periodStart: spec.periodStart,
          unitsUsed: 0,
        })),
      )
      .onConflictDoNothing(); // a concurrent request may have created them first
    rows = await find();
  }

  const hits = specs.map((spec) => {
    const hit = match(rows, spec);
    if (!hit) {
      throw new Error("usage counter row is missing");
    }
    return hit;
  });
  return { ids: hits.map((h) => h.id), used: hits.map((h) => h.unitsUsed) };
}

type Applied = { ok: boolean; before: number[]; used: number[] };

// The heart of the service, in ONE statement and ONE round trip:
//   1. lock the counter rows (user rows first, shared account rows last: a fixed order, so no deadlocks)
//   2. check every limit against the locked, up-to-date values
//   3. if ALL fit, add the units to ALL of them (and mark the request accepted); otherwise change nothing
// Nothing can slip in between the check and the increment because the rows are locked until commit,
// and a rejection leaves no partial increments because the update is all-or-nothing.
async function applyIncrements(
  tx: Tx,
  specs: CounterSpec[],
  ids: string[],
  units: number,
  claimId: string,
): Promise<Applied> {
  const values = sql.join(
    specs.map((s, i) => sql`(${i}::int, ${ids[i]!}::uuid, ${s.limit}::bigint)`),
    sql`, `,
  );

  const result = await tx.execute(sql`
    with specs(ord, id, lim) as (values ${values}),
    locked as materialized (
      select c.id, c.units_used, s.ord, s.lim
        from usage_counters c
        join specs s on s.id = c.id
       order by s.ord
         for update of c
    ),
    verdict as (
      select coalesce(bool_and(lim is null or units_used + ${units}::bigint <= lim), true) as ok
        from locked
    ),
    bumped as (
      update usage_counters u
         set units_used = u.units_used + ${units}::bigint
        from locked l, verdict v
       where u.id = l.id and v.ok
      returning u.id, u.units_used
    ),
    decided as (
      update requests r
         set accepted = true
        from verdict v
       where r.id = ${claimId}::uuid and v.ok
      returning r.id
    )
    select l.ord, l.units_used as before_used, v.ok, b.units_used as after_used
      from locked l
     cross join verdict v
      left join bumped b on b.id = l.id
     order by l.ord
  `);

  const rows = result.rows as {
    ord: number | string;
    before_used: number | string;
    ok: boolean;
    after_used: number | string | null;
  }[];

  if (rows.length !== specs.length) {
    throw new Error("usage counter rows missing from the increment statement");
  }

  rows.sort((a, b) => Number(a.ord) - Number(b.ord));
  const ok = rows[0]!.ok;
  const before = rows.map((r) => Number(r.before_used));
  const used = ok ? rows.map((r) => Number(r.after_used)) : before;
  return { ok, before, used };
}

async function readUsage(tx: Tx, accountId: string, userId: string, p: { today: string; month: string }) {
  const rows = await tx
    .select({
      userId: usageCounters.userId,
      periodType: usageCounters.periodType,
      periodStart: usageCounters.periodStart,
      unitsUsed: usageCounters.unitsUsed,
    })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.accountId, accountId),
        inArray(usageCounters.periodStart, [p.month, p.today]),
        or(isNull(usageCounters.userId), eq(usageCounters.userId, userId)),
      ),
    );

  return (spec: CounterSpec): number => {
    const hit = rows.find(
      (r) => r.userId === spec.userId && r.periodType === spec.period && r.periodStart === spec.periodStart,
    );
    return hit?.unitsUsed ?? 0;
  };
}

const line = (limit: number | null, used: number) => ({
  limit,
  used,
  remaining: limit === null ? null : Math.max(0, limit - used), // never negative
});

function balance(plan: PlanInfo, specs: CounterSpec[], scope: Scope, usedOf: (s: CounterSpec) => number) {
  const month = specs.find((s) => s.scope === scope && s.period === "month")!;
  const day = specs.find((s) => s.scope === scope && s.period === "day")!;
  return {
    plan: { id: plan.id, name: plan.name },
    maxPerRequest: plan.maxPerRequest,
    monthly: line(plan.monthlyAllowance, usedOf(month)),
    daily: line(plan.dailyAllowance, usedOf(day)),
  };
}

// ---------- main entry point ----------

// Runs one consume decision inside a transaction the CALLER owns (and commits).
// Used directly by consume() below, and by the batcher, which runs many of these in one transaction.
export async function consumeInTx(tx: Tx, accountId: string, input: ConsumeInput) {
  const { userId, userPlan, accountPlan, periods } = await loadContext(tx, accountId, input.userId);
  const specs = buildSpecs(userId, userPlan, accountPlan, periods);

  // 1) Claim the requestId. The UNIQUE(account_id, request_id) index makes this the single
  //    point of arbitration: concurrent duplicates wait here, then see the winner's row.
  const claimed = await tx
    .insert(requests)
    .values({
      accountId,
      userId,
      requestId: input.requestId,
      units: input.units,
      accepted: false, // placeholder, set below in the same transaction
      month: periods.month,
    })
    .onConflictDoNothing()
    .returning({ id: requests.id });

  // 2) Retry of a request we already decided: return the stored decision, consume nothing.
  if (claimed.length === 0) {
    const [existing] = await tx
      .select()
      .from(requests)
      .where(and(eq(requests.accountId, accountId), eq(requests.requestId, input.requestId)));
    if (!existing) {
      throw new Error("requestId conflict but no stored request found");
    }
    if (existing.userId !== userId || existing.units !== input.units) {
      throw conflict(`requestId "${input.requestId}" was already used with different parameters`);
    }
    const usedOf = await readUsage(tx, accountId, userId, periods);
    return {
      requestId: input.requestId,
      userId: input.userId,
      units: input.units,
      accepted: existing.accepted,
      replayed: true,
      rejectedBy: existing.rejectedBy,
      rule: existing.rejectedRule,
      violations: existing.violations ? (JSON.parse(existing.violations) as Violation[]) : [],
      user: balance(userPlan, specs, "user", usedOf),
      account: balance(accountPlan, specs, "account", usedOf),
    };
  }
  const claimId = claimed[0]!.id;

  // 3) Per-request limits: a plain comparison, no counters touched.
  const violations: Violation[] = [];
  if (userPlan.maxPerRequest !== null && input.units > userPlan.maxPerRequest) {
    violations.push({ scope: "user", rule: "max_per_request", limit: userPlan.maxPerRequest, requested: input.units });
  }
  if (accountPlan.maxPerRequest !== null && input.units > accountPlan.maxPerRequest) {
    violations.push({ scope: "account", rule: "max_per_request", limit: accountPlan.maxPerRequest, requested: input.units });
  }

  // 4) Monthly + daily allowances: one all-or-nothing statement (see applyIncrements).
  let usedOf: (s: CounterSpec) => number;
  if (violations.length === 0) {
    const { ids, used } = await counterIds(tx, accountId, specs);

    // Usage only ever grows inside a period. So if the COMMITTED usage already does not fit this
    // request, it can never fit later: reject right away, WITHOUT locking any counter row.
    // This keeps rejections from queueing behind the shared account row once it is exhausted.
    specs.forEach((spec, i) => {
      if (spec.limit !== null && used[i]! + input.units > spec.limit) {
        violations.push({ scope: spec.scope, rule: spec.rule, limit: spec.limit, used: used[i]!, requested: input.units });
      }
    });

    if (violations.length > 0) {
      usedOf = (spec) => used[specs.indexOf(spec)]!;
    } else {
      // Everything looks like it fits: lock and re-check atomically (the committed view may be stale).
      const applied = await applyIncrements(tx, specs, ids, input.units, claimId);
      usedOf = (spec) => applied.used[specs.indexOf(spec)]!;

      if (!applied.ok) {
        // Report every allowance that cannot fit this request, in the fixed order of `specs`.
        specs.forEach((spec, i) => {
          const before = applied.before[i]!;
          if (spec.limit !== null && before + input.units > spec.limit) {
            violations.push({ scope: spec.scope, rule: spec.rule, limit: spec.limit, used: before, requested: input.units });
          }
        });
        if (violations.length === 0) {
          throw new Error("increment rejected but no violated allowance found");
        }
      }
    }
  } else {
    usedOf = await readUsage(tx, accountId, userId, periods);
  }

  const accepted = violations.length === 0;
  const primary = violations[0];

  // An accepted request was already marked accepted inside applyIncrements (no extra round trip).
  if (!accepted) {
    await tx
      .update(requests)
      .set({
        accepted: false,
        rejectedBy: primary!.scope,
        rejectedRule: primary!.rule,
        violations: JSON.stringify(violations),
      })
      .where(eq(requests.id, claimId));
  }

  return {
    requestId: input.requestId,
    userId: input.userId,
    units: input.units,
    accepted,
    replayed: false,
    rejectedBy: primary?.scope ?? null,
    rule: primary?.rule ?? null,
    violations,
    user: balance(userPlan, specs, "user", usedOf),
    account: balance(accountPlan, specs, "account", usedOf),
  };
}

export type ConsumeResult = Awaited<ReturnType<typeof consumeInTx>>;

// One request, one transaction. Kept for tests and for callers that do not need batching.
export function consume(db: Db, accountId: string, input: ConsumeInput): Promise<ConsumeResult> {
  return db.transaction((tx) => consumeInTx(tx, accountId, input));
}