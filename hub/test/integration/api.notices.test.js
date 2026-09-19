import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { shortId } from "../../src/ids.js";

const FEED_URL = "https://example.com/api/v1/notices";

// Straight into the table: the admin API refuses nothing here that matters,
// but it cannot backdate created_at or write a theme other than aurora / *.
async function insertNotice(overrides = {}) {
  const row = {
    id: shortId(),
    theme: "aurora",
    level: "info",
    audience: "all",
    title: "Notice",
    body: "",
    url: "",
    i18n: "{}",
    min_schema: null,
    max_schema: null,
    starts_at: null,
    expires_at: null,
    created_at: "2026-09-01 00:00:00",
    revoked_at: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  await env.DB
    .prepare(`INSERT INTO notices (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((column) => row[column]))
    .run();
  return row.id;
}

async function feedIds(query = "?theme=aurora") {
  const res = await SELF.fetch(`${FEED_URL}${query}`);
  expect(res.status).toBe(200);
  return (await res.json()).notices.map((notice) => notice.id);
}

describe("GET /api/v1/notices", () => {
  it("needs no credentials and answers an empty feed", async () => {
    const res = await SELF.fetch(`${FEED_URL}?theme=aurora`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notices: [] });
  });

  it("is cacheable for five minutes and readable cross-origin", async () => {
    const res = await SELF.fetch(`${FEED_URL}?theme=aurora&schema=1`, {
      headers: { Origin: "http://192.168.1.1" },
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("requires a known theme", async () => {
    const missing = await SELF.fetch(FEED_URL);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("bad_request");

    const unknown = await SELF.fetch(`${FEED_URL}?theme=argon`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("unknown_theme");

    // '*' addresses rows, it is not a theme a client can ask for.
    expect((await SELF.fetch(`${FEED_URL}?theme=*`)).status).toBe(404);
  });

  it.each([["abc"], ["0"], ["-1"], ["1.5"], [""]])("answers 400 bad_request for schema=%j", async (schema) => {
    const res = await SELF.fetch(`${FEED_URL}?theme=aurora&schema=${schema}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("returns exactly the public fields, with i18n as an object", async () => {
    const id = await insertNotice({
      level: "warning",
      audience: "creators",
      title: "Schema 1 retires",
      body: "Update your shares.",
      url: "admin/system/aurora",
      i18n: JSON.stringify({ "zh-cn": { title: "schema 1 即将停用" } }),
      max_schema: 1,
      expires_at: "2999-01-01 00:00:00",
    });

    const body = await (await SELF.fetch(`${FEED_URL}?theme=aurora`)).json();
    expect(body.notices).toEqual([
      {
        id,
        level: "warning",
        audience: "creators",
        title: "Schema 1 retires",
        body: "Update your shares.",
        url: "admin/system/aurora",
        i18n: { "zh-cn": { title: "schema 1 即将停用" } },
        starts_at: null,
        expires_at: "2999-01-01 00:00:00",
        created_at: "2026-09-01 00:00:00",
      },
    ]);
  });

  it("withholds revoked, not-yet-started and expired notices", async () => {
    const live = await insertNotice();
    const windowed = await insertNotice({ starts_at: "2000-01-01 00:00:00", expires_at: "2999-01-01 00:00:00" });
    const revoked = await insertNotice({ revoked_at: "2026-09-02 00:00:00" });
    const scheduled = await insertNotice({ starts_at: "2999-01-01 00:00:00" });
    const expired = await insertNotice({ expires_at: "2000-01-01 00:00:00" });

    const ids = await feedIds();
    expect(ids).toContain(live);
    expect(ids).toContain(windowed);
    expect(ids).not.toContain(revoked);
    expect(ids).not.toContain(scheduled);
    expect(ids).not.toContain(expired);
  });

  it("matches the client's theme plus '*', and nothing else", async () => {
    const own = await insertNotice({ theme: "aurora" });
    const everyone = await insertNotice({ theme: "*" });
    const other = await insertNotice({ theme: "argon" });

    const ids = await feedIds();
    expect(ids).toContain(own);
    expect(ids).toContain(everyone);
    expect(ids).not.toContain(other);
  });

  it("targets by the client's schema, defaulting to 1", async () => {
    const untargeted = await insertNotice();
    const onlyOld = await insertNotice({ max_schema: 1 });
    const onlyNew = await insertNotice({ min_schema: 2 });
    const exactlyTwo = await insertNotice({ min_schema: 2, max_schema: 2 });

    expect((await feedIds()).sort()).toEqual([untargeted, onlyOld].sort());
    expect((await feedIds("?theme=aurora&schema=1")).sort()).toEqual([untargeted, onlyOld].sort());
    expect((await feedIds("?theme=aurora&schema=2")).sort()).toEqual([untargeted, onlyNew, exactlyTwo].sort());
    expect((await feedIds("?theme=aurora&schema=3")).sort()).toEqual([untargeted, onlyNew].sort());
  });

  it("lists newest first, insertion order breaking a same-second tie, capped at 20", async () => {
    const inserted = [];
    for (let day = 1; day <= 22; day++) {
      // eslint-disable-next-line no-await-in-loop
      inserted.push(await insertNotice({ created_at: `2026-08-${String(day).padStart(2, "0")} 00:00:00` }));
    }
    const tiedFirst = await insertNotice({ created_at: "2026-08-31 12:00:00" });
    const tiedSecond = await insertNotice({ created_at: "2026-08-31 12:00:00" });

    const ids = await feedIds();
    expect(ids).toHaveLength(20);
    expect(ids.slice(0, 2)).toEqual([tiedSecond, tiedFirst]);
    expect(ids.slice(2)).toEqual(inserted.slice(4).reverse());
  });
});
