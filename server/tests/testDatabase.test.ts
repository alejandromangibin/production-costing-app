import { afterEach, describe, expect, it, vi } from 'vitest';
import { PSQL_ARGS, psqlEnv, setupSql, testDatabaseUrl } from '../src/scripts/testDbSql';
import { openTestDb, testDatabaseProblem, wipeTestDatabase } from './helpers';

const hex = 'ab'.repeat(24);

describe('the tests wipe only a local test database', () => {
  it('accepts the address the setup script writes', () => {
    expect(testDatabaseProblem(testDatabaseUrl(hex))).toBeNull();
    expect(testDatabaseProblem('postgres://u:p@127.0.0.1:5432/costing_test')).toBeNull();
    expect(testDatabaseProblem('postgres://u:p@[::1]:5432/other_test')).toBeNull();
  });

  it('refuses a database whose name does not end in _test', () => {
    for (const name of ['costing', 'postgres', 'production_costing', 'test_costing', 'costing_test_backup', '', 'a/b_test', '_test']) {
      expect(testDatabaseProblem(`postgres://u:p@localhost:5432/${name}`), name).toMatch(/_test/);
    }
  });

  it('refuses anything that is not on this PC', () => {
    for (const host of ['dpg-abc123.singapore-postgres.render.com', 'db.example.com', '10.0.0.5', 'localhost.example.com', '0.0.0.0']) {
      expect(testDatabaseProblem(`postgres://u:p@${host}:5432/costing_test`), host).toMatch(/this PC/);
    }
  });

  it('refuses a host hidden in the address options, and an address it cannot read', () => {
    expect(testDatabaseProblem('postgres://u:p@localhost:5432/costing_test?host=db.example.com')).toMatch(/this PC/);
    expect(testDatabaseProblem('not an address')).toBeTruthy();
  });

  it('refuses other schemes and whitespace, which the driver reads differently', () => {
    for (const address of [
      'socket://localhost/costing_test?db=production',
      'http://localhost/costing_test',
      'postgres://u:p@localhost:5432/costing_test\n',
      'postgres://u:p@localhost:5432/costing_test ',
      'postgres://u:p@local host:5432/costing_test',
      'postgres://u:p@localhost:5432/costing\t_test',
      'postgres://u:p@localhost:5432/costing_test\x01',
      'xpostgres://localhost/costing_test',
    ]) {
      expect(testDatabaseProblem(address), address).toBe('TEST_DATABASE_URL is not a database address.');
    }
    expect(testDatabaseProblem('postgresql://u:p@localhost:5432/costing_test')).toBeNull();
  });

  it('never repeats the password in its message', () => {
    expect(testDatabaseProblem('postgres://u:s3cretpw@db.example.com:5432/costing')).not.toContain('s3cretpw');
    expect(testDatabaseProblem('postgres://u:s3cretpw@not a host/x')).not.toContain('s3cretpw');
  });
});

describe('opening a test database', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Port 1 has nothing listening: if the guard were gone these would fail with "connection refused".
  it('checks the address before connecting', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/costing');
    await expect(openTestDb()).rejects.toThrow(/ending in _test/);
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://u:p@db.example.com:1/costing_test');
    await expect(openTestDb()).rejects.toThrow(/on this PC/);
  });

  /** A stand-in database that answers "who are you" with this name and login, and records what it is told. */
  const server = (name: string, rolsuper: boolean | undefined) => {
    const executed: string[] = [];
    let closed = false;
    return {
      executed,
      closed: () => closed,
      db: {
        query: async () => ({ rows: rolsuper === undefined ? [] : [{ name, rolsuper }] }),
        exec: async (text: string) => void executed.push(text),
        close: async () => void (closed = true),
      } as any,
    };
  };

  it('asks the server before wiping, on the way the tests really open a database', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/costing_test');
    const wrong = server('production', false);
    await expect(openTestDb(async () => ({ ...wrong.db, kind: 'postgres' }))).rejects.toThrow(/Refusing to wipe/);
    expect(wrong.executed).toEqual([]);
  });

  it('wipes before the tables are built, not after', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/costing_test');
    const right = server('costing_test', false);
    const stop = new Error('stop here');
    const opened = { ...right.db, kind: 'postgres', exec: async (text: string) => { right.executed.push(text); if (!text.startsWith('DROP SCHEMA')) throw stop; } };
    await expect(openTestDb(async () => opened)).rejects.toBe(stop);
    expect(right.executed[0]).toBe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });

  it('wipes a *_test database reached by a plain login', async () => {
    const s = server('costing_test', false);
    await wipeTestDatabase(s.db);
    expect(s.executed).toEqual(['DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
    expect(s.closed()).toBe(false);
  });

  it('wipes nothing if the server says it is another database, or the login is a superuser', async () => {
    for (const [name, rolsuper] of [['production', false], ['costing', false], ['costing_test_backup', false], ['costing_test', true], ['costing_test', undefined]] as const) {
      const s = server(name, rolsuper);
      await expect(wipeTestDatabase(s.db), `${name} ${rolsuper}`).rejects.toThrow(/Refusing to wipe/);
      expect(s.executed).toEqual([]);
      expect(s.closed()).toBe(true);
    }
  });
});

describe('the setup commands', () => {
  it('create a plain owner, not a superuser, and a UTF8 database, and are safe to run again', () => {
    const sql = setupSql(hex);
    expect(sql).toContain('LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB');
    expect(sql).toContain(`PASSWORD '${hex}'`);
    expect(sql).toContain(`ENCODING ''UTF8'' TEMPLATE template0`);
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM pg_roles/);
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM pg_database/);
    expect(sql).not.toMatch(/DROP|DELETE|TRUNCATE/i);
  });

  it('run psql on this PC with no personal settings, and never with the password on the command line', () => {
    expect(PSQL_ARGS).toEqual(['-X', '-U', 'postgres', '-h', 'localhost', '-p', '5432', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1']);
    const env = psqlEnv({ PGHOST: 'x', PGHOSTADDR: 'x', PGPASSWORD: 'x', PGSERVICE: 'x', pgport: 'x', PSQLRC: 'x', Path: 'C:\\bin', SystemRoot: 'C:\\Windows' });
    expect(Object.keys(env).sort()).toEqual(['Path', 'SystemRoot']);
  });

  it('refuse a password that could break out of the quotes', () => {
    for (const bad of ["x'; DROP ROLE postgres; --", 'short', '', 'A'.repeat(48)]) {
      expect(() => setupSql(bad), bad).toThrow(/long hex/);
    }
  });
});
