// PostgreSQL, rather than SQL string parsing, normalizes the baseline contract.
// Only managed objects are inspected; extension/private tables remain untouched.
export const businessTables = [
  'accounts',
  'audit_events',
  'config_versions',
  'idempotency_records',
  'members',
  'sessions',
  'tasks',
  'teams',
];

// PostgreSQL's deparser distributes a varchar[] -> text[] cast across constant
// elements on dump/restore. Normalize only that exact, equivalent cast; retain
// values, operators, column names and all other type/expression differences.
export function normalizeConstraintDefinition(definition) {
  const literal = "'(?:[^']|'')*'";
  const item = `${literal}::character varying`;
  return definition
    .replace(
      new RegExp(`\\(ARRAY\\[(${item}(?:, ${item})*)\\]\\)::text\\[\\]`, 'g'),
      (_, items) => `ARRAY[${items.replaceAll('::character varying', '::text')}]`,
    )
    .replace(new RegExp(`\\((${literal})::character varying\\)::text`, 'g'), '$1::text');
}

export async function inspectBusinessSchema(client) {
  const result = {};
  for (const name of businessTables) {
    const table = await client.query(
      `SELECT relkind, relrowsecurity, relforcerowsecurity
       FROM pg_class WHERE oid=to_regclass($1)`,
      [`public.${name}`],
    );
    const columns = await client.query(
      `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
         a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default_value,
         a.attidentity AS identity, a.attgenerated AS generated,
         co.collname AS collation
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       LEFT JOIN pg_collation co ON co.oid=a.attcollation
       WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [`public.${name}`],
    );
    const constraints = await client.query(
      `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition,
         condeferrable AS deferrable, condeferred AS deferred, convalidated AS validated
       FROM pg_constraint WHERE conrelid=to_regclass($1) ORDER BY conname`,
      [`public.${name}`],
    );
    const indexes = await client.query(
      `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
         i.indisvalid AS valid, i.indisready AS ready
       FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       WHERE i.indrelid=to_regclass($1) ORDER BY c.relname`,
      [`public.${name}`],
    );
    for (const constraint of constraints.rows)
      if (constraint.type === 'c')
        constraint.definition = normalizeConstraintDefinition(constraint.definition);
    const triggers = await client.query(
      `SELECT tgname AS name, tgenabled AS enabled, pg_get_triggerdef(oid) AS definition
       FROM pg_trigger WHERE tgrelid=to_regclass($1) AND NOT tgisinternal ORDER BY tgname`,
      [`public.${name}`],
    );
    result[name] = {
      table: table.rows[0] ?? null,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      triggers: triggers.rows,
    };
  }
  const functions = await client.query(
    `SELECT p.proname AS name, l.lanname AS language, btrim(p.prosrc) AS source,
       p.prosecdef AS security_definer, p.provolatile AS volatility, p.proconfig AS config,
       pg_get_function_result(p.oid) AS result
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname='public' AND p.proname='set_updated_at' AND p.pronargs=0`,
  );
  return { tables: result, functions: functions.rows };
}

export function firstDifference(expected, actual, path = 'schema') {
  if (Object.is(expected, actual)) return null;
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object'
  )
    return path;
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    const diff = firstDifference(expected[key], actual[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}
