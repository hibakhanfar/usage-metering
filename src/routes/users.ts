import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/client";
import { apiKeyAuth } from "../middleware/auth";
import {changeUserPlan,createUser, listUsers } from "../services/usersService";

const createUserBody = z.object({
  externalId: z.string().min(1).max(200),
  planName: z.string().min(1).default("Basic"),
});

export function usersRouter(db: Db) {
  const router = Router();
  router.use(apiKeyAuth(db)); // every route below requires a valid x-api-key

  router.post("/", async (req, res, next) => {
    try {
      const body = createUserBody.parse(req.body);
      const user = await createUser(db, req.account!.id, body);
      res.status(201).json(user);
    } catch (err) {
      next(err);
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      res.json({ users: await listUsers(db, req.account!.id) });
    } catch (err) {
      next(err);
    }
  });
const changePlanBody = z.object({
  planId: z.uuid(),
}).strict();

router.patch("/:externalId/plan", async (req, res, next) => {
  try {
    const { planId } = changePlanBody.parse(req.body);

    const user = await changeUserPlan(
      db,
      req.account!.id,
      String(req.params.externalId),
      planId,
    );

    res.json(user);
  } catch (err) {
    next(err);
  }
});

  return router;
}
