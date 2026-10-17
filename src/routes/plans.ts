import { Router } from "express";
import type { Db } from "../db/client";
import { apiKeyAuth } from "../middleware/auth";
import { createPlan, listPlans,  updatePlan} from "../services/plansService";
import { z } from "zod";
const allowance = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

const createPlanBody = z.object({
  kind: z.enum(["account", "user"]),
  name: z.string().trim().min(1).max(200),
  monthlyAllowance: allowance,
  dailyAllowance: allowance,
  maxPerRequest: allowance,
}).strict();

const updatePlanBody = createPlanBody
  .omit({ kind: true })
  .partial()
  .refine(
    (body) => Object.keys(body).length > 0,
    "Provide at least one field to update",
  );

const planIdParam = z.uuid();

export function plansRouter(db: Db) {
  const router = Router();

  router.use(apiKeyAuth(db));
router.post("/", async (req, res, next) => {
  try {
    const body = createPlanBody.parse(req.body);

    const plan = await createPlan(db, req.account!.id, body);

    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});

  router.get("/", async (req, res, next) => {
    try {
      const availablePlans = await listPlans(db, req.account!.id);

      res.json({ plans: availablePlans });
    } catch (err) {
      next(err);
    }
  });

 router.patch("/:planId", async (req, res, next) => {
  try {
    const planId = planIdParam.parse(req.params.planId);
    const body = updatePlanBody.parse(req.body);

    const plan = await updatePlan(
      db,
      req.account!.id,
      planId,
      body,
    );

    res.json(plan);
  } catch (err) {
    next(err);
  }
});
  return router;
}