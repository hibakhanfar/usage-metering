import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }

  if ("code" in err && err.code === "23505") {
    return true;
  }

  if ("cause" in err) {
    const cause = err.cause;

    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "23505"
    );
  }

  return false;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "validation_error", issues: err.issues });
    return;
  }

  if (
  err instanceof SyntaxError &&
  "status" in err &&
  err.status === 400 &&
  "type" in err &&
  err.type === "entity.parse.failed"
) {
  res.status(400).json({
    error: "invalid_json",
    message: "Request body must contain valid JSON",
  });
  return;
}

  if (isUniqueViolation(err)) {
  res.status(409).json({
    error: "conflict",
    message: "A record with these unique fields already exists",
  });
  return;
}
  console.error(err);
  res.status(500).json({ error: "internal_error", message: "Something went wrong" });
}