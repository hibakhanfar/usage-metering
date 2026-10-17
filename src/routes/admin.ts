import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/client";
import { createAccount } from "../services/accountsService";

const createAccountBody = z.object({
  name: z.string().min(1).max(200),
  planName: z.string().min(1).default("Starter"),
});

export function adminRouter(db: Db, adminToken: string) {
  const router = Router();

  router.use((req, res, next) => {
    if (req.header("x-admin-token") !== adminToken) {
      res.status(401).json({ error: "invalid_admin_token", message: "x-admin-token is missing or wrong" });
      return;
    }
    next();
  });

  router.post("/accounts", async (req, res, next) => {
    try {
      const body = createAccountBody.parse(req.body);
      const account = await createAccount(db, body);
      res.status(201).json(account);
    } catch (err) {
      next(err);
    }
  });

  return router;
}