import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import test from 'node:test';

function fixture(t, source, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ops-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('./setup.mjs', import.meta.url), join(root, 'scripts/setup.mjs'));
  // Exercise the real configuration entry point without provisioning a database.
  writeFileSync(join(root, 'scripts/database.mjs'), 'console.log("database setup invoked");');
  const envPath = join(root, '.env');
  if (source !== undefined) writeFileSync(envPath, source, { mode: 0o600 });
  const env = { ...process.env, NODE_ENV: 'development', POSTGRES_PORT: '5432', ...overrides };
  delete env.AUTH_SECRET;
  const run = () => {
    const result = spawnSync(process.execPath, ['scripts/setup.mjs'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
  };
  return { envPath, run };
}

test('fresh setup persists a private authentication secret without printing credentials', (t) => {
  const { envPath, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  assert.match(env.AUTH_SECRET, /^[a-f0-9]{64}$/);
  assert.ok(!result.stdout.includes(env.AUTH_SECRET));
  assert.ok(!result.stdout.includes(env.POSTGRES_PASSWORD));
  assert.ok(!result.stdout.includes(env.DATABASE_URL));
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.match(result.stdout, /database setup invoked/);
});

test('legacy configuration gains a stable secret while retaining its database settings', (t) => {
  const source =
    '# existing local configuration\nDATABASE_URL=postgresql://synthetic@localhost/example\nBACKEND_PORT=3011';
  const { envPath, run } = fixture(t, source);
  assert.equal(run().status, 0);
  const updated = readFileSync(envPath, 'utf8');
  assert.ok(updated.startsWith(source + '\n'));
  assert.match(parseEnv(updated).AUTH_SECRET, /^[a-f0-9]{64}$/);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(envPath, 'utf8'), updated);
});

test('setup fills an empty authentication assignment from the example environment', (t) => {
  const { envPath, run } = fixture(
    t,
    'DATABASE_URL=synthetic\r\nexport AUTH_SECRET = "" # unset\r\n',
  );
  assert.equal(run().status, 0);
  const updated = readFileSync(envPath, 'utf8');
  assert.match(parseEnv(updated).AUTH_SECRET, /^[a-f0-9]{64}$/);
  assert.equal(parseEnv(updated).DATABASE_URL, 'synthetic');
  assert.equal(updated.match(/AUTH_SECRET/g).length, 1);
});

test('setup preserves an existing authentication secret and all other configuration', (t) => {
  const secret = randomBytes(32).toString('hex');
  const source = `DATABASE_URL=synthetic\nAUTH_SECRET=${secret}\n`;
  const { envPath, run } = fixture(t, source);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(envPath, 'utf8'), source);
  assert.ok(!result.stdout.includes(secret));
});

test('production setup requires an explicit secret and leaves existing configuration intact', (t) => {
  const source = 'NODE_ENV=production\nDATABASE_URL=synthetic\n';
  const { envPath, run } = fixture(t, source, { NODE_ENV: 'production' });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_SECRET/);
  assert.equal(readFileSync(envPath, 'utf8'), source);
  assert.ok(!result.stdout.includes('database setup invoked'));
});
