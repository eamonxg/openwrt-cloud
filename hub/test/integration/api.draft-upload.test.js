import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { makeToken, makePayload, makeAsset, PNG_1X1_BASE64 } from "../helpers.js";

function bytesOf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function newDraft(assetKind = "favicon_png") {
  const asset = await makeAsset(assetKind);
  const res = await SELF.fetch("https://hub.test/api/v1/themes/aurora/configs/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: makeToken(),
      name: "Draft " + Math.random(),
      description: "",
      payload: makePayload({
        assets: [asset.manifest],
        colors: {
          light_bg: "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0"),
        },
      }),
    }),
  });
  return { draft: await res.json(), asset };
}

async function newDraftWithBytes(assetKind, base64) {
  const asset = await makeAsset(assetKind, base64);
  const res = await SELF.fetch("https://hub.test/api/v1/themes/aurora/configs/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: makeToken(),
      name: "Draft " + Math.random(),
      description: "",
      payload: makePayload({
        assets: [asset.manifest],
        colors: {
          light_bg: "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0"),
        },
      }),
    }),
  });
  const draft = await res.json();
  return { draft, asset, entry: draft.assets[0] };
}

const put = (url, ticket, body) =>
  SELF.fetch("https://hub.test" + url, {
    method: "PUT",
    headers: { Authorization: "Bearer " + ticket, "content-type": "application/octet-stream" },
    body,
  });

// A PNG whose IHDR claims a size the store will not take. Only the header
// matters -- the gate never decodes -- so these carry no image data at all,
// which is also the point: materialising 9000x4000 pixels to prove a header
// check works would be silly.
const PNG_9000X4000 = "iVBORw0KGgoAAAANSUhEUgAAIygAAA+gCAAAAACyQOg7AAAAAElFTkSuQmCC";
const PNG_5000X5000 = "iVBORw0KGgoAAAANSUhEUgAAE4gAABOICAAAAAB489gXAAAAAElFTkSuQmCC";
const PNG_7680X4320 = "iVBORw0KGgoAAAANSUhEUgAAHgAAABDgCAAAAACT+ktPAAAAAElFTkSuQmCC";

describe("PUT /drafts/:id/assets/:kind", () => {
  it("stores bytes that match the ticket", async () => {
    const { draft } = await newDraft();
    const entry = draft.assets[0];
    const res = await put(entry.url, entry.ticket, bytesOf(PNG_1X1_BASE64));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "favicon_png", received: entry.size });

    // head() 而不是 get()：这里只关心元数据，而一个没被排空的 R2 body 流会
    // 让 miniflare 的 isolated storage 在 teardown 时撞上一个还开着的 sqlite
    // 连接（"Expected .sqlite, got …-shm"）。
    const stored = await env.R2.head(`draft/${draft.draft_id}/favicon_png`);
    expect(stored).not.toBeNull();
    expect(stored.size).toBe(entry.size);
    expect(stored.customMetadata.sha256).toBe(entry.sha256);
  });

  it("rejects bytes whose hash does not match the ticket", async () => {
    const { draft } = await newDraft();
    const entry = draft.assets[0];
    const wrong = bytesOf(PNG_1X1_BASE64);
    wrong[wrong.length - 1] ^= 0xff;
    const res = await put(entry.url, entry.ticket, wrong);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("asset_mismatch");
  });

  it("rejects a ticket issued for another kind", async () => {
    const { draft } = await newDraft();
    const entry = draft.assets[0];
    const res = await put(
      `/api/v1/drafts/${draft.draft_id}/assets/logo_svg`,
      entry.ticket,
      bytesOf(PNG_1X1_BASE64)
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("bad_ticket");
  });

  it("rejects a missing Authorization header", async () => {
    const { draft } = await newDraft();
    const res = await SELF.fetch("https://hub.test" + draft.assets[0].url, {
      method: "PUT",
      body: bytesOf(PNG_1X1_BASE64),
    });
    expect(res.status).toBe(403);
  });

  it("rejects bytes that fail the magic-byte check", async () => {
    // 这份草稿的 manifest 声明 logo_svg，但 makeAsset 给的仍是 PNG 字节 ——
    // 所以 hash/size 会对上、magic 检查会挂，正好验证两者的先后顺序。
    const { draft } = await newDraft("logo_svg");
    const entry = draft.assets[0];
    const res = await put(entry.url, entry.ticket, bytesOf(PNG_1X1_BASE64));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_asset");
  });
  // Nothing downstream re-encodes these bytes any more, so this is the only
  // place a decompression bomb is stopped -- and it is stopped while the
  // sharer is still standing in front of the picker.
  it("413 asset_too_large for a background over the 8192x8192 limit", async () => {
    const { draft } = await newDraft("login_bg");
    const entry = draft.assets[0];
    const res = await put(entry.url, entry.ticket, bytesOf(PNG_1X1_BASE64));
    expect(res.status).toBe(200);

    const big = await newDraftWithBytes("login_bg", PNG_9000X4000);
    const bigRes = await put(big.entry.url, big.entry.ticket, bytesOf(PNG_9000X4000));
    expect(bigRes.status).toBe(413);
    const body = await bigRes.json();
    expect(body.error.code).toBe("asset_too_large");
    // The message has to name the numbers, or it is not actionable.
    expect(body.error.message).toMatch(/9000x4000.*8192x8192/);
  });

  it("holds an icon to the tighter 4096x4096 limit a background is spared", async () => {
    const icon = await newDraftWithBytes("favicon_png", PNG_5000X5000);
    const iconRes = await put(icon.entry.url, icon.entry.ticket, bytesOf(PNG_5000X5000));
    expect(iconRes.status).toBe(413);
    expect((await iconRes.json()).error.message).toMatch(/5000x5000.*4096x4096/);

    // The very same pixels are fine in a slot meant for a wallpaper.
    const bg = await newDraftWithBytes("main_bg", PNG_5000X5000);
    const bgRes = await put(bg.entry.url, bg.entry.ticket, bytesOf(PNG_5000X5000));
    expect(bgRes.status).toBe(200);
  });

  it("takes a real 8K wallpaper, which is the whole reason backgrounds get 8192", async () => {
    const bg = await newDraftWithBytes("main_bg", PNG_7680X4320);
    const res = await put(bg.entry.url, bg.entry.ticket, bytesOf(PNG_7680X4320));
    expect(res.status).toBe(200);
  });

  it("400 bad_asset for bytes that pass the magic sniff but have no readable header", async () => {
    // PNG signature, then nothing: the sniff is happy, the header is not
    // there, and a file that will not say how big it is does not get stored.
    const headerless = "iVBORw0KGgo=";
    const draft = await newDraftWithBytes("favicon_png", headerless);
    const res = await put(draft.entry.url, draft.entry.ticket, bytesOf(headerless));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_asset");
  });
});
