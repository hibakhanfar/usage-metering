import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, plans, requests, usageCounters, users } from "../db/schema";
import { conflict, notFound } from "../lib/errors";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

class QuotaRejected extends Error {
  constructor(public failed: CounterSpec) {
    super("quota_rejected");
  }
}

// ---------- helpers ----------

async function currentPeriods(tx: Tx): Promise<{ today: string; month: string }> {
  // One clock for everything: the database, in UTC. now() is fixed for the whole transaction.
  const result = await tx.execute(sql`
    select
      to_char(now() at time zone 'utc', 'YYYY-MM-DD') as today,
      to_char(date_trunc('month', now() at time zone 'utc'), 'YYYY-MM-DD') as month
  `);
  const row = result.rows[0] as { today: string; month: string };
  return { today: row.today, month: row.month };
}

async function loadPlans(tx: Tx, accountId: string, externalUserId: string) {
  const [account] = await tx
    .select({
      id: plans.id,
      name: plans.name,
      monthlyAllowance: plans.monthlyAllowance,
      dailyAllowance: plans.dailyAllowance,
      maxPerRequest: plans.maxPerRequest,
    })
    .from(accounts)
    .innerJoin(plans, eq(accounts.accountPlanId, plans.id))
    .where(eq(accounts.id, accountId));

  const [user] = await tx
    .select({
      userId: users.id,
      id: plans.id,
      name: plans.name,
      monthlyAllowance: plans.monthlyAllowance,
      dailyAllowance: plans.dailyAllowance,
      maxPerRequest: plans.maxPerRequest,
    })
    .from(users)
    .innerJoin(plans, eq(users.userPlanId, plans.id))
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalUserId)));

  if (!account) {
    throw notFound("Account not found");
  }
  if (!user) {
    throw notFound(`User "${externalUserId}" not found`);
  }
  const { userId, ...userPlan } = user;
  return { userId, userPlan: userPlan as PlanInfo, accountPlan: account as PlanInfo };
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

async function ensureCounters(tx: Tx, accountId: string, specs: CounterSpec[]) {
  await tx
    .insert(usageCounters)
    .values(
      specs.map((s) => ({
        accountId,
        userId: s.userId,
        periodType: s.period,
        periodStart: s.periodStart,
        unitsUsed: 0,
      })),
    )
    .onConflictDoNothing();
}

// The heart of the service: check + increment in ONE atomic statement.
// If the limit would be exceeded no row matches, nothing changes, and we get 0 rows back.
async function tryIncrement(tx: Tx, accountId: string, spec: CounterSpec, units: number): Promise<boolean> {
  const rows = await tx
    .update(usageCounters)
    .set({ unitsUsed: sql`${usageCounters.unitsUsed} + ${units}` })
    .where(
      and(
        counterWhere(accountId, spec),
        spec.limit === null ? undefined : sql`${usageCounters.unitsUsed} + ${units} <= ${spec.limit}`,
      ),
    )
    .returning({ id: usageCounters.id });
  return rows.length > 0;
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

export async function consume(db: Db, accountId: string, input: ConsumeInput) {
  return db.transaction(async (tx) => {
    const { userId, userPlan, accountPlan } = await loadPlans(tx, accountId, input.userId);
    const periods = await currentPeriods(tx);
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
    let violations: Violation[] = [];
    if (userPlan.maxPerRequest !== null && input.units > userPlan.maxPerRequest) {
      violations.push({ scope: "user", rule: "max_per_request", limit: userPlan.maxPerRequest, requested: input.units });
    }
    if (accountPlan.maxPerRequest !== null && input.units > accountPlan.maxPerRequest) {
      violations.push({ scope: "account", rule: "max_per_request", limit: accountPlan.maxPerRequest, requested: input.units });
    }

    // 4) Monthly + daily allowances: atomic conditional increments inside a savepoint.
    //    If any one fails, the savepoint rolls back the others, so a rejection consumes nothing.
    let failed: CounterSpec | null = null;
    if (violations.length === 0) {
      await ensureCounters(tx, accountId, specs);
      try {
        await tx.transaction(async (sp) => {
          for (const spec of specs) {
            if (!(await tryIncrement(sp, accountId, spec, input.units))) {
              throw new QuotaRejected(spec);
            }
          }
        });
      } catch (err) {
        if (!(err instanceof QuotaRejected)) {
          throw err;
        }
        failed = err.failed;
      }
    }

    // 5) Read the final numbers once (after the rollback, if there was one).
    const usedOf = await readUsage(tx, accountId, userId, periods);

    if (failed) {
      // Report every allowance that cannot fit this request, in the fixed order above.
      for (const spec of specs) {
        if (spec.limit !== null && usedOf(spec) + input.units > spec.limit) {
          violations.push({ scope: spec.scope, rule: spec.rule, limit: spec.limit, used: usedOf(spec), requested: input.units });
        }
      }
      if (violations.length === 0) {
        // Another request freed room in the meantime; still report the rule that failed.
        violations.push({ scope: failed.scope, rule: failed.rule, limit: failed.limit!, requested: input.units });
      }
    }

    const accepted = violations.length === 0;
    const primary = violations[0];

    await tx
      .update(requests)
      .set({
        accepted,
        rejectedBy: primary?.scope ?? null,
        rejectedRule: primary?.rule ?? null,
        violations: accepted ? null : JSON.stringify(violations),
      })
      .where(eq(requests.id, claimId));

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
  });
}