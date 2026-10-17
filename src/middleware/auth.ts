import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts } from "../db/schema";
import { hashApiKey } from "../lib/apiKey";

export type AuthedAccount = {
  id: string;
  name: string;
  accountPlanId: string;
};

declare module "express-serve-static-core" {
  interface Request {
    account?: AuthedAccount;
  }
}

export function apiKeyAuth(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("x-api-key");
    if (!key) {
      res.status(401).json({ error: "missing_api_key", message: "x-api-key header is required" });
      return;
    }

    try {
      const [account] = await db
        .select({
          id: accounts.id,
          name: accounts.name,
          accountPlanId: accounts.accountPlanId,
        })
        .from(accounts)
        .where(eq(accounts.apiKeyHash, hashApiKey(key)))
        .limit(1);

      if (!account) {
        res.status(401).json({ error: "invalid_api_key", message: "API key is not valid" });
        return;
      }

      req.account = account;
      next();
    } catch (err) {
      next(err);
    }
  };
}