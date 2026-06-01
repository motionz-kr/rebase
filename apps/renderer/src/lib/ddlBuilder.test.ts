import { describe, it, expect } from 'vitest';
import {
  quoteIdent,
  buildAddColumn,
  buildDropColumn,
  buildRenameColumn,
  buildModifyColumn,
  buildDropTable,
  buildRenameTable,
  buildTruncateTable,
  buildTableChanges,
  buildCreateTable,
  type TableChangeSet,
} from './ddlBuilder';

describe('quoteIdent', () => {
  it('quotes mysql identifiers with backticks', () => {
    expect(quoteIdent('mysql', 'users')).toBe('`users`');
  });
  it('quotes postgres identifiers with double quotes', () => {
    expect(quoteIdent('postgres', 'users')).toBe('"users"');
  });
  it('escapes a backtick in a mysql identifier', () => {
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`');
  });
  it('escapes a double quote in a postgres identifier', () => {
    expect(quoteIdent('postgres', 'we"ird')).toBe('"we""ird"');
  });
});

describe('buildAddColumn', () => {
  it('adds a nullable column (mysql)', () => {
    expect(buildAddColumn('mysql', 'users', { name: 'age', type: 'INT', nullable: true })).toEqual([
      'ALTER TABLE `users` ADD COLUMN `age` INT',
    ]);
  });
  it('adds a NOT NULL column with default (postgres)', () => {
    expect(
      buildAddColumn('postgres', 'users', { name: 'status', type: 'text', nullable: false, defaultValue: "'active'" })
    ).toEqual(["ALTER TABLE \"users\" ADD COLUMN \"status\" text NOT NULL DEFAULT 'active'"]);
  });
});

describe('buildDropColumn', () => {
  it('drops a column (mysql)', () => {
    expect(buildDropColumn('mysql', 'users', 'age')).toEqual(['ALTER TABLE `users` DROP COLUMN `age`']);
  });
  it('drops a column (postgres)', () => {
    expect(buildDropColumn('postgres', 'users', 'age')).toEqual(['ALTER TABLE "users" DROP COLUMN "age"']);
  });
});

describe('buildRenameColumn', () => {
  it('renames a column (postgres)', () => {
    expect(buildRenameColumn('postgres', 'users', 'age', 'years')).toEqual([
      'ALTER TABLE "users" RENAME COLUMN "age" TO "years"',
    ]);
  });
  it('renames a column (mysql)', () => {
    expect(buildRenameColumn('mysql', 'users', 'age', 'years')).toEqual([
      'ALTER TABLE `users` RENAME COLUMN `age` TO `years`',
    ]);
  });
});

describe('buildModifyColumn', () => {
  const before = { name: 'age', type: 'INT', nullable: true } as const;

  it('mysql restates the full definition in one MODIFY statement', () => {
    expect(
      buildModifyColumn('mysql', 'users', before, { name: 'age', type: 'BIGINT', nullable: false })
    ).toEqual(['ALTER TABLE `users` MODIFY COLUMN `age` BIGINT NOT NULL']);
  });

  it('mysql returns [] when nothing changed', () => {
    expect(buildModifyColumn('mysql', 'users', before, { ...before })).toEqual([]);
  });

  it('postgres emits one statement per changed attribute', () => {
    expect(
      buildModifyColumn('postgres', 'users', before, {
        name: 'age',
        type: 'bigint',
        nullable: false,
        defaultValue: '0',
      })
    ).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "age" TYPE bigint',
      'ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 0',
    ]);
  });

  it('postgres uses DROP NOT NULL / DROP DEFAULT when clearing', () => {
    expect(
      buildModifyColumn(
        'postgres',
        'users',
        { name: 'age', type: 'int', nullable: false, defaultValue: '0' },
        { name: 'age', type: 'int', nullable: true }
      )
    ).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "age" DROP NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "age" DROP DEFAULT',
    ]);
  });

  it('postgres returns [] when nothing changed', () => {
    expect(buildModifyColumn('postgres', 'users', before, { ...before })).toEqual([]);
  });
});

describe('table-level builders', () => {
  it('drops a table (mysql)', () => {
    expect(buildDropTable('mysql', 'users')).toEqual(['DROP TABLE `users`']);
  });
  it('renames a table (postgres)', () => {
    expect(buildRenameTable('postgres', 'users', 'members')).toEqual([
      'ALTER TABLE "users" RENAME TO "members"',
    ]);
  });
  it('renames a table (mysql) using ALTER ... RENAME TO', () => {
    expect(buildRenameTable('mysql', 'users', 'members')).toEqual([
      'ALTER TABLE `users` RENAME TO `members`',
    ]);
  });
  it('truncates a table (postgres)', () => {
    expect(buildTruncateTable('postgres', 'users')).toEqual(['TRUNCATE TABLE "users"']);
  });
  it('truncates a table (mysql)', () => {
    expect(buildTruncateTable('mysql', 'users')).toEqual(['TRUNCATE TABLE `users`']);
  });
});

describe('buildCreateTable', () => {
  it('mysql: PK + auto-increment', () => {
    expect(
      buildCreateTable('mysql', 't', [
        { name: 'id', type: 'BIGINT', nullable: false, primaryKey: true, autoIncrement: true },
      ])
    ).toEqual(['CREATE TABLE `t` (\n  `id` BIGINT NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n)']);
  });

  it('postgres: PK + auto-increment uses IDENTITY', () => {
    expect(
      buildCreateTable('postgres', 't', [
        { name: 'id', type: 'bigint', nullable: false, primaryKey: true, autoIncrement: true },
      ])
    ).toEqual(['CREATE TABLE "t" (\n  "id" bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,\n  PRIMARY KEY ("id")\n)']);
  });

  it('mysql: unique column + default, no PK → no PRIMARY KEY clause', () => {
    expect(
      buildCreateTable('mysql', 'users', [
        { name: 'email', type: 'VARCHAR(255)', nullable: false, unique: true },
        { name: 'status', type: 'VARCHAR(20)', nullable: true, defaultValue: "'new'" },
      ])
    ).toEqual([
      'CREATE TABLE `users` (\n  `email` VARCHAR(255) NOT NULL UNIQUE,\n  `status` VARCHAR(20) DEFAULT \'new\'\n)',
    ]);
  });

  it('forces NOT NULL on a PK column even if nullable is true', () => {
    expect(
      buildCreateTable('mysql', 't', [{ name: 'id', type: 'INT', nullable: true, primaryKey: true }])
    ).toEqual(['CREATE TABLE `t` (\n  `id` INT NOT NULL,\n  PRIMARY KEY (`id`)\n)']);
  });

  it('composite primary key collects all PK columns', () => {
    expect(
      buildCreateTable('postgres', 'membership', [
        { name: 'user_id', type: 'bigint', nullable: false, primaryKey: true },
        { name: 'group_id', type: 'bigint', nullable: false, primaryKey: true },
      ])
    ).toEqual([
      'CREATE TABLE "membership" (\n  "user_id" bigint NOT NULL,\n  "group_id" bigint NOT NULL,\n  PRIMARY KEY ("user_id", "group_id")\n)',
    ]);
  });

  it('auto-increment column ignores any default value', () => {
    expect(
      buildCreateTable('mysql', 't', [
        { name: 'id', type: 'BIGINT', nullable: false, primaryKey: true, autoIncrement: true, defaultValue: '5' },
      ])
    ).toEqual(['CREATE TABLE `t` (\n  `id` BIGINT NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n)']);
  });

  it('returns [] when there are no valid columns', () => {
    expect(buildCreateTable('mysql', 't', [])).toEqual([]);
    expect(buildCreateTable('mysql', 't', [{ name: '', type: '', nullable: true }])).toEqual([]);
  });
});

describe('buildTableChanges', () => {
  const empty: TableChangeSet = {
    addColumns: [],
    dropColumns: [],
    renameColumns: [],
    modifyColumns: [],
  };

  it('returns [] when there are no changes', () => {
    expect(buildTableChanges('mysql', 'users', empty)).toEqual([]);
  });

  it('postgres flattens a multi-statement modify in order', () => {
    const changes: TableChangeSet = {
      renameTo: 'members',
      dropColumns: ['old'],
      modifyColumns: [
        { before: { name: 'age', type: 'int', nullable: true }, after: { name: 'age', type: 'bigint', nullable: false } },
      ],
      renameColumns: [],
      addColumns: [{ name: 'email', type: 'text', nullable: false }],
    };
    expect(buildTableChanges('postgres', 'users', changes)).toEqual([
      'ALTER TABLE "users" DROP COLUMN "old"',
      'ALTER TABLE "users" ALTER COLUMN "age" TYPE bigint',
      'ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL',
      'ALTER TABLE "users" ADD COLUMN "email" text NOT NULL',
      'ALTER TABLE "users" RENAME TO "members"',
    ]);
  });

  it('orders ops: drop, modify, rename-col, add, rename-table last', () => {
    const changes: TableChangeSet = {
      renameTo: 'members',
      dropColumns: ['old'],
      modifyColumns: [
        { before: { name: 'age', type: 'INT', nullable: true }, after: { name: 'age', type: 'BIGINT', nullable: true } },
      ],
      renameColumns: [{ from: 'nm', to: 'name' }],
      addColumns: [{ name: 'email', type: 'VARCHAR(255)', nullable: false }],
    };
    expect(buildTableChanges('mysql', 'users', changes)).toEqual([
      'ALTER TABLE `users` DROP COLUMN `old`',
      'ALTER TABLE `users` MODIFY COLUMN `age` BIGINT',
      'ALTER TABLE `users` RENAME COLUMN `nm` TO `name`',
      'ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255) NOT NULL',
      'ALTER TABLE `users` RENAME TO `members`',
    ]);
  });
});
