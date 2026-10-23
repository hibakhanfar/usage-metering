import { and, count, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  accounts,
  plans,
  requests,
  usageCounters,
  users,
} from "../db/schema";
import { badRequest, notFound } from "../lib/errors";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type Pagination = {
  limit: number;
  offset: number;
};

type UsageQuery = Pagination & {
  month?: string;
};

type RequestsQuery = Pagination & {
  userId?: string;
  accepted?: boolean;
  month?: string;
};

type Period = "month" | "day";

export const MONTH_RE = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;

async function utcNow(tx: Tx) {
  const result = await tx.execute(sql`
    SELECT
      to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today,
      to_char(
        date_trunc('month', now() AT TIME ZONE 'UTC'),
        'YYYY-MM-DD'
      ) AS month
  `);

  return result.rows[0] as {
    today: string;
    month: string;
  };
}

function usageLine(limit: number | null, used: number) {
  return {
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
  };
}

function counterKey(userId: string | null, period: Period) {
  return `${userId ?? "account"}:${period}`;
}

export async function getUsage(
  db: Db,
  accountId: string,
  query: UsageQuery,
) {
  return db.transaction(
    async (tx) => {
      const now = await utcNow(tx);
      const periodStart = query.month
        ? `${query.month}-01`
        : now.month;

      if (periodStart > now.month) {
        throw badRequest("month cannot be in the future");
      }

      const current = periodStart === now.month;

      const [accountPlan] = await tx
        .select({
          id: plans.id,
          name: plans.name,
          monthlyAllowance: plans.monthlyAllowance,
          dailyAllowance: plans.dailyAllowance,
          maxPerRequest: plans.maxPerRequest,
        })
        .from(accounts)
        .innerJoin(plans, eq(accounts.accountPlanId, plans.id))
        .where(eq(accounts.id, accountId))
        .limit(1);

      if (!accountPlan) {
        throw notFound("Account not found");
      }

      const [userCount] = await tx
        .select({ total: count() })
        .from(users)
        .where(eq(users.accountId, accountId));

      const userRows = await tx
        .select({
          id: users.id,
          externalId: users.externalId,
          planId: plans.id,
          planName: plans.name,
          monthlyAllowance: plans.monthlyAllowance,
          dailyAllowance: plans.dailyAllowance,
          maxPerRequest: plans.maxPerRequest,
        })
        .from(users)
        .innerJoin(plans, eq(users.userPlanId, plans.id))
        .where(eq(users.accountId, accountId))
        .orderBy(users.externalId, users.id)
        .limit(query.limit)
        .offset(query.offset);

      const visibleUserIds = userRows.map((user) => user.id);

      const counterScope = visibleUserIds.length > 0
        ? sql`(
            ${usageCounters.userId} IS NULL
            OR ${usageCounters.userId} IN (
              ${sql.join(
                visibleUserIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}
            )
          )`
        : sql`${usageCounters.userId} IS NULL`;

      const counterRows = await tx
        .select({
          userId: usageCounters.userId,
          period: usageCounters.periodType,
          used: usageCounters.unitsUsed,
        })
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.accountId, accountId),
            counterScope,
            or(
              and(
                eq(usageCounters.periodType, "month"),
                eq(usageCounters.periodStart, periodStart),
              ),
              current
                ? and(
                    eq(usageCounters.periodType, "day"),
                    eq(usageCounters.periodStart, now.today),
                  )
                : undefined,
            ),
          ),
        );

      const counters = new Map<string, number>();

      for (const row of counterRows) {
        counters.set(counterKey(row.userId, row.period), row.used);
      }

      const usedOf = (userId: string | null, period: Period) =>
        counters.get(counterKey(userId, period)) ?? 0;

      const account = current
        ? {
            plan: {
              id: accountPlan.id,
              name: accountPlan.name,
              maxPerRequest: accountPlan.maxPerRequest,
            },
            monthly: usageLine(
              accountPlan.monthlyAllowance,
              usedOf(null, "month"),
            ),
            daily: usageLine(
              accountPlan.dailyAllowance,
              usedOf(null, "day"),
            ),
          }
        : {
            monthly: {
              used: usedOf(null, "month"),
            },
          };

      const items = userRows.map((user) => {
        if (!current) {
          return {
            userId: user.externalId,
            monthly: {
              used: usedOf(user.id, "month"),
            },
          };
        }

        return {
          userId: user.externalId,
          plan: {
            id: user.planId,
            name: user.planName,
            maxPerRequest: user.maxPerRequest,
          },
          monthly: usageLine(
            user.monthlyAllowance,
            usedOf(user.id, "month"),
          ),
          daily: usageLine(
            user.dailyAllowance,
            usedOf(user.id, "day"),
          ),
        };
      });

      return {
        month: periodStart.slice(0, 7),
        current,
        historicalLimitsAvailable: false,
        ...(current ? { today: now.today } : {}),
        account,
        users: {
          total: userCount?.total ?? 0,
          limit: query.limit,
          offset: query.offset,
          items,
        },
      };
    },
    {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    },
  );
}

export async function listRequests(
  db: Db,
  accountId: string,
  query: RequestsQuery,
) {
  return db.transaction(
    async (tx) => {
      if (query.month) {
        const now = await utcNow(tx);

        if (`${query.month}-01` > now.month) {
          throw badRequest("month cannot be in the future");
        }
      }

      const where = and(
        eq(requests.accountId, accountId),
        eq(users.accountId, accountId),
        query.userId !== undefined
          ? eq(users.externalId, query.userId)
          : undefined,
        query.accepted !== undefined
          ? eq(requests.accepted, query.accepted)
          : undefined,
        query.month
          ? eq(requests.month, `${query.month}-01`)
          : undefined,
      );

      const [requestCount] = await tx
        .select({ total: count() })
        .from(requests)
        .innerJoin(users, eq(requests.userId, users.id))
        .where(where);

      const rows = await tx
        .select({
          requestId: requests.requestId,
          userId: users.externalId,
          units: requests.units,
          accepted: requests.accepted,
          rejectedBy: requests.rejectedBy,
          rule: requests.rejectedRule,
          violations: requests.violations,
          month: requests.month,
          createdAt: requests.createdAt,
        })
        .from(requests)
        .innerJoin(users, eq(requests.userId, users.id))
        .where(where)
        .orderBy(desc(requests.createdAt), desc(requests.id))
        .limit(query.limit)
        .offset(query.offset);

      return {
        total: requestCount?.total ?? 0,
        limit: query.limit,
        offset: query.offset,
        items: rows.map((row) => ({
          ...row,
          month: row.month.slice(0, 7),
          violations: row.violations
            ? JSON.parse(row.violations)
            : [],
        })),
      };
    },
    {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    },
  );
}