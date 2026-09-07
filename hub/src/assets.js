// Magic-byte sniffing, Content-Type mapping and R2 key layout for uploaded
// theme assets (API contract §4, flow step ④).
//
// R2 objects live under one of two states while a config's assets_status
// walks pending -> approved (or rejected): `pending/{id}/{kind}` for
// unreviewed bytes, `approved/{id}/{kind}` once an admin has reviewed and
// approved them (Task 6/9 write the "approved" side; this file only needs to
// know the key shape).

import { HttpError } from "./auth.js";
import { errorResponse } from "./http.js";

function startsWithBytes(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const ICO_MAGIC = [0x00, 0x00, 0x01, 0x00];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32]; // ascii "wOF2"
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]; // ascii "RIFF"
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50]; // ascii "WEBP", at offset 8

function isPng(bytes) {
  return startsWithBytes(bytes, PNG_MAGIC);
}

function isIco(bytes) {
  return startsWithBytes(bytes, ICO_MAGIC);
}

function isJpeg(bytes) {
  return startsWithBytes(bytes, JPEG_MAGIC);
}

function isWoff2(bytes) {
  return startsWithBytes(bytes, WOFF2_MAGIC);
}

// WebP is a RIFF container, so the format is named eight bytes in rather than
// at the front.
function isWebp(bytes) {
  if (bytes.length < 12) return false;
  if (!startsWithBytes(bytes, RIFF_MAGIC)) return false;
  for (let i = 0; i < 4; i++) {
    if (bytes[8 + i] !== WEBP_MAGIC[i]) return false;
  }
  return true;
}

export function isSvg(bytes) {
  let text;
  try {
    // TextDecoder strips a leading UTF-8 BOM by default (ignoreBOM: false),
    // so only leading whitespace needs handling here before the opening tag.
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return false;
  }
  text = text.replace(/^\s+/, "");
  return text.startsWith("<svg") || text.startsWith("<?xml");
}

// Pixel dimensions read straight out of the header -- no decode, so a PNG
// that expands to 20000x20000 is turned away before anything allocates its
// pixels. Returns null when the header cannot be read, which callers
// treat as a rejection: every real PNG/JPEG carries these fields, so a file
// that will not give them up is not one to hand a browser.
function pngDimensions(view, bytes) {
  if (bytes.length < 24) return null;
  if (view.getUint32(12) !== 0x49484452) return null; // "IHDR", always first
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Every SOFn frame header carries the size, except the four markers in that
// numeric range that are not frame headers at all (DHT, JPG, DAC, and the
// restart markers).
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(view, bytes) {
  let offset = 2; // past SOI
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null; // lost marker sync
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd9) {
      offset += 2; // standalone marker, no length field
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (marker === 0xda) return null; // start of scan, no frame header seen
    offset += 2 + length;
  }
  return null;
}

// WebP keeps its size in whichever of three bitstream chunks it uses: a lossy
// VP8 frame header, a lossless VP8L header, or the VP8X extended header that
// fronts an animation or an alpha channel. All three are fixed-offset reads
// once the chunk is found.
function webpDimensions(view, bytes) {
  if (bytes.length < 16) return null;
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  const payload = 20; // 12 RIFF/WEBP header + 4 fourcc + 4 chunk size

  // Each variant is bounded by what it actually reads rather than by one
  // blanket floor: a lossless header ends nine bytes before a lossy one, and
  // a small file has no obligation to carry the difference.
  if (fourcc === "VP8 ") {
    if (bytes.length < payload + 10) return null;
    // Key frames start with a 3-byte tag then this sync code; an interframe
    // has no size of its own and cannot be the first chunk of a still image.
    if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) {
      return null;
    }
    return {
      width: view.getUint16(payload + 6, true) & 0x3fff,
      height: view.getUint16(payload + 8, true) & 0x3fff,
    };
  }

  if (fourcc === "VP8L") {
    if (bytes.length < payload + 5) return null;
    if (bytes[payload] !== 0x2f) return null;
    // 14 bits of width-1 then 14 bits of height-1, packed little-endian.
    const bits = view.getUint32(payload + 1, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }

  if (fourcc === "VP8X") {
    if (bytes.length < payload + 10) return null;
    const canvas = payload + 4; // past the feature flags
    const read24 = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    return { width: read24(canvas) + 1, height: read24(canvas + 3) + 1 };
  }

  return null;
}

export function imageDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) return pngDimensions(view, bytes);
  if (isJpeg(bytes)) return jpegDimensions(view, bytes);
  if (isWebp(bytes)) return webpDimensions(view, bytes);
  return null;
}

// login_bg / main_bg accept PNG, JPEG or WebP bytes; callers that need to know
// which one matched (to record it for Content-Type on download) should use
// `sniffBgFormat` directly instead of the boolean-only MAGIC_CHECKS entry.
//
// WebP earns its place on a wallpaper slot: the same byte budget buys visibly
// more picture than JPEG, which is the whole shape of the problem here -- a
// full-bleed photo is the one asset that ever presses against the limit.
export function sniffBgFormat(bytes) {
  if (isPng(bytes)) return "png";
  if (isJpeg(bytes)) return "jpeg";
  if (isWebp(bytes)) return "webp";
  return null;
}

// The two full-page background kinds share one pipeline end to end: same
// magic sniff, same format tracking, same dimension cap.
export function isBgKind(kind) {
  return kind === "login_bg" || kind === "main_bg";
}

// A toolbar shortcut icon is whichever of SVG/PNG its author uploaded, so it
// is format-tracked the same way the bg kinds are. Those two are the only formats
// on offer because they are the only two the review console can render for
// a reviewer to look at — an icon in any other format could be shared but
// never approved.
export function sniffToolbarIconFormat(bytes) {
  if (isPng(bytes)) return "png";
  if (isSvg(bytes)) return "svg";
  return null;
}

// A toolbar shortcut icon per distinct custom icon the config's shortcuts
// name, numbered by first appearance. Both the sharing router and the
// receiving one derive that numbering from the shortcut list itself, so
// nothing about the mapping travels on the wire and the toolbar item shape in
// the payload is unchanged — see nth_custom_toolbar_icon in the LuCI app.
//
// 12 because that is TOOLBAR_MAX_ITEMS: a shortcut list is capped there, so no
// config can name a thirteenth distinct icon.
export const TOOLBAR_ICON_KINDS = Array.from(
  { length: 12 },
  (_, i) => `toolbar_icon_${i}`
);

const TOOLBAR_ICON_KIND_SET = new Set(TOOLBAR_ICON_KINDS);

export function isToolbarIconKind(kind) {
  return TOOLBAR_ICON_KIND_SET.has(kind);
}

// Kinds whose stored Content-Type cannot be derived from the kind alone: the
// bytes decide, and the format sniffed when they were accepted is carried in
// R2 customMetadata. Every path that writes such an object has to record it,
// and every path that serves one has to read it back.
export function isFormatTrackedKind(kind) {
  return isBgKind(kind) || isToolbarIconKind(kind);
}

// The format to record for `kind`, or undefined when the kind pins its own
// Content-Type. Returns null when the bytes match no accepted format — every
// caller has already run MAGIC_CHECKS by then, so that cannot happen; it is
// the same "sniff the real bytes rather than assume" posture approve takes
// after the console has rewritten them.
export function sniffFormat(kind, bytes) {
  if (isBgKind(kind)) return sniffBgFormat(bytes);
  if (isToolbarIconKind(kind)) return sniffToolbarIconFormat(bytes);
  return undefined;
}

// The whole rewrite rule, in one predicate: SVG is sanitized, every other
// format is stored byte-for-byte as the sharer uploaded it.
//
// SVG is the exception because it is a document, not a picture -- it can
// carry script, external references and CSS, none of which survive
// sanitizeSvg. A raster image cannot carry any of that, and the two tricks it
// could carry are already dead on arrival: a polyglot cannot be re-read as
// HTML because /assets/ pins the Content-Type from the sniffed format and
// sends nosniff, and a decompression bomb is turned away at upload by the
// dimension check above. What re-encoding a raster bought on top of that was
// metadata stripping -- paid for by degrading the image, which is not a
// trade this store makes: the bytes a sharer uploads are the bytes their
// theme gets.
//
// It also removes a whole failure class. The re-encoder was a second, harsher
// size gate downstream of the upload gate, so bytes could pass the one the
// sharer was told about and then die at review, unapprovable, with nobody
// able to do anything about it. Now there is one gate, at upload, and what
// clears it is what ships.
//
// Passthrough is decided from the stored bytes rather than from a static list
// of kinds because a toolbar icon is SVG or PNG depending on its author. The
// console declares which form it used per asset and approve rejects any
// disagreement, so the two sides cannot drift apart in silence.
export function approveRewritesBytes(bytes) {
  return isSvg(bytes);
}

// Full-page backgrounds legitimately arrive as 4K/5K wallpapers; an icon that
// large is a mistake or a bomb. Neither cap costs the sharer any quality --
// it is a "this image is the wrong shape for the slot" rejection, made at
// upload where it can still be acted on.
const MAX_BG_EDGE = 8192;
const MAX_ICON_EDGE = 4096;

export function maxImageEdge(kind) {
  return isBgKind(kind) ? MAX_BG_EDGE : MAX_ICON_EDGE;
}

// Kinds whose bytes are raster images, and so carry pixel dimensions worth
// capping. favicon_ico is left out: ICO is a container of several sizes with
// no single frame to measure, and its byte cap already bounds it.
export function isRasterImageKind(kind) {
  return (
    isBgKind(kind) ||
    kind === "favicon_png" ||
    kind === "pwa_icon_192" ||
    kind === "pwa_icon_512" ||
    isToolbarIconKind(kind)
  );
}

// Called by both ingest paths -- the one-shot base64 share/PUT (configs.js)
// and the chunked draft upload (drafts.js) -- so a route cannot be the one
// that forgets. Runs on the magic-checked bytes, off the header alone: a
// small PNG can still expand to 20000x20000, and since nothing re-encodes
// these bytes any more, this is the only thing standing between such a file
// and every browser that later renders it. Throwing here rather than at
// review is the point: the sharer is still in front of the picker and can
// pick a different image.
//
// A toolbar icon that sniffed as SVG has no raster header and is skipped --
// sanitizeSvg is what bounds that one.
export function assertImageWithinLimits(kind, bytes) {
  if (!isRasterImageKind(kind)) return;
  if (isToolbarIconKind(kind) && isSvg(bytes)) return;

  const dims = imageDimensions(bytes);
  if (!dims) {
    throw new HttpError(400, "bad_asset", `Asset ${kind} has an unreadable image header.`);
  }
  const edge = maxImageEdge(kind);
  if (dims.width > edge || dims.height > edge) {
    throw new HttpError(
      413,
      "asset_too_large",
      `Asset ${kind} is ${dims.width}x${dims.height}, over the ${edge}x${edge} limit.`
    );
  }
}

export const MAGIC_CHECKS = {
  logo_svg: isSvg,
  favicon_png: isPng,
  favicon_ico: isIco,
  pwa_icon_192: isPng,
  pwa_icon_512: isPng,
  login_bg: (bytes) => sniffBgFormat(bytes) !== null,
  main_bg: (bytes) => sniffBgFormat(bytes) !== null,
  font_sans: isWoff2,
  font_mono: isWoff2,
  ...Object.fromEntries(
    TOOLBAR_ICON_KINDS.map((kind) => [
      kind,
      (bytes) => sniffToolbarIconFormat(bytes) !== null,
    ])
  ),
};

const STATIC_CONTENT_TYPES = {
  logo_svg: "image/svg+xml",
  favicon_png: "image/png",
  favicon_ico: "image/x-icon",
  pwa_icon_192: "image/png",
  pwa_icon_512: "image/png",
  font_sans: "font/woff2",
  font_mono: "font/woff2",
};

// For a format-tracked kind (see isFormatTrackedKind) the Content-Type comes
// from the format recorded in R2 customMetadata at write time — pass that
// string in as `format`. Every other kind pins its own and ignores it.
//
// The fallbacks cover objects whose customMetadata went missing. A bg reads
// as PNG and a toolbar icon reads as PNG, never SVG: guessing "svg" for a
// raster byte stream would hand a browser a mislabelled image, while the
// reverse merely renders nothing.
const BG_CONTENT_TYPES = { jpeg: "image/jpeg", webp: "image/webp", png: "image/png" };

export function contentTypeFor(kind, format) {
  if (isBgKind(kind)) {
    return BG_CONTENT_TYPES[format] || "image/png";
  }
  if (isToolbarIconKind(kind)) {
    return format === "svg" ? "image/svg+xml" : "image/png";
  }
  return STATIC_CONTENT_TYPES[kind];
}

// "draft" is where a browser-direct upload lands before its config exists
// (drafts.js): the config id is only minted at commit time, so the bytes
// cannot be written straight to pending/. An R2 lifecycle rule expires the
// draft/ prefix, which is why abandoned uploads need no application-level GC.
const R2_STATES = new Set(["draft", "pending", "approved"]);

export function r2Key(state, id, kind) {
  if (!R2_STATES.has(state)) {
    throw new Error(`r2Key: invalid state "${state}"`);
  }
  return `${state}/${id}/${kind}`;
}

// ---------------------------------------------------------------------------
// #8 GET /assets/:id/:kind — stream an approved asset from R2.
// ---------------------------------------------------------------------------

async function serveAsset(env, id, kind) {
  // D1 行是「这份字节能不能公开」的唯一真相来源，判断由两部分组成：资产
  // 自己过了审(assets.status)，且它所属的配置仍在架上(configs.status)。
  //
  // 后半条是 Task 1 补的。在此之前 takedown 会顺手删掉 assets 行，配置状态
  // 因此从来不需要被检查；一旦下架改成保留字节以便恢复，缺了这个 JOIN 就
  // 意味着被下架配置的字体和登录背景仍然人人可取。
  //
  // R2 key 始终就地重算成 approved/{id}/{kind}，而不信任行里存的 r2_key 列。
  const row = await env.DB.prepare(
    `SELECT 1 FROM assets a
       JOIN configs c ON c.id = a.config_id
      WHERE a.config_id = ? AND a.kind = ? AND a.status = 'approved'
        AND c.status = 'active'`
  )
    .bind(id, kind)
    .first();

  if (!row) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  const object = await env.R2.get(r2Key("approved", id, kind));
  if (!object) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  const contentType = contentTypeFor(kind, object.customMetadata?.format);
  const headers = {
    "content-type": contentType,
    "cache-control": "public, max-age=604800, immutable",
    // Every /assets/ response gets nosniff, not just SVG — it costs nothing
    // and closes off MIME-sniffing surprises for any kind.
    "x-content-type-options": "nosniff",
  };
  // Keyed off the resolved Content-Type, not off the kind: a toolbar icon is
  // SVG or PNG depending on its bytes, and the whole point of this header is
  // that an SVG the browser is willing to parse can reach nothing else.
  if (contentType === "image/svg+xml") {
    headers["content-security-policy"] = "default-src 'none'";
  }

  return new Response(object.body, { headers });
}

export async function handleAssetServe(request, env, params) {
  try {
    return await serveAsset(env, params.id, params.kind);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}
