import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import {
  assertComposePortAvailable,
  databaseEndpoint,
  readDatabaseMode,
} from './database-mode.mjs';

test('已有库模式必须显式启用，连接检查不依赖 Compose 管理密码', () => {
  assert.equal(readDatabaseMode({}), 'compose');
  assert.equal(readDatabaseMode({ DATABASE_MODE: 'external' }), 'external');
  assert.throws(() => readDatabaseMode({ DATABASE_MODE: 'auto' }), /仅支持/);
  assert.deepEqual(
    databaseEndpoint({ DATABASE_URL: 'postgresql://runtime:secret@127.0.0.1:55432/business' }),
    { host: '127.0.0.1', port: 55432, database: 'business' },
  );
  assert.throws(() => databaseEndpoint({}), /DATABASE_URL/);
});
test('端口被占用时给出调整端口或使用已有库的说明，不影响占用者', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      assertComposePortAvailable(port),
      (error) =>
        error.message.includes('已被占用') && error.message.includes('DATABASE_MODE=external'),
    );
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertComposePortAvailable(port);
});
