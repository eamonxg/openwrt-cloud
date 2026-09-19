import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makePayload, makeToken } from "../helpers.js";
import { shortId } from "../../src/ids.js";

const CONFIGS_URL = "https://example.com/api/v1/themes/aurora/configs";
const ME_URL = "https://example.com/api/v1/me";
const ADMIN_URL = "https://example.com/api/v1/admin";
const ADMIN_HEADERS = { Authorization: "Bearer test-admin-token", "content-type": "application/json" };

// validate.js only takes schema 1, so any other schema is written onto a
// row that was shared normally.
async function shareAs(schema, tint, token = makeToken()) {
  const res = await SELF.fetch(CONFIGS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: token,
      name: `Schema ${schema}`,
      payload: makePayload({ colors: { light_bg: tint } }),
    }),
  });
  expect(res.status).toBe(200);
  const { id } = await res.json();
  await env.DB.prepare("UPDATE configs SET schema = ? WHERE id = ?").bind(schema, id).run();
  return id;
}

async function setPolicy(schema, state, sunset_at = null) {
  const res = await SELF.fetch(`${ADMIN_URL}/schemas/aurora/${schema}`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ state, sunset_at }),
  });
  expect(res.status).toBe(200);
}

async function listedIds(query = "") {
  const res = await SELF.fetch(`${CONFIGS_URL}${query}`);
  expect(res.status).toBe(200);
  return (await res.json()).items.map((item) => item.id);
}

function postMe(body) {
  return SELF.fetch(ME_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /themes/:theme/configs?schema=N: visibility", () => {
  it("shows a client its own schema and older ones, never newer ones", async () => {
    const one = await shareAs(1, "#5a0001");
    const two = await shareAs(2, "#5a0002");
    const three = await shareAs(3, "#5a0003");

    // No parameter is schema 1: that is every client shipped so far.
    expect(await listedIds()).toEqual([one]);
    expect(await listedIds("?schema=1")).toEqual([one]);
    expect((await listedIds("?schema=2")).sort()).toEqual([one, two].sort());
    expect((await listedIds("?schema=3")).sort()).toEqual([one, two, three].sort());
    expect((await listedIds("?schema=9")).sort()).toEqual([one, two, three].sort());
  });

  it("keeps a deprecated schema listed for newer clients", async () => {
    const one = await shareAs(1, "#5a0011");
    const two = await shareAs(2, "#5a0012");
    await setPolicy(1, "deprecated", "2999-01-01");

    expect(await listedIds("?schema=1")).toEqual([one]);
    expect((await listedIds("?schema=2")).sort()).toEqual([one, two].sort());
  });

  it("hides an unsupported schema from newer clients only", async () => {
    const one = await shareAs(1, "#5a0021");
    const two = await shareAs(2, "#5a0022");
    const three = await shareAs(3, "#5a0023");
    await setPolicy(1, "unsupported");

    // Equal schema always lists: an old router still reads what it always read.
    expect(await listedIds("?schema=1")).toEqual([one]);
    expect(await listedIds("?schema=2")).toEqual([two]);
    // Schema 2 has no policy row, which counts as current.
    expect((await listedIds("?schema=3")).sort()).toEqual([two, three].sort());

    await setPolicy(2, "unsupported");
    expect(await listedIds("?schema=2")).toEqual([two]);
    expect(await listedIds("?schema=3")).toEqual([three]);
  });

  it.each([["abc"], ["0"], ["-1"], ["1.5"], [""]])("answers 400 bad_request for schema=%j", async (schema) => {
    const res = await SELF.fetch(`${CONFIGS_URL}?schema=${schema}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("fills pages from visible rows only, so has_more stays truthful", async () => {
    const deviceId = shortId();
    await env.DB.prepare("INSERT INTO devices (id, secret_hash) VALUES (?, ?)").bind(deviceId, shortId()).run();

    const payload = JSON.stringify(makePayload());
    const insert = (schema, downloads) =>
      env.DB
        .prepare(
          `INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema, downloads)
           VALUES (?, 'aurora', ?, 'Row', ?, ?, ?, ?)`
        )
        .bind(shortId(), deviceId, payload, shortId(), schema, downloads);

    // The schema-2 rows outrank every schema-1 row under the default hot
    // sort: filtered after the LIMIT, they would hollow out page 1.
    const statements = [];
    for (let i = 0; i < 10; i++) statements.push(insert(2, 1000 + i));
    for (let i = 0; i < 25; i++) statements.push(insert(1, i));
    await env.DB.batch(statements);

    const first = await (await SELF.fetch(`${CONFIGS_URL}?schema=1`)).json();
    expect(first.items).toHaveLength(24);
    expect(first.items.every((item) => item.schema === 1)).toBe(true);
    expect(first.has_more).toBe(true);

    const second = await (await SELF.fetch(`${CONFIGS_URL}?schema=1&page=2`)).json();
    expect(second.items).toHaveLength(1);
    expect(second.has_more).toBe(false);

    const newer = await (await SELF.fetch(`${CONFIGS_URL}?schema=2&page=2`)).json();
    expect(newer.items).toHaveLength(11);
    expect(newer.has_more).toBe(false);
  });
});

describe("GET /themes/:theme/configs/:id: compat", () => {
  it("reports ok under a current policy and under no policy", async () => {
    const one = await shareAs(1, "#5a0031");
    const two = await shareAs(2, "#5a0032");

    expect((await (await SELF.fetch(`${CONFIGS_URL}/${one}`)).json()).compat).toEqual({ state: "ok" });
    expect((await (await SELF.fetch(`${CONFIGS_URL}/${two}`)).json()).compat).toEqual({ state: "ok" });
  });

  it("carries the deprecation and its sunset date", async () => {
    const id = await shareAs(1, "#5a0033");
    await setPolicy(1, "deprecated", "2026-12-01T00:00:00Z");

    const detail = await (await SELF.fetch(`${CONFIGS_URL}/${id}`)).json();
    expect(detail.compat).toEqual({ state: "deprecated", sunset_at: "2026-12-01 00:00:00" });
  });

  it("still serves an unsupported config, whatever schema the caller claims", async () => {
    const id = await shareAs(1, "#5a0034");
    await setPolicy(1, "unsupported");

    // A share link must not turn into a 404 just because the list dropped it.
    expect(await listedIds("?schema=2")).toEqual([]);
    const res = await SELF.fetch(`${CONFIGS_URL}/${id}?schema=2`);
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.id).toBe(id);
    expect(detail.compat).toEqual({ state: "unsupported" });
  });
});

describe("POST /api/v1/me: compat", () => {
  it("adds schema and compat to every config, and a summary beside them", async () => {
    const token = makeToken();
    const id = await shareAs(1, "#5a0041", token);

    const body = await (await postMe({ device_token: token })).json();
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0]).toMatchObject({ id, schema: 1, compat: { state: "ok" } });
    expect(body.compat_summary).toEqual({ current_schema: 1, deprecated: 0, unsupported: 0 });
  });

  it("counts deprecated and unsupported shares, active rows only", async () => {
    const token = makeToken();
    const oldLive = await shareAs(1, "#5a0051", token);
    const oldTakenDown = await shareAs(1, "#5a0052", token);
    const midLive = await shareAs(2, "#5a0053", token);
    const newLive = await shareAs(3, "#5a0054", token);

    await SELF.fetch(`${ADMIN_URL}/configs/${oldTakenDown}/takedown`, { method: "POST", headers: ADMIN_HEADERS });
    await setPolicy(1, "unsupported");
    await setPolicy(2, "deprecated", "2027-01-01");
    await setPolicy(3, "current");

    const body = await (await postMe({ device_token: token })).json();
    const byId = Object.fromEntries(body.configs.map((config) => [config.id, config]));

    expect(byId[oldLive]).toMatchObject({ schema: 1, status: "active", compat: { state: "unsupported" } });
    // Still told about the takedown, still labelled -- but not counted.
    expect(byId[oldTakenDown]).toMatchObject({ schema: 1, status: "removed", compat: { state: "unsupported" } });
    expect(byId[midLive]).toMatchObject({
      schema: 2,
      compat: { state: "deprecated", sunset_at: "2027-01-01 00:00:00" },
    });
    expect(byId[newLive]).toMatchObject({ schema: 3, compat: { state: "ok" } });

    expect(body.compat_summary).toEqual({ current_schema: 3, deprecated: 1, unsupported: 1 });
  });

  it("falls back to schema 1 when no policy is current", async () => {
    const token = makeToken();
    await shareAs(1, "#5a0061", token);
    await setPolicy(1, "deprecated");

    const body = await (await postMe({ device_token: token })).json();
    expect(body.compat_summary).toEqual({ current_schema: 1, deprecated: 1, unsupported: 0 });
  });

  it("leaves the shapes that list no configs exactly as they were", async () => {
    const unknown = await (await postMe({ device_token: makeToken() })).json();
    expect(unknown).toEqual({ id: null, nickname: null, configs: [] });

    const token = makeToken();
    await shareAs(1, "#5a0071", token);
    await setPolicy(1, "deprecated");

    const invalid = await (await postMe({ device_token: token, nickname: "   " })).json();
    expect(invalid).toEqual({ id: expect.any(String), nickname: null, configs: [], error: "invalid_nickname" });

    await postMe({ device_token: makeToken(), nickname: "Holder" });
    const taken = await (await postMe({ device_token: token, nickname: "holder" })).json();
    expect(taken).toEqual({ id: expect.any(String), nickname: null, configs: [], error: "nickname_taken" });

    // A rename that goes through does list configs, so it carries the summary.
    const renamed = await (await postMe({ device_token: token, nickname: "Fresh" })).json();
    expect(renamed.nickname).toBe("Fresh");
    expect(renamed.compat_summary).toEqual({ current_schema: 1, deprecated: 1, unsupported: 0 });
  });
});
