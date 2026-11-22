const singleSchemas = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'if',
  'then',
  'else',
  'not',
  'contentSchema',
]);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

/** Represent an impossible enum consistently across JSON Schema consumers. */
export function portableJsonSchema(schema: object): Record<string, unknown>;
export function portableJsonSchema(schema: boolean): boolean;
export function portableJsonSchema(schema: unknown): Record<string, unknown> | boolean;
export function portableJsonSchema(schema: unknown): Record<string, unknown> | boolean {
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid JSON schema.');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'enum' && Array.isArray(value) && value.length === 0) continue;
    if (schemaArrays.has(key) && Array.isArray(value)) result[key] = value.map(portableJsonSchema);
    else if (key === 'items') result[key] = Array.isArray(value) ? value.map(portableJsonSchema) : portableJsonSchema(value);
    else if (singleSchemas.has(key)) result[key] = portableJsonSchema(value);
    else if (schemaMaps.has(key) && value && typeof value === 'object' && !Array.isArray(value))
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, portableJsonSchema(child)]));
    else result[key] = value;
  }
  const enumeration = Reflect.get(schema, 'enum');
  if (Array.isArray(enumeration) && enumeration.length === 0) result.not = {};
  return result;
}
