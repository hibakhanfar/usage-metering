import express from "express";
import type { Db } from "./db/client";
import { adminRouter } from "./routes/admin";
import { errorHandler } from "./middleware/errorHandler";

export function buildApp(db: Db, adminToken: string) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/admin", adminRouter(db, adminToken));

  app.use(errorHandler);
  return app;
}