import { HttpError } from "./auth.js";
import { jsonResponse, toErrorResponse } from "./http.js";
import { parseClientSchema } from "./schema-policy.js";
import { THEMES, NOTICE_THEME_ANY } from "./validate.js";

const FEED_LIMIT = 20;
const FEED_CACHE_CONTROL = "public, max-age=300";

async function noticesFeed(request, env) {
  const url = new URL(request.url);

  const theme = url.searchParams.get("theme");
  if (!theme) {
    throw new HttpError(400, "bad_request", "theme is required.");
  }
  if (!THEMES.includes(theme)) {
    throw new HttpError(404, "unknown_theme", "Unknown theme.");
  }
  const clientSchema = parseClientSchema(url);

  const { results } = await env.DB
    .prepare(
      `SELECT id, level, audience, title, body, url, i18n, starts_at, expires_at, created_at
         FROM notices
        WHERE theme IN (?, ?)
          AND revoked_at IS NULL
          AND (starts_at IS NULL OR starts_at <= datetime('now'))
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND (min_schema IS NULL OR min_schema <= ?)
          AND (max_schema IS NULL OR max_schema >= ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .bind(theme, NOTICE_THEME_ANY, clientSchema, clientSchema, FEED_LIMIT)
    .all();

  const notices = results.map((row) => ({ ...row, i18n: JSON.parse(row.i18n) }));

  return jsonResponse({ notices }, { headers: { "cache-control": FEED_CACHE_CONTROL } });
}

export async function handleNoticesFeed(request, env) {
  try {
    return await noticesFeed(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}
