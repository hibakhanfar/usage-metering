import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, plans } from "../db/schema";
import { generateApiKey, hashApiKey } from "../lib/apiKey";
import { notFound } from "../lib/errors";

export async function createAccount(
  db: Db,
  input: { name: string; planName: string },
): Promise<{ id: string; name: string; apiKey: string }> {
  const [plan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(
      and(
        isNull(plans.accountId),
        eq(plans.kind, "account"),
        eq(plans.name, input.planName),
      ),
    )
    .limit(1);

  if (!plan) {
throw notFound(`Account plan "${input.planName}" not found`);  }

  const apiKey = generateApiKey();

  const [account] = await db
    .insert(accounts)
    .values({
      name: input.name,
      apiKeyHash: hashApiKey(apiKey),
      accountPlanId: plan.id,
    })
    .returning({ id: accounts.id, name: accounts.name });

  return { id: account!.id, name: account!.name, apiKey };
}