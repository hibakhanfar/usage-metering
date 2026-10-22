import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/client";
import { apiKeyAuth } from "../middleware/auth";
import { ConsumeBatcher } from "../services/consumeBatcher";

const consumeBody = z
  .object({
    userId: z.string().min(1).max(200),
    units: z.number().int().positive().max(1_000_000_000),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export function consumeRouter(db: Db) {
  const router = Router();
const batcher = new ConsumeBatcher(
  db,
  Number(process.env.CONSUME_BATCH_MAX ?? 50),
  Number(process.env.CONSUME_MAX_PENDING ?? 1000),
);
  router.use(apiKeyAuth(db));

  router.post("/", async (req, res, next) => {
    try {
      const body = consumeBody.parse(req.body);
      res.json(await batcher.consume(req.account!.id, body));
    } catch (err) {
      next(err);
    }
  });

  return router;
}