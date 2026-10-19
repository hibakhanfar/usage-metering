import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/client";
import { apiKeyAuth } from "../middleware/auth";
import {
  getUsage,
  listRequests,
  MONTH_RE,
} from "../services/usageService";

const monthParam = z
  .string()
  .regex(MONTH_RE, "month must be YYYY-MM");

const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .default(0),
};

const usageQuery = z.object({
  ...pagination,
  month: monthParam.optional(),
}).strict();

const requestsQuery = z.object({
  ...pagination,
  month: monthParam.optional(),
  userId: z.string().min(1).max(200).optional(),
  accepted: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
}).strict();

export function usageRouter(db: Db) {
  const router = Router();

  router.use(apiKeyAuth(db));

  router.get("/", async (req, res, next) => {
    try {
      const query = usageQuery.parse(req.query);

      res.json(await getUsage(db, req.account!.id, query));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function requestsRouter(db: Db) {
  const router = Router();

  router.use(apiKeyAuth(db));

  router.get("/", async (req, res, next) => {
    try {
      const query = requestsQuery.parse(req.query);

      res.json(await listRequests(db, req.account!.id, query));
    } catch (err) {
      next(err);
    }
  });

  return router;
}