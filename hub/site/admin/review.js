import { sanitizeSvg } from "./sanitize-svg.js";
import { apiFetch, el } from "./app.js";

// -----------------------------------------------------------------------------
// Bytes <-> base64
// -----------------------------------------------------------------------------

export function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// -----------------------------------------------------------------------------
// Per-kind sanitation
// -----------------------------------------------------------------------------

// Raster kinds are never rewritten -- the sharer's bytes are the bytes the
// store keeps (src/assets.js, approveRewritesBytes). They are still decoded
// here, but only to answer the two questions a reviewer needs answered: does
// it render, and what is it a picture of. The decoded bitmap is thrown away
// and the original bytes go to approve untouched.
//
// favicon_ico is left out because createImageBitmap support for ICO is not
// something to bet an un-approvable asset on; it gets a plain <img> preview
// like it always has.
const RENDER_CHECK_KINDS = new Set(["favicon_png", "pwa_icon_192", "pwa_icon_512", "login_bg", "main_bg"]);

// A toolbar shortcut icon is SVG or PNG depending on what its author uploaded,
// so its sanitizer is picked from the bytes rather than from the kind: running
// an SVG through the canvas would rasterize it (and the approve endpoint's
// magic check would then still pass, so nothing downstream would notice), and
// running a PNG through sanitizeSvg would produce garbage.
//
// The Content-Type comes from the customMetadata format the share/update flow
// sniffed and stored, which is exactly the format approve re-sniffs from
// whatever this function returns.
const isToolbarIconKind = (kind) => /^toolbar_icon_(?:[0-9]|1[01])$/.test(kind);

function looksLikeSvg(bytes, contentType) {
  if (contentType && contentType.indexOf("svg") !== -1) return true;
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^\s+/, "");
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

export async function fetchPendingAsset(configId, kind) {
  const res = await apiFetch(
    "/api/v1/admin/assets/" + encodeURIComponent(configId) + "/" + encodeURIComponent(kind)
  );
  if (!res.ok) {
    throw new Error("Failed to fetch raw asset bytes (" + res.status + ").");
  }
  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType };
}

// Fetches an already-approved kind's live bytes purely for preview (mixed
// approved+pending configs, final-review Finding 1) — no sanitization runs
// on it, and it is never included in the approve POST body. #10 falls back
// to serving the approved/ bytes for a kind whose row is already
// 'approved' (its pending/ object was deleted the moment it was first
// approved), so the same fetchPendingAsset call works for both cases.
// Never throws — a failed preview fetch is shown inline, it never blocks
// Approve (only the pending kinds gate that button).
export async function fetchApprovedPreview(configId, kind) {
  try {
    const fetched = await fetchPendingAsset(configId, kind);
    return { ok: true, bytes: fetched.bytes, contentType: fetched.contentType };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

let fontSampleCounter = 0;

export function renderAlreadyApprovedPreview(tile, kind, result) {
  const preview = el("div", { class: "preview" });
  tile.appendChild(preview);

  if (!result.ok) {
    const stateLine = el("div", { class: "state-error", text: "already approved (preview failed: " + result.message + ")" });
    tile.appendChild(stateLine);
    return;
  }

  const stateLine = el("div", { class: "state-ok", text: "already approved" });
  tile.appendChild(stateLine);

  const blob = new Blob([result.bytes], { type: result.contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  if (result.contentType && result.contentType.indexOf("font/") === 0) {
    fontSampleCounter += 1;
    const family = "admin-preview-font-" + fontSampleCounter;
    const sample = el("div", { class: "font-sample", text: "Aa 123" });
    preview.appendChild(sample);
    const face = new FontFace(family, "url(" + url + ")");
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        sample.style.fontFamily = family;
      })
      .catch(() => {});
  } else {
    const img = el("img", { src: url, alt: kind });
    preview.appendChild(img);
  }
}

// Returns { ok: true, rewritten, bytes, blob, previewKind, dimensions? } or
// { ok: false, message }. `rewritten` is the console's half of the approve
// contract: true means these are sanitized bytes that must be posted back,
// false means the stored bytes stand as they are and approve copies them
// server-side. Approve re-derives the same answer from the pending object and
// rejects any disagreement, so the two cannot drift.
//
// Never throws — every failure path here is one the caller surfaces on the
// card and uses to disable "Approve".
export async function sanitizeAsset(configId, kind) {
  let fetched;
  try {
    fetched = await fetchPendingAsset(configId, kind);
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
  const { bytes, contentType } = fetched;
  const svgIcon = isToolbarIconKind(kind) && looksLikeSvg(bytes, contentType);

  // SVG is the only format that gets rewritten, because it is the only one
  // that is a document rather than a picture: it can carry script, external
  // references and CSS, and sanitizeSvg is what takes them away.
  if (kind === "logo_svg" || svgIcon) {
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const sanitized = sanitizeSvg(text);
      const outBytes = new TextEncoder().encode(sanitized);
      const blob = new Blob([outBytes], { type: "image/svg+xml" });
      return { ok: true, rewritten: true, bytes: outBytes, blob, previewKind: "svg" };
    } catch (err) {
      return { ok: false, message: "SVG sanitize failed: " + (err.message || err) };
    }
  }

  const storedBlob = new Blob([bytes], { type: contentType || "application/octet-stream" });

  // A raster is decoded but not rewritten. Approving means "I looked at these
  // bytes", and a picture that will not render is one nobody looked at — so
  // a failed decode still blocks the button, it just no longer costs the
  // sharer their image quality to find out.
  if (RENDER_CHECK_KINDS.has(kind) || isToolbarIconKind(kind)) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(storedBlob);
    } catch (err) {
      return { ok: false, message: "Not a decodable image." };
    }
    // Read the dimensions BEFORE close(): a closed ImageBitmap reports 0x0,
    // which used to turn every oversized wallpaper into a baffling "(0x0)".
    const dimensions = bitmap.width + "x" + bitmap.height;
    bitmap.close();
    return { ok: true, rewritten: false, bytes, blob: storedBlob, previewKind: "image", dimensions };
  }

  // favicon_ico and the woff2 fonts: no decode step to offer. The ICO magic
  // bytes were checked at upload and are re-checked at approve; a font is
  // shown as rendered text rather than as a picture.
  return {
    ok: true,
    rewritten: false,
    bytes,
    blob: storedBlob,
    previewKind: kind === "favicon_ico" ? "image" : "font",
  };
}

export function renderAssetPreview(tile, kind, result) {
  const preview = el("div", { class: "preview" });
  const stateLine = el("div");
  tile.appendChild(preview);
  tile.appendChild(stateLine);

  if (!result.ok) {
    stateLine.className = "state-error";
    stateLine.textContent = result.message;
    return;
  }

  stateLine.className = "state-ok";
  // The reviewer needs to know which of the two things they are looking at:
  // bytes this console rewrote, or the sharer's own bytes about to be stored
  // verbatim.
  const detail = result.bytes.length + " bytes" +
    (result.dimensions ? ", " + result.dimensions : "");
  stateLine.textContent = result.rewritten
    ? "sanitized ok (" + detail + ")"
    : "stored as uploaded (" + detail + ")";

  const url = URL.createObjectURL(result.blob);
  if (result.previewKind === "svg" || result.previewKind === "image") {
    const img = el("img", { src: url, alt: kind });
    preview.appendChild(img);
  } else if (result.previewKind === "font") {
    fontSampleCounter += 1;
    const family = "admin-preview-font-" + fontSampleCounter;
    const sample = el("div", { class: "font-sample", text: "Aa 123" });
    preview.appendChild(sample);
    const face = new FontFace(family, "url(" + url + ")");
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        sample.style.fontFamily = family;
      })
      .catch(() => {
        stateLine.className = "state-error";
        stateLine.textContent = "sanitized, but font failed to render for preview.";
      });
  }
}
