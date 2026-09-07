import { describe, it, expect } from "vitest";
import {
  imageDimensions,
  maxImageEdge,
  isRasterImageKind,
  approveRewritesBytes,
  sniffBgFormat,
  contentTypeFor,
} from "../../src/assets.js";

// A PNG header is fixed-layout: 8-byte signature, then the IHDR chunk whose
// first two fields are the dimensions.
function png(width, height, { chunkName = "IHDR" } = {}) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([...chunkName].map((c) => c.charCodeAt(0)), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

// SOI, then any number of length-prefixed segments, then a frame header whose
// payload starts with precision/height/width.
function jpeg(width, height, { marker = 0xc0, before = [] } = {}) {
  const out = [0xff, 0xd8];
  for (const seg of before) {
    out.push(0xff, seg.marker, (seg.length >> 8) & 0xff, seg.length & 0xff);
    for (let i = 0; i < seg.length - 2; i++) out.push(0x00);
  }
  out.push(0xff, marker, 0x00, 0x11, 0x08);
  out.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  for (let i = 0; i < 8; i++) out.push(0x00);
  return new Uint8Array(out);
}

describe("imageDimensions", () => {
  it("reads a PNG's IHDR", () => {
    expect(imageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("reads a baseline JPEG's SOF0", () => {
    expect(imageDimensions(jpeg(3840, 2160))).toEqual({ width: 3840, height: 2160 });
  });

  it("reads a progressive JPEG's SOF2", () => {
    expect(imageDimensions(jpeg(800, 600, { marker: 0xc2 }))).toEqual({ width: 800, height: 600 });
  });

  it("skips APPn/DQT segments to reach the frame header", () => {
    // A real photo puts EXIF and quantisation tables ahead of the frame.
    const before = [
      { marker: 0xe1, length: 2000 },
      { marker: 0xdb, length: 67 },
      { marker: 0xe2, length: 500 },
    ];
    expect(imageDimensions(jpeg(6000, 4000, { before }))).toEqual({ width: 6000, height: 4000 });
  });

  it("does not mistake DHT (0xC4) for a frame header", () => {
    // 0xC4 sits inside the SOFn numeric range but is a Huffman table, so a
    // parser that took the range wholesale would read its payload as a size.
    const before = [{ marker: 0xc4, length: 40 }];
    expect(imageDimensions(jpeg(1280, 720, { before }))).toEqual({ width: 1280, height: 720 });
  });

  it("returns null for a PNG whose first chunk is not IHDR", () => {
    expect(imageDimensions(png(100, 100, { chunkName: "IDAT" }))).toBeNull();
  });

  it("returns null for a JPEG that reaches the scan with no frame header", () => {
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageDimensions(truncated)).toBeNull();
  });

  it("returns null for bytes that are neither PNG nor JPEG", () => {
    expect(imageDimensions(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toBeNull();
  });

  it("reads dimensions out of a subarray, not the whole backing buffer", () => {
    // The upload path hands over a view, and a DataView built on .buffer
    // without the offset would read the wrong bytes.
    const backing = new Uint8Array(64);
    backing.set(png(2560, 1440), 20);
    expect(imageDimensions(backing.subarray(20, 44))).toEqual({ width: 2560, height: 1440 });
  });
});

describe("maxImageEdge", () => {
  it("gives full-page backgrounds room for an 8K wallpaper", () => {
    expect(maxImageEdge("login_bg")).toBe(8192);
    expect(maxImageEdge("main_bg")).toBe(8192);
  });

  it("holds icons to 4096", () => {
    expect(maxImageEdge("favicon_png")).toBe(4096);
    expect(maxImageEdge("toolbar_icon_0")).toBe(4096);
  });
});

describe("isRasterImageKind", () => {
  it("covers the kinds whose pixels are worth capping", () => {
    for (const kind of ["login_bg", "main_bg", "favicon_png", "pwa_icon_192", "pwa_icon_512", "toolbar_icon_11"]) {
      expect(isRasterImageKind(kind)).toBe(true);
    }
  });

  it("leaves out the kinds with no single frame to measure", () => {
    for (const kind of ["logo_svg", "favicon_ico", "font_sans", "font_mono"]) {
      expect(isRasterImageKind(kind)).toBe(false);
    }
  });
});

describe("approveRewritesBytes", () => {
  it("rewrites SVG, because it is a document and can carry script", () => {
    expect(approveRewritesBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
    expect(approveRewritesBytes(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))).toBe(true);
  });

  it("leaves every raster and font byte-for-byte", () => {
    expect(approveRewritesBytes(png(16, 16))).toBe(false);
    expect(approveRewritesBytes(jpeg(16, 16))).toBe(false);
    expect(approveRewritesBytes(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toBe(false);
    expect(approveRewritesBytes(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBe(false);
  });
});

// RIFF container: "RIFF", size, "WEBP", then one bitstream chunk. Which chunk
// it is decides where the dimensions live, so all three are built here.
function webp(fourcc, payload) {
  const body = [...fourcc].map((c) => c.charCodeAt(0));
  const size = payload.length;
  body.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff);
  body.push(...payload);
  const total = 4 + body.length;
  const out = [
    0x52, 0x49, 0x46, 0x46,
    total & 0xff, (total >> 8) & 0xff, (total >> 16) & 0xff, (total >> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50,
  ];
  out.push(...body);
  while (out.length < 30) out.push(0x00);
  return new Uint8Array(out);
}

function webpLossy(width, height) {
  const p = [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a];
  p.push(width & 0xff, (width >> 8) & 0x3f);
  p.push(height & 0xff, (height >> 8) & 0x3f);
  return webp("VP8 ", p);
}

function webpLossless(width, height) {
  const bits = (width - 1) | ((height - 1) << 14);
  return webp("VP8L", [
    0x2f,
    bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff,
  ]);
}

function webpExtended(width, height) {
  const w = width - 1;
  const h = height - 1;
  return webp("VP8X", [
    0x10, 0x00, 0x00, 0x00,
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ]);
}

describe("imageDimensions — WebP", () => {
  it("reads a lossy VP8 frame header", () => {
    expect(imageDimensions(webpLossy(3840, 2160))).toEqual({ width: 3840, height: 2160 });
  });

  it("reads a lossless VP8L header", () => {
    expect(imageDimensions(webpLossless(2560, 1440))).toEqual({ width: 2560, height: 1440 });
  });

  it("reads a VP8X canvas header, the one an alpha or animated file uses", () => {
    expect(imageDimensions(webpExtended(7680, 4320))).toEqual({ width: 7680, height: 4320 });
  });

  it("handles the 16383x16383 ceiling the 14-bit fields impose", () => {
    expect(imageDimensions(webpLossy(16383, 16383))).toEqual({ width: 16383, height: 16383 });
    expect(imageDimensions(webpLossless(16384, 16384))).toEqual({ width: 16384, height: 16384 });
  });

  it("returns null for RIFF bytes that are not WebP at all", () => {
    const wav = new Uint8Array(30);
    wav.set([0x52, 0x49, 0x46, 0x46]);
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(imageDimensions(wav)).toBeNull();
  });

  it("returns null for a lossy chunk with no key-frame sync code", () => {
    const broken = webpLossy(100, 100);
    broken[23] = 0x00; // clobber the 0x9d
    expect(imageDimensions(broken)).toBeNull();
  });
});

describe("WebP is a background format", () => {
  it("sniffs as webp and serves as image/webp", () => {
    expect(sniffBgFormat(webpLossy(1920, 1080))).toBe("webp");
    expect(contentTypeFor("login_bg", "webp")).toBe("image/webp");
    expect(contentTypeFor("main_bg", "webp")).toBe("image/webp");
  });

  it("still serves png and jpeg as themselves, and falls back to png", () => {
    expect(contentTypeFor("login_bg", "png")).toBe("image/png");
    expect(contentTypeFor("login_bg", "jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("login_bg", undefined)).toBe("image/png");
  });

  it("is not rewritten, like every other raster", () => {
    expect(approveRewritesBytes(webpLossy(16, 16))).toBe(false);
  });
});
