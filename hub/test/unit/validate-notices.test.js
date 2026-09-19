import { describe, expect, it } from "vitest";
import {
  validateNotice,
  validateSchemaPolicy,
  normalizeTimestamp,
  NOTICE_TITLE_MAX,
  NOTICE_BODY_MAX,
  NOTICE_URL_MAX,
} from "../../src/validate.js";
import { HttpError } from "../../src/auth.js";

function expectHttpError(fn, status, code) {
  try {
    fn();
    expect.unreachable(`expected HttpError(${status}, ${code}) to be thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  }
}

function buildNotice(overrides = {}) {
  return { theme: "aurora", level: "warning", audience: "all", title: "Heads up", ...overrides };
}

const rejects = (overrides) => expectHttpError(() => validateNotice(buildNotice(overrides)), 400, "bad_notice");

describe("normalizeTimestamp", () => {
  const fail = () => new Error("bad timestamp");

  it("passes null and undefined through as null", () => {
    expect(normalizeTimestamp(null, fail)).toBe(null);
    expect(normalizeTimestamp(undefined, fail)).toBe(null);
  });

  it.each([
    ["2026-12-01", "2026-12-01 00:00:00"],
    ["2026-12-01 08:30:15", "2026-12-01 08:30:15"],
    ["2026-12-01T08:30", "2026-12-01 08:30:00"],
    ["2026-12-01T08:30:15Z", "2026-12-01 08:30:15"],
    ["2026-12-01T08:30:15.250Z", "2026-12-01 08:30:15"],
    ["2026-12-01T08:00:00+08:00", "2026-12-01 00:00:00"],
    ["2026-12-01T20:00:00-05:30", "2026-12-02 01:30:00"],
    ["  2026-12-01T08:30:15Z  ", "2026-12-01 08:30:15"],
  ])("normalises %s to SQLite's UTC text format", (input, expected) => {
    expect(normalizeTimestamp(input, fail)).toBe(expected);
  });

  it.each([
    [""],
    ["soon 5"],
    ["2026-13-01"],
    ["2026-02-30"],
    ["2026-04-31T00:00:00Z"],
    ["2026-12-01T24:00:00Z"],
    ["2026-12-01T08:60:00Z"],
    ["2026-12-01T08:00:00+24:00"],
    ["2026/12/01"],
    [1796083200000],
    [{}],
  ])("rejects %j", (input) => {
    expect(() => normalizeTimestamp(input, fail)).toThrow("bad timestamp");
  });
});

describe("validateNotice", () => {
  it("fills every optional field for a minimal notice", () => {
    expect(validateNotice(buildNotice())).toEqual({
      theme: "aurora",
      level: "warning",
      audience: "all",
      title: "Heads up",
      body: "",
      url: "",
      i18n: {},
      min_schema: null,
      max_schema: null,
      starts_at: null,
      expires_at: null,
    });
  });

  it("keeps a fully specified notice, with timestamps normalised", () => {
    const notice = validateNotice(
      buildNotice({
        theme: "*",
        level: "critical",
        audience: "creators",
        body: "Schema 1 retires soon.",
        url: "admin/system/aurora/marketplace",
        i18n: { "zh-cn": { title: "注意", body: "schema 1 即将停用。" }, de: {} },
        min_schema: 1,
        max_schema: 1,
        starts_at: "2026-10-01T00:00:00Z",
        expires_at: "2026-12-01T08:00:00+08:00",
      })
    );
    expect(notice).toMatchObject({
      theme: "*",
      level: "critical",
      audience: "creators",
      url: "admin/system/aurora/marketplace",
      i18n: { "zh-cn": { title: "注意", body: "schema 1 即将停用。" }, de: {} },
      min_schema: 1,
      max_schema: 1,
      starts_at: "2026-10-01 00:00:00",
      expires_at: "2026-12-01 00:00:00",
    });
  });

  it("strips control characters and surrounding whitespace, keeping a body's line feeds and tabs", () => {
    const notice = validateNotice(
      buildNotice({
        title: "  He\u0000llo\u001f \n",
        body: "line one\r\n\tline two\u007f\u000b",
        i18n: { fr: { title: "Bon\u0007jour" } },
      })
    );
    expect(notice.title).toBe("Hello");
    expect(notice.body).toBe("line one\n\tline two");
    expect(notice.i18n.fr.title).toBe("Bonjour");
  });

  it("rejects a non-object and unknown fields", () => {
    expectHttpError(() => validateNotice(null), 400, "bad_notice");
    expectHttpError(() => validateNotice([]), 400, "bad_notice");
    rejects({ expire_at: "2026-12-01" });
  });

  it("enforces the theme, level and audience enums", () => {
    rejects({ theme: "argon" });
    rejects({ theme: undefined });
    rejects({ level: "fatal" });
    rejects({ audience: "everyone" });
  });

  it("bounds the title to 1-120 characters and the body to 4000", () => {
    expect(NOTICE_BODY_MAX).toBe(4000);
    rejects({ title: undefined });
    rejects({ title: 42 });
    rejects({ title: " \u0000 " });
    rejects({ title: "x".repeat(NOTICE_TITLE_MAX + 1) });
    rejects({ body: "x".repeat(NOTICE_BODY_MAX + 1) });
    rejects({ body: 42 });

    expect(validateNotice(buildNotice({ title: "x".repeat(NOTICE_TITLE_MAX) })).title).toHaveLength(NOTICE_TITLE_MAX);
    expect(validateNotice(buildNotice({ body: "x".repeat(4000) })).body).toHaveLength(4000);
    rejects({ body: "x".repeat(4001) });
    rejects({ body: "- item\n".repeat(572) });
  });

  it.each([
    ["https://example.com/releases/v2?x=1#notes"],
    ["admin/system"],
    ["admin/services/aurora-config/store_v2"],
    [""],
    [null],
  ])("accepts url %j", (url) => {
    expect(validateNotice(buildNotice({ url })).url).toBe(url ?? "");
  });

  it.each([
    ["http://example.com/"],
    ["javascript:alert(1)"],
    ["//example.com/x"],
    ["/admin/system"],
    ["admin"],
    ["admin/"],
    ["admin/../etc"],
    ["admin//system"],
    ["admin/system?x=1"],
    ["https://"],
    ["https://exa mple.com/"],
    ["https://trusted.example@evil.example/"],
    [`https://example.com/${"x".repeat(NOTICE_URL_MAX)}`],
    [42],
  ])("rejects url %j", (url) => {
    rejects({ url });
  });

  it("only takes locale keys mapping to {title?, body?} under the same limits", () => {
    rejects({ i18n: [] });
    rejects({ i18n: "zh-cn" });
    rejects({ i18n: { ZH: { title: "x" } } });
    rejects({ i18n: { "zh_cn": { title: "x" } } });
    rejects({ i18n: { chinese: { title: "x" } } });
    rejects({ i18n: { "zh-cn": "标题" } });
    rejects({ i18n: { "zh-cn": { title: "x", url: "https://example.com/" } } });
    rejects({ i18n: { "zh-cn": { title: "" } } });
    rejects({ i18n: { "zh-cn": { title: 42 } } });
    rejects({ i18n: { "zh-cn": { title: "x".repeat(NOTICE_TITLE_MAX + 1) } } });
    rejects({ i18n: { "zh-cn": { body: "x".repeat(NOTICE_BODY_MAX + 1) } } });

    rejects({ i18n: { "zh-cn": { body: "字".repeat(4001) } } });
    expect(validateNotice(buildNotice({ i18n: { "zh-cn": { body: "字".repeat(4000) } } })).i18n["zh-cn"].body).toHaveLength(4000);
    expect(validateNotice(buildNotice({ i18n: { "zh-cn": { body: "一\n\n- 二" } } })).i18n["zh-cn"].body).toBe("一\n\n- 二");

    expect(validateNotice(buildNotice({ i18n: null })).i18n).toEqual({});
    expect(validateNotice(buildNotice({ i18n: { "pt-br": { body: "" } } })).i18n).toEqual({ "pt-br": { body: "" } });
  });

  it("takes null or positive integer schema bounds, ordered", () => {
    rejects({ min_schema: 0 });
    rejects({ min_schema: -1 });
    rejects({ max_schema: 1.5 });
    rejects({ max_schema: "1" });
    rejects({ min_schema: 3, max_schema: 2 });

    expect(validateNotice(buildNotice({ min_schema: 2, max_schema: 2 }))).toMatchObject({ min_schema: 2, max_schema: 2 });
    expect(validateNotice(buildNotice({ min_schema: 2 }))).toMatchObject({ min_schema: 2, max_schema: null });
  });

  it("requires starts_at to precede expires_at when both are given", () => {
    rejects({ starts_at: "tomorrow" });
    rejects({ expires_at: "2026-02-30" });
    rejects({ starts_at: "2026-12-01", expires_at: "2026-12-01" });
    rejects({ starts_at: "2026-12-02", expires_at: "2026-12-01" });
    // Same instant written in two zones is still not "before".
    rejects({ starts_at: "2026-12-01T08:00:00+08:00", expires_at: "2026-12-01T00:00:00Z" });

    expect(validateNotice(buildNotice({ starts_at: "2026-12-01" }))).toMatchObject({
      starts_at: "2026-12-01 00:00:00",
      expires_at: null,
    });
  });
});

describe("validateSchemaPolicy", () => {
  it("normalises a policy", () => {
    expect(validateSchemaPolicy({ state: "deprecated", sunset_at: "2026-12-01T00:00:00Z" })).toEqual({
      state: "deprecated",
      sunset_at: "2026-12-01 00:00:00",
    });
    expect(validateSchemaPolicy({ state: "current" })).toEqual({ state: "current", sunset_at: null });
    expect(validateSchemaPolicy({ state: "unsupported", sunset_at: null })).toEqual({
      state: "unsupported",
      sunset_at: null,
    });
  });

  it("rejects an unknown state, a bad timestamp, extra keys and non-objects", () => {
    expectHttpError(() => validateSchemaPolicy({ state: "ok" }), 400, "bad_policy");
    expectHttpError(() => validateSchemaPolicy({}), 400, "bad_policy");
    expectHttpError(() => validateSchemaPolicy({ state: "deprecated", sunset_at: "later" }), 400, "bad_policy");
    expectHttpError(() => validateSchemaPolicy({ state: "current", theme: "aurora" }), 400, "bad_policy");
    expectHttpError(() => validateSchemaPolicy(null), 400, "bad_policy");
    expectHttpError(() => validateSchemaPolicy([]), 400, "bad_policy");
  });
});
