import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Persist the algorithm, cost, random salt and derived key for the future login verifier.
// N=2^17, r=8, p=1; maxmem includes scrypt's overhead above its 128 MiB work area.
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const prefix = '$scrypt$v=1$N=131072,r=8,p=1$';
const encoded = /^\$scrypt\$v=1\$N=131072,r=8,p=1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8 || password.length > 256)
    throw new Error('密码长度必须为 8—256 个字符。');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  try {
    return `${prefix}${salt.toString('hex')}$${key.toString('hex')}`;
  } finally {
    key.fill(0);
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length < 8 || password.length > 256) return false;
  // Only accept supported, bounded parameters; never let stored text choose arbitrary work.
  const match = encoded.exec(stored);
  if (!match) return false;
  const key = await derive(password, Buffer.from(match[1]!, 'hex'));
  const expected = Buffer.from(match[2]!, 'hex');
  try {
    return timingSafeEqual(key, expected);
  } finally {
    key.fill(0);
    expected.fill(0);
  }
}
