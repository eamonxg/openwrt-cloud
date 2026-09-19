import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makePayload, makeToken } from "../helpers.js";

const ADMIN_URL = "https://example.com/api/v1/admin";
const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";

function adminGet(path, token = "test-admin-token") {
  return SELF.fetch(`${ADMIN_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

function adminPost(path, body, token = "test-admin-token") {
  return SELF.fetch(`${ADMIN_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// validate.js only takes schema 1, so any other schema is written onto a
// row that was shared normally.
async function shareAs(schema, tint) {
  const res = await SELF.fetch(SHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: makeToken(),
      name: `Schema ${schema}`,
      payload: makePayload({ colors: { light_bg: tint } }),
    }),
  });
  expect(res.status).toBe(200);
  const { id } = await res.json();
  await env.DB.prepare("UPDATE configs SET schema = ? WHERE id = ?").bind(schema, id).run();
  return id;
}

async function policyRow(schema) {
  return env.DB
    .prepare("SELECT state, sunset_at FROM schema_policies WHERE theme = 'aurora' AND schema = ?")
    .bind(schema)
    .first();
}

describe("admin schemas: gate", () => {
  it.each([
    ["GET", "/schemas"],
    ["POST", "/schemas/aurora/1"],
  ])("%s %s answers 401 without a valid admin token", async (method, path) => {
    expect((await SELF.fetch(`${ADMIN_URL}${path}`, { method })).status).toBe(401);
    const wrong = await SELF.fetch(`${ADMIN_URL}${path}`, {
      method,
      headers: { Authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("leaves the seeded policy alone when the gate refuses an upsert", async () => {
    const res = await SELF.fetch(`${ADMIN_URL}/schemas/aurora/1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "unsupported", sunset_at: null }),
    });
    expect(res.status).toBe(401);
    expect(await policyRow(1)).toEqual({ state: "current", sunset_at: null });
  });
});

describe("GET /admin/schemas", () => {
  it("starts from the seeded aurora schema 1 policy", async () => {
    const body = await (await adminGet("/schemas")).json();
    expect(body.items).toEqual([
      {
        theme: "aurora",
        schema: 1,
        state: "current",
        sunset_at: null,
        updated_at: expect.any(String),
        active_configs: 0,
      },
    ]);
  });

  it("counts active configs per schema and reports a policy-less schema as current", async () => {
    await shareAs(1, "#5c0001");
    const removed = await shareAs(1, "#5c0002");
    await shareAs(2, "#5c0003");
    await shareAs(2, "#5c0004");
    await adminPost(`/configs/${removed}/takedown`);
    await adminPost("/schemas/aurora/3", { state: "current", sunset_at: null });

    const body = await (await adminGet("/schemas")).json();
    expect(body.items).toEqual([
      expect.objectContaining({ theme: "aurora", schema: 1, state: "current", active_configs: 1 }),
      { theme: "aurora", schema: 2, state: "current", sunset_at: null, updated_at: null, active_configs: 2 },
      expect.objectContaining({ theme: "aurora", schema: 3, state: "current", active_configs: 0 }),
    ]);
  });
});

describe("POST /admin/schemas/:theme/:schema", () => {
  it("updates the existing policy and logs it under the acting admin", async () => {
    const res = await adminPost(
      "/schemas/aurora/1",
      { state: "deprecated", sunset_at: "2026-12-01T08:00:00+08:00" },
      "alice-token"
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      theme: "aurora",
      schema: 1,
      state: "deprecated",
      sunset_at: "2026-12-01 00:00:00",
    });
    expect(await policyRow(1)).toEqual({ state: "deprecated", sunset_at: "2026-12-01 00:00:00" });

    const { results } = await env.DB
      .prepare("SELECT actor, action, target_type, target_id, note FROM admin_actions ORDER BY id ASC")
      .all();
    expect(results).toEqual([
      {
        actor: "alice",
        action: "set_policy",
        target_type: "schema",
        target_id: "aurora/1",
        note: "deprecated, sunset 2026-12-01 00:00:00",
      },
    ]);
  });

  it("inserts a policy for a schema that had none, then overwrites it", async () => {
    expect(await policyRow(2)).toBeNull();

    expect((await adminPost("/schemas/aurora/2", { state: "current" })).status).toBe(200);
    expect(await policyRow(2)).toEqual({ state: "current", sunset_at: null });

    expect((await adminPost("/schemas/aurora/2", { state: "unsupported", sunset_at: null })).status).toBe(200);
    expect(await policyRow(2)).toEqual({ state: "unsupported", sunset_at: null });

    const { results } = await env.DB
      .prepare("SELECT note FROM admin_actions WHERE target_type = 'schema' AND target_id = 'aurora/2' ORDER BY id ASC")
      .all();
    expect(results.map((row) => row.note)).toEqual(["current", "unsupported"]);
  });

  it("only knows the aurora theme", async () => {
    const res = await adminPost("/schemas/argon/1", { state: "current" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("unknown_theme");
  });

  it.each([["0"], ["-1"], ["1.5"], ["two"]])("answers 400 bad_request for schema %s", async (schema) => {
    const res = await adminPost(`/schemas/aurora/${schema}`, { state: "current" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it.each([
    ["unknown state", { state: "ok" }],
    ["missing state", { sunset_at: null }],
    ["unparseable sunset", { state: "deprecated", sunset_at: "later" }],
    ["unknown field", { state: "current", note: "x" }],
  ])("refuses a policy with %s", async (_label, body) => {
    const res = await adminPost("/schemas/aurora/1", body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_policy");
    expect(await policyRow(1)).toEqual({ state: "current", sunset_at: null });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_actions").first()).n).toBe(0);
  });

  it("refuses a body that is not a JSON object", async () => {
    const res = await adminPost("/schemas/aurora/1");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_json");
  });
});

// Migration 0009 rebuilt admin_actions to widen one CHECK. Everything the old
// table promised has to have survived the rebuild.
describe("admin_actions after the 0009 rebuild", () => {
  function insertAction(targetType) {
    return env.DB
      .prepare("INSERT INTO admin_actions (actor, action, target_type, target_id) VALUES ('root', 'probe', ?, 'x')")
      .bind(targetType)
      .run();
  }

  it("takes the three old target types and the two new ones, and still refuses anything else", async () => {
    for (const targetType of ["config", "device", "report", "notice", "schema"]) {
      // eslint-disable-next-line no-await-in-loop
      await insertAction(targetType);
    }
    await expect(insertAction("bogus")).rejects.toThrow(/CHECK/);
  });

  it("kept its defaults and its AUTOINCREMENT key", async () => {
    await insertAction("notice");
    const row = await env.DB.prepare("SELECT * FROM admin_actions").first();
    expect(row).toEqual({
      id: expect.any(Number),
      actor: "root",
      action: "probe",
      target_type: "notice",
      target_id: "x",
      note: "",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });

    const { results } = await env.DB
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_actions'")
      .all();
    expect(results[0].sql).toContain("AUTOINCREMENT");
  });

  it("has both indexes back, under their original names, and no leftover table", async () => {
    const { results } = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE tbl_name LIKE 'admin_actions%' ORDER BY name")
      .all();
    expect(results.map((row) => row.name)).toEqual([
      "admin_actions",
      "idx_admin_actions_recent",
      "idx_admin_actions_target",
    ]);
  });
});
