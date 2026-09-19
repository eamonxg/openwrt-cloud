import { describe, expect, it } from "vitest";
import {
  parsePositiveInt,
  parseClientSchema,
  compatOf,
  DEFAULT_CLIENT_SCHEMA,
} from "../../src/schema-policy.js";
import { HttpError } from "../../src/auth.js";

const urlWith = (query) => new URL(`https://example.com/api/v1/notices${query}`);

describe("parsePositiveInt", () => {
  it.each([["1", 1], ["2", 2], ["120", 120]])("reads %j", (raw, expected) => {
    expect(parsePositiveInt(raw)).toBe(expected);
  });

  it.each([[""], ["0"], ["-1"], ["01"], ["1.5"], ["1e3"], [" 1"], ["abc"], ["99999999999999999999"], [null], [1]])(
    "refuses %j",
    (raw) => {
      expect(parsePositiveInt(raw)).toBe(null);
    }
  );
});

describe("parseClientSchema", () => {
  it("defaults to schema 1 when the parameter is absent", () => {
    expect(DEFAULT_CLIENT_SCHEMA).toBe(1);
    expect(parseClientSchema(urlWith(""))).toBe(1);
    expect(parseClientSchema(urlWith("?theme=aurora"))).toBe(1);
  });

  it("reads a positive integer", () => {
    expect(parseClientSchema(urlWith("?schema=3"))).toBe(3);
  });

  it.each([["?schema="], ["?schema=0"], ["?schema=-2"], ["?schema=1.5"], ["?schema=two"]])(
    "answers 400 bad_request for %s",
    (query) => {
      try {
        parseClientSchema(urlWith(query));
        expect.unreachable("expected a 400");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(400);
        expect(err.code).toBe("bad_request");
      }
    }
  );
});

describe("compatOf", () => {
  it("reports ok for a current policy and for no policy at all", () => {
    expect(compatOf("current", null)).toEqual({ state: "ok" });
    expect(compatOf(null, null)).toEqual({ state: "ok" });
    expect(compatOf(undefined, undefined)).toEqual({ state: "ok" });
  });

  it("drops a sunset date left on a current policy", () => {
    expect(compatOf("current", "2026-12-01 00:00:00")).toEqual({ state: "ok" });
  });

  it("carries the state and, when set, the sunset date", () => {
    expect(compatOf("deprecated", "2026-12-01 00:00:00")).toEqual({
      state: "deprecated",
      sunset_at: "2026-12-01 00:00:00",
    });
    expect(compatOf("deprecated", null)).toEqual({ state: "deprecated" });
    expect(compatOf("unsupported", null)).toEqual({ state: "unsupported" });
  });
});
