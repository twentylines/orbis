import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias, integer, PgDialect, pgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL identifier escaping', () => {
  const input = 'value"; DROP TABLE users; --';
  const quoted = '"value""; DROP TABLE users; --"';

  it('keeps embedded quotes inside an identifier', () => {
    const query = new PgDialect().sqlToQuery(sql`select ${sql.identifier(input)}`);
    expect(query.sql).toBe(`select ${quoted}`);
    expect(query.params).toEqual([]);
  });

  it('keeps an alias inside its quoted token', () => {
    const table = pgTable('identifier_probe', { id: integer() });
    const renamed = alias(table, input);
    const query = drizzle.mock().select().from(renamed).toSQL();
    expect(query.sql).toContain(`from "identifier_probe" ${quoted}`);
  });
});
