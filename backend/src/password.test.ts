import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from './password.js';

test('passwords use random salts and verify without normalization or plaintext storage', async () => {
  const password = ' synthetic-test-password ';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password.trim(), first), false);
  assert.equal(await verifyPassword('incorrect-test-password', first), false);
});

test('invalid lengths and unsupported hash parameters are rejected', async () => {
  for (const password of ['', 'short', 'x'.repeat(257)])
    await assert.rejects(hashPassword(password), /8—256/);
  for (const stored of ['plaintext', '$scrypt$v=2$invalid', '$scrypt$v=1$N=999999999$rubbish'])
    assert.equal(await verifyPassword('synthetic-password', stored), false);
  assert.equal(await verifyPassword('short', 'invalid'), false);
});
