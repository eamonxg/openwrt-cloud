import { HttpError, requireAdmin } from "./auth.js";
import { logAction } from "./admin-audit.js";
import { jsonResponse, readJsonObject, toErrorResponse } from "./http.js";
import { parsePositiveInt, POLICY_CURRENT } from "./schema-policy.js";
import { THEMES, validateSchemaPolicy } from "./validate.js";

const POLICY_BODY_BYTES = 1024;

async function listSchemas(request, env) {
  requireAdmin(request, env);

  const { results } = await env.DB
    .prepare(
      `SELECT k.theme, k.schema, p.state, p.sunset_at, p.updated_at,
              (SELECT COUNT(*) FROM configs c
                WHERE c.theme = k.theme AND c.schema = k.schema AND c.status = 'active') AS active_configs
         FROM (SELECT theme, schema FROM schema_policies
               UNION
               SELECT theme, schema FROM configs WHERE status = 'active') k
         LEFT JOIN schema_policies p ON p.theme = k.theme AND p.schema = k.schema
        ORDER BY k.theme ASC, k.schema ASC`
    )
    .all();

  const items = results.map((row) => ({
    theme: row.theme,
    schema: row.schema,
    state: row.state ?? POLICY_CURRENT,
    sunset_at: row.sunset_at,
    updated_at: row.updated_at,
    active_configs: row.active_configs,
  }));

  return jsonResponse({ items });
}

async function upsertPolicy(request, env, theme, rawSchema) {
  const actor = requireAdmin(request, env);

  if (!THEMES.includes(theme)) {
    throw new HttpError(404, "unknown_theme", "Unknown theme.");
  }
  const schema = parsePositiveInt(rawSchema);
  if (schema === null) {
    throw new HttpError(400, "bad_request", "schema must be a positive integer.");
  }

  const policy = validateSchemaPolicy(await readJsonObject(request, POLICY_BODY_BYTES));

  await env.DB
    .prepare(
      `INSERT INTO schema_policies (theme, schema, state, sunset_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(theme, schema) DO UPDATE SET
         state = excluded.state, sunset_at = excluded.sunset_at, updated_at = excluded.updated_at`
    )
    .bind(theme, schema, policy.state, policy.sunset_at)
    .run();

  const note = policy.sunset_at ? `${policy.state}, sunset ${policy.sunset_at}` : policy.state;
  await logAction(env, actor, "set_policy", "schema", `${theme}/${schema}`, note);

  return jsonResponse({ theme, schema, ...policy });
}

export async function handleSchemaList(request, env) {
  try {
    return await listSchemas(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleSchemaPolicy(request, env, params) {
  try {
    return await upsertPolicy(request, env, params.theme, params.schema);
  } catch (err) {
    return toErrorResponse(err);
  }
}
