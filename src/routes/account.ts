import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/client";
import { apiKeyAuth } from "../middleware/auth";
import { changeAccountPlan } from "../services/plansService";

const changeAccountPlanBody = z.object({
  planId: z.uuid(),
}).strict();

export function accountRouter(db: Db) {
  const router = Router();

  router.use(apiKeyAuth(db));

  router.patch("/plan", async (req, res, next) => {
    try {
      const { planId } = changeAccountPlanBody.parse(req.body);

      const account = await changeAccountPlan(
        db,
        req.account!.id,
        planId,
      );

      res.json(account);
    } catch (err) {
      next(err);
    }
  });

  return router;
}