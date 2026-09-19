import { HttpError, requireAdmin } from "./auth.js";
import { logAction } from "./admin-audit.js";
import { shortId } from "./ids.js";
import { jsonResponse, readJsonObject, toErrorResponse } from "./http.js";
import { validateNotice } from "./validate.js";

const NOTICE_PAGE_SIZE = 50;
const NOTICE_BODY_BYTES = 32 * 1024;

function parsePage(url) {
  const n = Number(url.searchParams.get("page"));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

async function listNotices(request, env) {
  requireAdmin(request, env);

  const page = parsePage(new URL(request.url));
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM notices").first();

  // `status` mirrors the public feed's predicates one for one, so the console
  // can never label a notice active while the feed withholds it.
  const { results } = await env.DB
    .prepare(
      `SELECT id, theme, level, audience, title, body, url, i18n, min_schema, max_schema,
              starts_at, expires_at, created_at, revoked_at,
              CASE
                WHEN revoked_at IS NOT NULL THEN 'revoked'
                WHEN starts_at IS NOT NULL AND starts_at > datetime('now') THEN 'scheduled'
                WHEN expires_at IS NOT NULL AND expires_at <= datetime('now') THEN 'expired'
                ELSE 'active'
              END AS status
         FROM notices
        ORDER BY created_at DESC, rowid DESC
        LIMIT ? OFFSET ?`
    )
    .bind(NOTICE_PAGE_SIZE, (page - 1) * NOTICE_PAGE_SIZE)
    .all();

  const items = results.map((row) => ({ ...row, i18n: JSON.parse(row.i18n) }));

  return jsonResponse({ items, page, page_size: NOTICE_PAGE_SIZE, total: totalRow.n });
}

async function createNotice(request, env) {
  const actor = requireAdmin(request, env);

  const notice = validateNotice(await readJsonObject(request, NOTICE_BODY_BYTES));
  const id = shortId();

  await env.DB
    .prepare(
      `INSERT INTO notices
         (id, theme, level, audience, title, body, url, i18n, min_schema, max_schema, starts_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      notice.theme,
      notice.level,
      notice.audience,
      notice.title,
      notice.body,
      notice.url,
      JSON.stringify(notice.i18n),
      notice.min_schema,
      notice.max_schema,
      notice.starts_at,
      notice.expires_at
    )
    .run();

  await logAction(env, actor, "create", "notice", id, `${notice.level}/${notice.audience}: ${notice.title}`);

  return jsonResponse({ id, created: true });
}

async function revokeNotice(request, env, id) {
  const actor = requireAdmin(request, env);

  const row = await env.DB.prepare("SELECT revoked_at FROM notices WHERE id = ?").bind(id).first();
  if (!row) {
    throw new HttpError(404, "not_found", "Notice not found.");
  }
  if (row.revoked_at) {
    return jsonResponse({ id, revoked: true });
  }

  await env.DB.prepare("UPDATE notices SET revoked_at = datetime('now') WHERE id = ?").bind(id).run();
  await logAction(env, actor, "revoke", "notice", id);

  return jsonResponse({ id, revoked: true });
}

export async function handleNoticeList(request, env) {
  try {
    return await listNotices(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleNoticeCreate(request, env) {
  try {
    return await createNotice(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleNoticeRevoke(request, env, params) {
  try {
    return await revokeNotice(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}
