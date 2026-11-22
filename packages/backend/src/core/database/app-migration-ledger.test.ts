import path from 'node:path';
import fs from 'node:fs';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { expect, it, vi } from 'vitest';

vi.unmock('node:fs');
vi.unmock('fs');

const directory = path.join(import.meta.dirname, 'drizzle');

it('keeps the reset receipt and does not repeat earlier schema changes when upgrading', () => {
  const { entries } = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8'));
  const migrations = readMigrationFiles({ migrationsFolder: directory });
  const [receipt, ledger, commit] = migrations.slice(-3);
  expect(entries.at(-3)?.tag).toBe('0032_orbis_reset_receipt');
  expect(entries.at(-2)?.tag).toBe('0033_app_migration_ledger');
  expect(entries.at(-1)?.tag).toBe('0034_app_migration_commit');
  if (!receipt || !ledger) throw new Error('Missing required migration files');
  expect(ledger.folderMillis).toBeGreaterThan(receipt.folderMillis);
  expect(receipt.sql.join('')).toContain('CREATE TABLE "orbis_reset_receipt"');
  expect(ledger.sql.join('')).toContain('CREATE TABLE "app_migration"');
  expect(ledger.sql.join('')).toContain('ON DELETE cascade');
  expect(ledger.sql.join('')).not.toMatch(/orbis_reset_receipt|template_urn|last_template_sync_at|template_version/);
  if (!commit) throw new Error('Missing app migration commit receipt');
  expect(commit.folderMillis).toBeGreaterThan(ledger.folderMillis);
  expect(commit.sql.join('')).toContain('CREATE TABLE "app_migration_commit"');
  expect(commit.sql.join('')).not.toMatch(/ALTER|DROP|app_migration"|orbis_reset_receipt|CASCADE/);
});
