import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ADMIN_URL = "https://example.com/api/v1/admin";
const FEED_URL = "https://example.com/api/v1/notices?theme=aurora";

function adminGet(path, token = "test-admin-token") {
  return SELF.fetch(`${ADMIN_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

function adminPost(path, body, token = "test-admin-token") {
  return SELF.fetch(`${ADMIN_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function buildNotice(overrides = {}) {
  return { theme: "aurora", level: "warning", audience: "all", title: "Heads up", ...overrides };
}

async function createNotice(overrides, token) {
  const res = await adminPost("/notices", buildNotice(overrides), token);
  expect(res.status).toBe(200);
  return (await res.json()).id;
}

async function logRows(targetId) {
  const { results } = await env.DB
    .prepare("SELECT * FROM admin_actions WHERE target_id = ? ORDER BY id ASC")
    .bind(targetId)
    .all();
  return results;
}

async function feedIds() {
  return (await (await SELF.fetch(FEED_URL)).json()).notices.map((notice) => notice.id);
}

describe("admin notices: gate", () => {
  it.each([
    ["GET", "/notices"],
    ["POST", "/notices"],
    ["POST", "/notices/abcd1234/revoke"],
  ])("%s %s answers 401 without a valid admin token", async (method, path) => {
    const bare = await SELF.fetch(`${ADMIN_URL}${path}`, { method });
    expect(bare.status).toBe(401);

    const wrong = await SELF.fetch(`${ADMIN_URL}${path}`, {
      method,
      headers: { Authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe("unauthorized");
  });

  it("writes nothing when the gate refuses a create", async () => {
    const res = await SELF.fetch(`${ADMIN_URL}/notices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildNotice()),
    });
    expect(res.status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notices").first()).n).toBe(0);
  });
});

describe("POST /admin/notices", () => {
  it("publishes a notice to the feed and records who did it", async () => {
    const res = await adminPost(
      "/notices",
      buildNotice({
        title: "  Schema 1\u0000 retires ",
        body: "Update your shares.",
        url: "https://example.com/changelog",
        i18n: { "zh-cn": { title: "schema 1 即将停用", body: "请更新你的分享。" } },
        max_schema: 1,
        expires_at: "2999-01-01T08:00:00+08:00",
      }),
      "alice-token"
    );
    expect(res.status).toBe(200);
    const { id, created } = await res.json();
    expect(created).toBe(true);
    expect(id).toMatch(/^[0-9a-z]{8}$/);

    const feed = await (await SELF.fetch(FEED_URL)).json();
    expect(feed.notices).toHaveLength(1);
    expect(feed.notices[0]).toMatchObject({
      id,
      level: "warning",
      audience: "all",
      title: "Schema 1 retires",
      body: "Update your shares.",
      url: "https://example.com/changelog",
      i18n: { "zh-cn": { title: "schema 1 即将停用", body: "请更新你的分享。" } },
      starts_at: null,
      expires_at: "2999-01-01 00:00:00",
    });

    const rows = await logRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "alice",
      action: "create",
      target_type: "notice",
      target_id: id,
      note: "warning/all: Schema 1 retires",
    });
  });

  it("stores '*' notices and schema bounds as given", async () => {
    const id = await createNotice({ theme: "*", min_schema: 2, max_schema: 3 });
    const row = await env.DB.prepare("SELECT theme, min_schema, max_schema, i18n FROM notices WHERE id = ?").bind(id).first();
    expect(row).toEqual({ theme: "*", min_schema: 2, max_schema: 3, i18n: "{}" });
  });

  it("hands markdown bodies back untouched from the feed and the admin list", async () => {
    const body =
      "## Heads *up*\n\n**Bold**, `code` and [a link](https://example.com/a).\n\n" +
      "- one\n- two\n\n1. first\n\n> quoted\n\n---\n\n```\n\tindented <b>code</b>\n```\n\n" +
      "<img src=x onerror=alert(1)> [bad](javascript:alert(1))";
    const zhBody = "**注意**\n\n- 第一项\n- 第二项";
    const id = await createNotice({ body, i18n: { "zh-cn": { body: zhBody } } });

    const fed = (await (await SELF.fetch(FEED_URL)).json()).notices.find((notice) => notice.id === id);
    expect(fed.body).toBe(body);
    expect(fed.i18n["zh-cn"].body).toBe(zhBody);

    const listed = (await (await adminGet("/notices")).json()).items.find((item) => item.id === id);
    expect(listed.body).toBe(body);
    expect(listed.i18n["zh-cn"].body).toBe(zhBody);
  });

  it("takes a full-length body in both languages within the request cap", async () => {
    const id = await createNotice({ body: "x".repeat(4000), i18n: { "zh-cn": { body: "字".repeat(4000) } } });
    const row = await env.DB.prepare("SELECT length(body) AS n FROM notices WHERE id = ?").bind(id).first();
    expect(row.n).toBe(4000);
  });

  it.each([
    ["missing title", { title: undefined }],
    ["empty title", { title: "   " }],
    ["long title", { title: "x".repeat(121) }],
    ["long body", { body: "x".repeat(4001) }],
    ["unknown level", { level: "fatal" }],
    ["unknown audience", { audience: "everyone" }],
    ["unknown theme", { theme: "argon" }],
    ["plain http url", { url: "http://example.com/" }],
    ["script url", { url: "javascript:alert(1)" }],
    ["absolute LuCI path", { url: "/admin/system" }],
    ["traversing LuCI path", { url: "admin/../etc" }],
    ["i18n array", { i18n: [] }],
    ["bad locale key", { i18n: { Chinese: { title: "x" } } }],
    ["extra i18n field", { i18n: { "zh-cn": { title: "x", url: "https://example.com/" } } }],
    ["long i18n title", { i18n: { "zh-cn": { title: "x".repeat(121) } } }],
    ["long i18n body", { i18n: { "zh-cn": { body: "字".repeat(4001) } } }],
    ["zero min_schema", { min_schema: 0 }],
    ["inverted schema bounds", { min_schema: 2, max_schema: 1 }],
    ["unparseable starts_at", { starts_at: "tomorrow" }],
    ["impossible date", { expires_at: "2026-02-30" }],
    ["inverted window", { starts_at: "2026-12-02", expires_at: "2026-12-01" }],
    ["unknown field", { expire_at: "2026-12-01" }],
  ])("refuses a notice with %s", async (_label, overrides) => {
    const res = await adminPost("/notices", buildNotice(overrides));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_notice");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notices").first()).n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_actions").first()).n).toBe(0);
  });

  it("refuses a body that is not a JSON object, and one over the cap", async () => {
    const notJson = await adminPost("/notices", "not json");
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error.code).toBe("bad_json");

    const array = await adminPost("/notices", [buildNotice()]);
    expect(array.status).toBe(400);
    expect((await array.json()).error.code).toBe("bad_json");

    const none = await adminPost("/notices");
    expect(none.status).toBe(400);

    const huge = await adminPost("/notices", buildNotice({ body: "x".repeat(64 * 1024) }));
    expect(huge.status).toBe(413);
    expect((await huge.json()).error.code).toBe("too_large");
  });
});

describe("GET /admin/notices", () => {
  it("lists every notice with its status, newest first, paginated", async () => {
    const expired = await createNotice({ title: "Expired", expires_at: "2000-01-01" });
    const scheduled = await createNotice({ title: "Scheduled", starts_at: "2999-01-01" });
    const revoked = await createNotice({ title: "Revoked" });
    const active = await createNotice({ title: "Active", i18n: { de: { title: "Aktiv" } } });
    expect((await adminPost(`/notices/${revoked}/revoke`)).status).toBe(200);

    const res = await adminGet("/notices");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({ page: 1, page_size: 50, total: 4 });
    expect(body.items.map((item) => [item.id, item.status])).toEqual([
      [active, "active"],
      [revoked, "revoked"],
      [scheduled, "scheduled"],
      [expired, "expired"],
    ]);
    expect(body.items[0]).toMatchObject({
      theme: "aurora",
      level: "warning",
      audience: "all",
      title: "Active",
      body: "",
      url: "",
      i18n: { de: { title: "Aktiv" } },
      min_schema: null,
      max_schema: null,
      starts_at: null,
      expires_at: null,
      revoked_at: null,
    });
    expect(body.items[1].revoked_at).toEqual(expect.any(String));

    // Only the active one is what routers actually receive.
    expect(await feedIds()).toEqual([active]);

    const beyond = await (await adminGet("/notices?page=2")).json();
    expect(beyond).toMatchObject({ items: [], page: 2, total: 4 });
  });
});

describe("POST /admin/notices/:id/revoke", () => {
  it("pulls the notice from the feed at once and logs it", async () => {
    const id = await createNotice();
    expect(await feedIds()).toEqual([id]);

    const res = await adminPost(`/notices/${id}/revoke`, undefined, "bob-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, revoked: true });
    expect(await feedIds()).toEqual([]);

    const rows = await logRows(id);
    expect(rows.map((row) => [row.actor, row.action, row.target_type])).toEqual([
      ["root", "create", "notice"],
      ["bob", "revoke", "notice"],
    ]);
  });

  it("is idempotent: a second revoke succeeds without a second log row", async () => {
    const id = await createNotice();
    await adminPost(`/notices/${id}/revoke`);
    const { revoked_at: firstStamp } = await env.DB.prepare("SELECT revoked_at FROM notices WHERE id = ?").bind(id).first();

    const again = await adminPost(`/notices/${id}/revoke`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, revoked: true });

    const { revoked_at: secondStamp } = await env.DB.prepare("SELECT revoked_at FROM notices WHERE id = ?").bind(id).first();
    expect(secondStamp).toBe(firstStamp);
    expect((await logRows(id)).map((row) => row.action)).toEqual(["create", "revoke"]);
  });

  it("answers 404 for an id that does not exist", async () => {
    const res = await adminPost("/notices/zzzzzzzz/revoke");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});
