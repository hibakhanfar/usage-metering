import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler";

describe("Request body errors", () => {
  it("returns 413 when the JSON body exceeds the size limit", async () => {
    const app = express();

    app.use(express.json());

    app.post("/test", (_req, res) => {
      res.json({ ok: true });
    });

    app.use(errorHandler);

    const response = await request(app)
      .post("/test")
      .send({
        value: "a".repeat(110 * 1024),
      });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: "payload_too_large",
      message: "Request body is too large",
    });
  });
});