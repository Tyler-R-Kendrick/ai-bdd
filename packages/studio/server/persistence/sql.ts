type Token = {
  text: string;
  kind: 'word' | 'space' | 'literal' | 'punctuation';
};
function tokens(sql: string): Token[] {
  const result: Token[] = [];
  for (let at = 0; at < sql.length; ) {
    const start = at,
      character = sql[at]!;
    if (/\s/.test(character)) {
      while (at < sql.length && /\s/.test(sql[at]!)) at++;
      result.push({ text: sql.slice(start, at), kind: 'space' });
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      at++;
      while (at < sql.length) {
        if (sql[at++] === character) {
          if (sql[at] === character) at++;
          else break;
        }
      }
      result.push({ text: sql.slice(start, at), kind: 'literal' });
      continue;
    }
    if (sql.startsWith('--', at)) {
      at = sql.indexOf('\n', at);
      if (at < 0) at = sql.length;
      result.push({ text: sql.slice(start, at), kind: 'space' });
      continue;
    }
    if (sql.startsWith('/*', at)) {
      let depth = 1;
      at += 2;
      while (at < sql.length && depth) {
        if (sql.startsWith('/*', at)) {
          depth++;
          at += 2;
        } else if (sql.startsWith('*/', at)) {
          depth--;
          at += 2;
        } else at++;
      }
      result.push({ text: sql.slice(start, at), kind: 'space' });
      continue;
    }
    const delimiter =
      character === '$'
        ? /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(at))?.[0]
        : undefined;
    if (delimiter) {
      const end = sql.indexOf(delimiter, at + delimiter.length);
      at = end < 0 ? sql.length : end + delimiter.length;
      result.push({ text: sql.slice(start, at), kind: 'literal' });
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(sql.slice(at));
    if (word) {
      at += word[0].length;
      result.push({ text: word[0], kind: 'word' });
      continue;
    }
    result.push({ text: character, kind: 'punctuation' });
    at++;
  }
  return result;
}
const significant = (list: Token[]) =>
  list
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.kind !== 'space');
/** SQLite-shaped placeholders and ordering are translated without touching SQL literals/comments. */
export function postgresQuery(
  sql: string,
  positionalColumns: ReadonlyMap<string, string[]> = new Map(),
) {
  const list = tokens(sql),
    significantTokens = significant(list);
  let parameter = 0;
  for (const token of list) {
    if (token.kind === 'punctuation' && token.text === '?')
      token.text = '$' + ++parameter;
    if (token.kind === 'word' && token.text.toLowerCase() === 'rowid')
      token.text = 'ordinal';
  }
  for (let i = 0; i < significantTokens.length - 3; i++) {
    const sequence = significantTokens.slice(i, i + 4);
    if (
      sequence[0]!.token.text.toUpperCase() === 'INSERT' &&
      sequence[1]!.token.text.toUpperCase() === 'INTO' &&
      sequence[2]!.token.kind === 'word' &&
      sequence[3]!.token.text.toUpperCase() === 'VALUES'
    ) {
      const columns = positionalColumns.get(
        sequence[2]!.token.text.toLowerCase(),
      );
      if (columns)
        sequence[2]!.token.text +=
          '(' + columns.map((column) => '"' + column + '"').join(',') + ')';
    }
  }
  return list.map((token) => token.text).join('');
}
/** Register original columns and give every application table a stable, monotonic export ordinal. */
export function postgresSchema(
  sql: string,
  positionalColumns: Map<string, string[]>,
) {
  const list = tokens(sql),
    values = significant(list),
    additions = new Map<number, string>();
  for (let at = 0; at < values.length; at++) {
    if (
      values[at]!.token.text.toUpperCase() !== 'CREATE' ||
      values[at + 1]?.token.text.toUpperCase() !== 'TABLE'
    )
      continue;
    let next = at + 2;
    if (values[next]?.token.text.toUpperCase() === 'IF') next += 3;
    const name = values[next]?.token;
    if (name?.kind !== 'word' || values[next + 1]?.token.text !== '(') continue;
    const columns: string[] = [],
      open = next + 1;
    let depth = 0,
      expectColumn = true,
      end = open;
    for (let cursor = open + 1; cursor < values.length; cursor++) {
      const token = values[cursor]!.token;
      if (token.text === ')' && depth === 0) {
        end = cursor;
        break;
      }
      if (expectColumn && depth === 0) {
        if (
          token.kind === 'word' &&
          !['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT'].includes(
            token.text.toUpperCase(),
          )
        )
          columns.push(token.text);
        expectColumn = false;
      }
      if (token.text === '(') depth++;
      if (token.text === ')') depth--;
      if (token.text === ',' && depth === 0) expectColumn = true;
    }
    if (end === open)
      throw new Error('Unterminated application table definition');
    positionalColumns.set(
      name.text.toLowerCase(),
      columns.filter((column) => column.toLowerCase() !== 'ordinal'),
    );
    if (!columns.some((column) => column.toLowerCase() === 'ordinal'))
      additions.set(values[end]!.index, ', ordinal BIGSERIAL UNIQUE NOT NULL');
  }
  for (let at = 0; at < values.length; at++) {
    const token = values[at]!.token;
    if (token.kind === 'word' && token.text.toUpperCase() === 'BLOB')
      token.text = 'BYTEA';
    if (token.kind === 'word' && token.text.toUpperCase() === 'INTEGER')
      token.text =
        values[at + 1]?.token.text.toUpperCase() === 'PRIMARY' &&
        values[at + 2]?.token.text.toUpperCase() === 'KEY'
          ? 'BIGSERIAL'
          : 'BIGINT';
  }
  return list
    .map((token, index) => (additions.get(index) ?? '') + token.text)
    .join('');
}
export function normalizePostgresRow(
  row: Record<string, unknown>,
  sql: string,
  fields: readonly { name: string; dataTypeID: number }[],
) {
  const aliases = new Map(
    [...sql.matchAll(/\bAS\s+([A-Za-z_]\w*)/gi)].map((match) => [
      match[1]!.toLowerCase(),
      match[1]!,
    ]),
  );
  const integerFields = new Set(
    fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name),
  );
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (integerFields.has(key) && typeof value === 'string') {
        const numeric = Number(value);
        if (!Number.isSafeInteger(numeric))
          throw new Error('Database integer exceeds the safe JSON range');
        value = numeric;
      }
      return [aliases.get(key) ?? key, value];
    }),
  );
}
