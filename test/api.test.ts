import { describe, test, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Database } from "better-sqlite3";
import type { Express } from "express";
import { createDb } from "../src/db.js";
import { createApp } from "../src/server.js";

let app: Express;
let db: Database;

beforeEach(() => {
  db = createDb(":memory:");
  db.prepare(
    "INSERT INTO stores VALUES ('S412','Morrisons Wolverhampton')"
  ).run();
  db.prepare(
    "INSERT INTO formats VALUES ('aisle_barrier','Aisle Barrier')"
  ).run();
  db.prepare("INSERT INTO cycles VALUES ('C5',5,2026)").run();
  db.prepare(
    "INSERT INTO store_format_capacity VALUES ('S412','aisle_barrier',2)"
  ).run();
  app = createApp(db);
});

const body = {
  campaignId: "kelloggs",
  storeId: "S412",
  formatId: "aisle_barrier",
  cycleId: "C5",
  quantity: 1,
  traderId: "trader-a"
};

describe("GET /availability", () => {
  test("returns the breakdown, not just a total", async () => {
    const res = await request(app)
      .get("/availability")
      .query({ store: "S412", format: "aisle_barrier", cycle: "C5" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      capacity: 2,
      confirmed: 0,
      held: 0,
      available: 2
    });
  });

  test("404s for a store and format with no capacity record", async () => {
    const res = await request(app)
      .get("/availability")
      .query({ store: "S999", format: "aisle_barrier", cycle: "C5" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_store_or_format");
  });
});

describe("POST /holds", () => {
  test("201 with the hold id and expiry", async () => {
    const res = await request(app).post("/holds").send(body);

    expect(res.status).toBe(201);
    expect(res.body.holdId).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
  });

  // 409 means the request was valid and somebody got there first. That is a
  // normal outcome at peak, not a fault, and should not be alerted on.
  test("409 when the space has gone, with the current availability", async () => {
    await request(app)
      .post("/holds")
      .send({ ...body, quantity: 2 });

    const res = await request(app)
      .post("/holds")
      .send({ ...body, campaignId: "nestle" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("insufficient_availability");
    expect(res.body.error.details.available).toBe(0);
  });

  test("400 when required fields are missing", async () => {
    const res = await request(app).post("/holds").send({ storeId: "S412" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /holds/:id", () => {
  test("204 and the space comes back", async () => {
    const created = await request(app).post("/holds").send(body);

    const res = await request(app)
      .delete(`/holds/${created.body.holdId}`)
      .send({ releasedBy: "manager-1", reason: "Nestle takes priority" });

    expect(res.status).toBe(204);

    const after = await request(app)
      .get("/availability")
      .query({ store: "S412", format: "aisle_barrier", cycle: "C5" });
    expect(after.body.available).toBe(2);
  });
});

describe("POST /campaigns/:id/confirm", () => {
  test("returns both the confirmed count and the rejected list", async () => {
    await request(app).post("/holds").send(body);

    const res = await request(app)
      .post("/campaigns/kelloggs/confirm")
      .send({ confirmedBy: "trader-a" });

    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(1);
    expect(res.body.rejected).toEqual([]);
  });
});
