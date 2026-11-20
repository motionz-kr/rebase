import { describe, expect, it } from 'vitest';
import { abortedCommitNotice, impliesMysqlCommit, isMysqlDeadlock, applyStatementToPending, commitNotice, EMPTY_TALLY, rollbackNotice, transactionControlKind, type PendingTally } from './pendingAffected';

const stmt = (sql: string, over: Partial<Parameters<typeof applyStatementToPending>[1]> = {}) => ({
  sql, hasColumns: false, rowsAffected: 0, error: null as string | null, transactionStateAfter: 'active', ...over,
});
const t = (pending: number, savepoints: PendingTally['savepoints'] = []): PendingTally => ({ pending, savepoints });

describe('transactionControlKind', () => {
  it('classifies begin / commit / rollback forms', () => {
    expect(transactionControlKind('START TRANSACTION')).toBe('begin');
    expect(transactionControlKind('-- c\nbegin')).toBe('begin');
    expect(transactionControlKind('COMMIT')).toBe('commit');
    expect(transactionControlKind('end')).toBe('commit');
    expect(transactionControlKind('ROLLBACK')).toBe('rollback');
    expect(transactionControlKind('abort')).toBe('rollback');
  });
  it('does not treat savepoint rollback as ending the transaction', () => {
    expect(transactionControlKind('ROLLBACK TO SAVEPOINT a')).toBeNull();
    expect(transactionControlKind('ROLLBACK TO a')).toBeNull();
    expect(transactionControlKind('SELECT 1')).toBeNull();
  });
});

describe('applyStatementToPending', () => {
  it('adds write rows while the transaction stays open', () => {
    expect(applyStatementToPending(EMPTY_TALLY, stmt('UPDATE t SET a = 1', { rowsAffected: 116 })).tally).toEqual(t(116));
    expect(applyStatementToPending(t(116), stmt('DELETE FROM t', { rowsAffected: 4 })).tally).toEqual(t(120));
  });
  it('counts writes that also return rows (RETURNING / OUTPUT) by their reported count', () => {
    expect(applyStatementToPending(EMPTY_TALLY, stmt('UPDATE t SET a = 1 RETURNING id', { hasColumns: true, rowsAffected: 3 })).tally).toEqual(t(3));
    expect(applyStatementToPending(t(1), stmt('INSERT INTO t VALUES (1) OUTPUT inserted.id', { hasColumns: true, rowsAffected: 1 })).tally).toEqual(t(2));
  });
  it('ignores reads, begin, failures and writes outside a transaction', () => {
    expect(applyStatementToPending(t(5), stmt('SELECT 1', { hasColumns: true, rowsAffected: 1 })).tally).toEqual(t(5));
    expect(applyStatementToPending(EMPTY_TALLY, stmt('START TRANSACTION')).tally).toEqual(EMPTY_TALLY);
    expect(applyStatementToPending(t(5), stmt('UPDATE t SET a = 1', { rowsAffected: 9, error: 'boom' })).tally).toEqual(t(5));
    expect(applyStatementToPending(EMPTY_TALLY, stmt('UPDATE t SET a = 1', { rowsAffected: 9, transactionStateAfter: 'idle' })).tally).toEqual(EMPTY_TALLY);
  });
  it('turns COMMIT / ROLLBACK into an outcome carrying the tally and resets it', () => {
    expect(applyStatementToPending(t(116), stmt('COMMIT', { transactionStateAfter: 'idle' }))).toEqual({ tally: EMPTY_TALLY, outcome: { kind: 'commit', affected: 116 } });
    expect(applyStatementToPending(t(116), stmt('rollback', { transactionStateAfter: 'idle' }))).toEqual({ tally: EMPTY_TALLY, outcome: { kind: 'rollback', affected: 116 } });
  });
  it('keeps the tally when COMMIT failed', () => {
    expect(applyStatementToPending(t(7), stmt('COMMIT', { error: 'x', transactionStateAfter: 'failed' })).tally).toEqual(t(7));
  });
  it('resets when the session ended up idle or lost', () => {
    expect(applyStatementToPending(t(7), stmt('SELECT 1', { hasColumns: true, transactionStateAfter: 'idle' })).tally).toEqual(EMPTY_TALLY);
    expect(applyStatementToPending(t(7), stmt('SELECT 1', { hasColumns: true, transactionStateAfter: 'lost' })).tally).toEqual(EMPTY_TALLY);
  });
});

describe('non-DML statements', () => {
  it('never add to the tally, even when the driver reports a stale count', () => {
    expect(applyStatementToPending(t(1), stmt('CREATE TABLE t (a int)', { rowsAffected: 3 })).tally).toEqual(t(1));
    expect(applyStatementToPending(t(1), stmt('SET @a = 1', { rowsAffected: 1 })).tally).toEqual(t(1));
  });
});

describe('savepoints', () => {
  it('ROLLBACK TO restores the tally taken at SAVEPOINT and keeps the transaction open', () => {
    let tally = t(2);
    tally = applyStatementToPending(tally, stmt('SAVEPOINT s')).tally;
    tally = applyStatementToPending(tally, stmt('UPDATE t SET a = 1', { rowsAffected: 1 })).tally;
    expect(tally.pending).toBe(3);
    tally = applyStatementToPending(tally, stmt('ROLLBACK TO SAVEPOINT s')).tally;
    expect(tally.pending).toBe(2);
    // The savepoint survives ROLLBACK TO, so it can be rolled back to again.
    tally = applyStatementToPending(tally, stmt('DELETE FROM t', { rowsAffected: 4 })).tally;
    tally = applyStatementToPending(tally, stmt('rollback to s;')).tally;
    expect(tally.pending).toBe(2);
    const done = applyStatementToPending(tally, stmt('COMMIT', { transactionStateAfter: 'idle' }));
    expect(done.outcome).toEqual({ kind: 'commit', affected: 2 });
  });
  it('drops later savepoints on ROLLBACK TO and the savepoint itself on RELEASE', () => {
    let tally = applyStatementToPending(EMPTY_TALLY, stmt('SAVEPOINT a')).tally;
    tally = applyStatementToPending({ ...tally, pending: 1 }, stmt('SAVEPOINT b')).tally;
    expect(tally.savepoints.map((m) => m.name)).toEqual(['a', 'b']);
    expect(applyStatementToPending(tally, stmt('ROLLBACK TO a')).tally.savepoints.map((m) => m.name)).toEqual(['a']);
    const released = applyStatementToPending(tally, stmt('RELEASE SAVEPOINT a')).tally;
    expect(released.savepoints).toEqual([]);
    expect(released.pending).toBe(1);
  });
  it('treats names case-insensitively and ignores unknown savepoints', () => {
    const tally = applyStatementToPending(t(1), stmt('SAVEPOINT Sp1')).tally;
    expect(applyStatementToPending({ ...tally, pending: 5 }, stmt('ROLLBACK TO sp1')).tally.pending).toBe(1);
    expect(applyStatementToPending(t(5), stmt('ROLLBACK TO nope')).tally).toEqual(t(5));
  });
  it('a RELEASE that ends SQLite\'s outermost savepoint (state idle) clears the tally', () => {
    expect(applyStatementToPending(t(1, [{ name: 'a', total: 0 }]), stmt('RELEASE a', { transactionStateAfter: 'idle' })).tally).toEqual(EMPTY_TALLY);
  });
});

describe('MySQL implicit commits', () => {
  it('START TRANSACTION / BEGIN inside an open transaction commits it on MySQL only', () => {
    expect(applyStatementToPending(t(3), stmt('START TRANSACTION'), { driver: 'mysql' }).tally).toEqual(EMPTY_TALLY);
    expect(applyStatementToPending(t(3), stmt('BEGIN')).tally).toEqual(t(3));
  });
  it('DDL is covered by the engine reporting idle after the implicit commit', () => {
    expect(applyStatementToPending(t(3), stmt('ALTER TABLE t ADD c int', { transactionStateAfter: 'idle' }), { driver: 'mysql' }).tally).toEqual(EMPTY_TALLY);
  });
});

describe('notices', () => {
  it('describes what the commit made permanent and the rollback cancelled', () => {
    expect(commitNotice(116)).toBe('커밋 완료 · 이 트랜잭션에서 116행 반영');
    expect(rollbackNotice(116)).toBe('롤백 완료 · 116행 변경 취소');
    expect(commitNotice(1234)).toBe('커밋 완료 · 이 트랜잭션에서 1,234행 반영');
  });
});

describe('transaction control classification from tokens', () => {
  it('sees through comments and optional WORK / TRANSACTION / SAVEPOINT keywords', () => {
    expect(transactionControlKind('ROLLBACK /* note */ TO s')).toBeNull();
    expect(transactionControlKind('ROLLBACK TRANSACTION TO s')).toBeNull();
    expect(transactionControlKind('ROLLBACK WORK TO SAVEPOINT s')).toBeNull();
    expect(transactionControlKind('ROLLBACK TRANSACTION')).toBe('rollback');
    expect(transactionControlKind('/* c */ ROLLBACK -- x\n AND CHAIN')).toBe('rollback');
    expect(transactionControlKind('COMMIT /* done */')).toBe('commit');
  });
  it('parses savepoint names behind comments, keywords and quotes', () => {
    let tally = applyStatementToPending(t(1), stmt('SAVEPOINT "Sp"')).tally;
    tally = { ...tally, pending: 5 };
    expect(applyStatementToPending(tally, stmt('ROLLBACK /* x */ WORK TO SAVEPOINT "Sp"')).tally.pending).toBe(1);
  });
});

describe('savepoint semantics per driver', () => {
  const run = (sqls: Array<[string, number?]>, mysql: boolean) => {
    let tally = EMPTY_TALLY;
    for (const [sql, n] of sqls) tally = applyStatementToPending(tally, stmt(sql, { rowsAffected: n ?? 0 }), { driver: mysql ? 'mysql' : 'postgres' }).tally;
    return tally;
  };
  it('MySQL: RELEASE removes only the named savepoint, later ones stay', () => {
    const tally = run([['SAVEPOINT a'], ['UPDATE t SET v=1', 1], ['SAVEPOINT b'], ['UPDATE t SET v=1', 1], ['RELEASE SAVEPOINT a'], ['ROLLBACK TO b']], true);
    expect(tally.pending).toBe(1);
  });
  it('MySQL: re-using a name replaces the old savepoint', () => {
    const tally = run([['SAVEPOINT a'], ['UPDATE t SET v=1', 1], ['SAVEPOINT a'], ['UPDATE t SET v=1', 1], ['ROLLBACK TO a']], true);
    expect(tally.pending).toBe(1);
    expect(tally.savepoints).toHaveLength(1);
  });
  it('PostgreSQL/SQLite: duplicate names stack and RELEASE destroys the savepoint and later ones', () => {
    const tally = run([['BEGIN'], ['SAVEPOINT s'], ['UPDATE t SET v=1', 1], ['SAVEPOINT s'], ['UPDATE t SET v=1', 1], ['RELEASE s'], ['ROLLBACK TO s']], false);
    expect(tally.pending).toBe(0);
  });
  it('PostgreSQL: ROLLBACK TO uses the most recent savepoint of that name', () => {
    const tally = run([['BEGIN'], ['SAVEPOINT s'], ['UPDATE t SET v=1', 1], ['SAVEPOINT s'], ['UPDATE t SET v=1', 1], ['ROLLBACK TO s']], false);
    expect(tally.pending).toBe(1);
  });
});

describe('COMMIT in an aborted transaction', () => {
  it('is a rollback on PostgreSQL when the transaction was failed before it', () => {
    const r = applyStatementToPending(t(1), stmt('COMMIT', { transactionStateAfter: 'idle' }), { driver: 'postgres', transactionStateBefore: 'failed' });
    expect(r.outcome).toEqual({ kind: 'rollback', affected: 1, aborted: true });
    expect(r.tally).toEqual(EMPTY_TALLY);
  });
  it('stays a commit on MySQL (statement errors do not abort the transaction) and when active', () => {
    expect(applyStatementToPending(t(1), stmt('COMMIT', { transactionStateAfter: 'idle' }), { driver: 'mysql', transactionStateBefore: 'failed' }).outcome).toEqual({ kind: 'commit', affected: 1 });
    expect(applyStatementToPending(t(1), stmt('COMMIT', { transactionStateAfter: 'idle' }), { driver: 'postgres', transactionStateBefore: 'active' }).outcome).toEqual({ kind: 'commit', affected: 1 });
  });
  it('words the aborted commit as a rollback', () => {
    expect(abortedCommitNotice(1)).toBe('트랜잭션 오류 상태라 롤백됨 · 1행 변경 취소');
  });
});

describe('truncated writes', () => {
  it('turn the tally into a lower bound that the notices spell out', () => {
    const r = applyStatementToPending(EMPTY_TALLY, stmt('UPDATE t SET a=1 RETURNING id', { hasColumns: true, rowsAffected: 1000, truncated: true }));
    expect(r.tally).toMatchObject({ pending: 1000, lowerBound: true });
    const done = applyStatementToPending(r.tally, stmt('COMMIT', { transactionStateAfter: 'idle' }));
    expect(done.outcome).toEqual({ kind: 'commit', affected: 1000, lowerBound: true });
    expect(commitNotice(1000, true)).toBe('커밋 완료 · 이 트랜잭션에서 1,000행 이상 반영');
    expect(rollbackNotice(1000, true)).toBe('롤백 완료 · 1,000행 이상 변경 취소');
  });
});

describe('SQLite really commits after a statement error', () => {
  it('keeps a plain commit outcome (only postgres turns it into a rollback)', () => {
    const r = applyStatementToPending(t(1), stmt('COMMIT', { transactionStateAfter: 'idle' }), { driver: 'sqlite', transactionStateBefore: 'failed' });
    expect(r.outcome).toEqual({ kind: 'commit', affected: 1 });
    expect(applyStatementToPending(t(1), stmt('COMMIT', { transactionStateAfter: 'idle' }), { transactionStateBefore: 'failed' }).outcome?.kind).toBe('commit');
  });
});

describe('MySQL errors that already ended the transaction', () => {
  const failed = (sql: string, error: string) => stmt(sql, { error, transactionStateAfter: 'failed' });
  it('a failed DDL still committed the pending work first', () => {
    const tally = { pending: 10, savepoints: [{ name: 'a', total: 3 }] };
    expect(applyStatementToPending(tally, failed('ALTER TABLE t ADD c int', 'Error 1060: Duplicate column'), { driver: 'mysql' }).tally).toEqual(EMPTY_TALLY);
    expect(applyStatementToPending(tally, failed('START TRANSACTION', 'boom'), { driver: 'mysql' }).tally).toEqual(EMPTY_TALLY);
    expect(applyStatementToPending(tally, failed('CREATE INDEX i ON t (a)', 'boom'), { driver: 'mysql' }).tally).toEqual(EMPTY_TALLY);
  });
  it('keeps the tally for ordinary failures, temporary tables, other drivers and lock wait timeouts', () => {
    const tally = { pending: 10, savepoints: [] };
    expect(applyStatementToPending(tally, failed('UPDATE t SET a=1', 'Error 1062: Duplicate entry'), { driver: 'mysql' }).tally).toEqual(tally);
    expect(applyStatementToPending(tally, failed('CREATE TEMPORARY TABLE x (a int)', 'boom'), { driver: 'mysql' }).tally).toEqual(tally);
    expect(applyStatementToPending(tally, failed('ALTER TABLE t ADD c int', 'boom'), { driver: 'postgres' }).tally).toEqual(tally);
    expect(applyStatementToPending(tally, failed('UPDATE t SET a=1', 'Error 1205 (HY000): Lock wait timeout exceeded; try restarting transaction'), { driver: 'mysql' }).tally).toEqual(tally);
  });
  it('a deadlock rolled the whole transaction back', () => {
    const tally = { pending: 10, savepoints: [{ name: 'a', total: 3 }] };
    const msg = 'Error 1213 (40001): Deadlock found when trying to get lock; try restarting transaction';
    expect(applyStatementToPending(tally, failed('UPDATE t SET a=1', msg), { driver: 'mysql' }).tally).toEqual(EMPTY_TALLY);
    expect(applyStatementToPending(tally, failed('UPDATE t SET a=1', msg), { driver: 'postgres' }).tally).toEqual(tally);
  });
  it('detects the deadlock text the driver produces', () => {
    expect(isMysqlDeadlock('Error 1213 (40001): Deadlock found when trying to get lock; try restarting transaction')).toBe(true);
    expect(isMysqlDeadlock('Deadlock found when trying to get lock')).toBe(true);
    expect(isMysqlDeadlock('Error 1205 (HY000): Lock wait timeout exceeded')).toBe(false);
    expect(isMysqlDeadlock(null)).toBe(false);
  });
  it('lists the statements MySQL commits implicitly', () => {
    for (const sql of ['ALTER TABLE t ADD c int', 'drop table t', 'TRUNCATE t', 'RENAME TABLE a TO b', 'CREATE TABLE t (a int)', 'LOCK TABLES t WRITE', 'BEGIN', 'START TRANSACTION']) expect(impliesMysqlCommit(sql)).toBe(true);
    for (const sql of ['UPDATE t SET a=1', 'SELECT 1', 'CREATE TEMPORARY TABLE x (a int)', 'DROP TEMPORARY TABLE x', 'COMMIT', 'SET autocommit=0']) expect(impliesMysqlCommit(sql)).toBe(false);
  });
});
