// The guard behind redactReport's REPORT_DATA_FIELDS (R-SE1): which properties of the report's JSON Schema can hold keys that are
// data, and which objects of the schema are not closed. A property holds data keys when its schema reaches the JsonValue
// definition through arrays, unions and references at any depth, or is an object that is not closed (a record). A closed object
// stops the search: its own properties are judged by their own names.
type Node = Record<string, unknown>;

const JSON_VALUE = '#/$defs/JsonValue';
const isNode = (v: unknown): v is Node => v !== null && typeof v === 'object' && !Array.isArray(v);
const isObjectSchema = (n: Node): boolean => n['type'] === 'object' || 'properties' in n || 'additionalProperties' in n || 'propertyNames' in n;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

function holdsData(node: unknown, defs: Node, seen: ReadonlySet<string>): boolean {
  if (!isNode(node)) return false;
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (ref === JSON_VALUE) return true;
    const name = ref.replace(/^#\/\$defs\//, '');
    return !seen.has(name) && holdsData(defs[name], defs, new Set([...seen, name]));
  }
  if (isObjectSchema(node)) return node['additionalProperties'] !== false;
  const children = [...list(node['items']), ...list(node['prefixItems']), ...list(node['anyOf']), ...list(node['oneOf']), ...list(node['allOf'])];
  return children.some((c) => holdsData(c, defs, seen));
}

/** Every node of the schema with its JSON pointer, the JsonValue definition itself left out (it is open by design). */
function nodesOf(schema: unknown): { path: string; node: Node }[] {
  const out: { path: string; node: Node }[] = [];
  const visit = (value: unknown, path: string): void => {
    if (path === JSON_VALUE) return;
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}/${i}`));
    else if (isNode(value)) {
      out.push({ path, node: value });
      for (const [k, v] of Object.entries(value)) visit(v, `${path}/${k}`);
    }
  };
  visit(schema, '#');
  return out;
}

/** The names of the properties whose values can hold data keys, sorted. */
export function openFieldsOf(schema: unknown): string[] {
  const defs = (isNode(schema) && isNode(schema['$defs']) ? schema['$defs'] : {}) as Node;
  const open = new Set<string>();
  for (const { node } of nodesOf(schema)) {
    for (const [name, sub] of Object.entries(isNode(node['properties']) ? node['properties'] : {})) if (holdsData(sub, defs, new Set())) open.add(name);
  }
  return [...open].sort();
}

/** The JSON pointers of the objects (other than JsonValue) that accept properties they do not name. */
export function unclosedObjectsOf(schema: unknown): string[] {
  return nodesOf(schema)
    .filter(({ path, node }) => !/\/(properties|\$defs)$/.test(path) && isObjectSchema(node) && node['additionalProperties'] !== false)
    .map(({ path }) => path);
}
