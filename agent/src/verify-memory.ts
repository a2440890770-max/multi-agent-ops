import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { projectRoot } from './memory-config.js';

const { values } = parseArgs({
  options: { report: { type: 'string' }, 'recreate-db': { type: 'boolean', default: false } },
});
const probe = randomUUID();
const reportPath = values.report
  ? resolve(values.report)
  : resolve(projectRoot, `artifacts/memory/verification-${probe}.json`);
if (existsSync(reportPath)) throw new Error('报告已存在；请使用新路径，避免覆盖证据。');
const directory = resolve(projectRoot, 'artifacts/memory', probe);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  runtime: process.version,
  probe,
  mode: 'embedded-mem0-oss',
  mem0Version: '3.3.1',
  passed: false,
  containerRecreationRequested: values['recreate-db'],
  containerRecreationPassed: false,
  scope:
    'Real local embeddings + PostgreSQL/pgvector + SDK SQLite history; synthetic text; infer:false. Business governance and model extraction are not covered.',
};
const worker = fileURLToPath(new URL('./verify-memory-worker.ts', import.meta.url));
async function runPhase(phase: 'write' | 'reopen', label: string, previous?: string) {
  const path = resolve(directory, `${label}.json`);
  const args = ['--import', 'tsx', worker, '--phase', phase, '--probe', probe, '--report', path];
  if (previous) args.push('--previous', previous);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  if (!existsSync(path))
    throw new Error(
      `${label} 未生成报告（退出码 ${result.status}，${result.error?.name || 'worker failed'}）。`,
    );
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  report[label] = evidence;
  if (result.status !== 0 || evidence.passed !== true)
    throw new Error(`${label} 未通过；详见阶段报告。`);
  return path;
}
try {
  const initial = await runPhase('write', 'write');
  await runPhase('reopen', 'newProcessRead', initial);
  if (values['recreate-db']) {
    const result = spawnSync(process.execPath, ['scripts/memory-database.mjs', 'recreate'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 60000,
    });
    if (result.status !== 0) throw new Error('记忆数据库容器重建失败；不将重建检查标记通过。');
    await runPhase('reopen', 'afterContainerRecreation', initial);
    report.containerRecreationPassed = true;
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Memory verification failed';
  process.exitCode = 1;
}
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
