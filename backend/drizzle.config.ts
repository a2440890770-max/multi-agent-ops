import { defineConfig } from 'drizzle-kit';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(path)) process.loadEnvFile(path);
const url = process.env.DATABASE_URL;
if (process.argv.includes('migrate') && !url) throw new Error('迁移需要业务 DATABASE_URL。');
if (url && process.env.MEM0_DATABASE_URL) {
  const business = new URL(url);
  const memory = new URL(process.env.MEM0_DATABASE_URL);
  if (business.host === memory.host && business.pathname === memory.pathname)
    throw new Error('禁止将业务迁移应用到记忆数据库。');
}
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  ...(url ? { dbCredentials: { url } } : {}),
  strict: true,
});
