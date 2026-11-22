import { expect, test } from 'bun:test';
import Ajv from 'ajv/dist/2020';
import { dynamicComposeSchemaArk } from '@runtipi/common/schemas/dynamic-compose-ark';
import { dynamicComposeSchemaYaml } from '@runtipi/common/schemas/compose-yaml';
import { portableJsonSchema } from '@runtipi/common/schemas/portable-json-schema';

test('the editor validator still compiles and rejects inline migrations in both source formats', () => {
  const ajv = new Ajv({ allErrors: true });
  ajv.addKeyword('message');
  const legacy = ajv.compile(
    portableJsonSchema(dynamicComposeSchemaArk.omit('schemaVersion').toJsonSchema({ fallback: { default: (ctx) => ctx.base } })),
  );
  const yaml = ajv.compile(portableJsonSchema(dynamicComposeSchemaYaml.toJsonSchema({})));
  const services = [{ name: 'web', image: 'example:latest' }];
  expect(legacy({ services })).toBe(true);
  for (const migrations of [[], [{ id: '001-schema', service: 'migration' }], null, '001-schema']) {
    expect(legacy({ services, migrations })).toBe(false);
    expect(yaml({ services: { web: { image: 'example:latest' } }, 'x-runtipi': { schema_version: 2, migrations } })).toBe(false);
  }
  expect(yaml({ services: { web: { image: 'example:latest' } }, 'x-runtipi': { schema_version: 2 } })).toBe(true);
});

test('schema export preserves user values, does not mutate inputs, and remains idempotent', () => {
  const schema = {
    properties: { forbidden: { enum: [], description: 'Unsupported' }, enum: { type: 'array' } },
    examples: [{ enum: [] }],
    default: { enum: [] },
  };
  const original = structuredClone(schema);
  const normalized = portableJsonSchema(schema);
  expect(schema).toEqual(original);
  expect(normalized).toEqual({
    properties: { forbidden: { not: {}, description: 'Unsupported' }, enum: { type: 'array' } },
    examples: [{ enum: [] }],
    default: { enum: [] },
  });
  expect(portableJsonSchema(normalized)).toEqual(normalized);
});
