import express from "express";
import type { Db } from "./db/client";
import { adminRouter } from "./routes/admin";
import { errorHandler } from "./middleware/errorHandler";
import swaggerUi from "swagger-ui-express";
import { openapi } from "./openapi";
import { usersRouter } from "./routes/users";
import { plansRouter } from "./routes/plans";
import { accountRouter } from "./routes/account";

export function buildApp(db: Db, adminToken: string) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));
 
app.use("/admin", adminRouter(db, adminToken));
app.use("/users", usersRouter(db));
app.use("/plans", plansRouter(db));
app.use("/account", accountRouter(db));
  app.use(errorHandler);
  return app;
}