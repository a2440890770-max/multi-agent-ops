// Child-process fixture: only the explicit disposable task DB is accepted.
import { createBusinessDatabase } from '../../backend/src/database.ts';
import { MockTaskExecutor } from '../../backend/src/mock-task-executor.ts';
const url = process.env.TASK_TEST_DATABASE_URL;
if (!url || !/^tasks_test_[a-f0-9]{12}$/.test(new URL(url).pathname.slice(1)))
  throw new Error('Mock worker fixture requires an isolated tasks_test database.');
const database = createBusinessDatabase(url);
const worker = new MockTaskExecutor(database.db, { pollMs: 50 });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await worker.stop();
  await database.close();
  process.exit(0);
}
// Retain the IPC channel while running, just as the HTTP server retains the real process.
process.on('message', () => {});
process.on('disconnect', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
worker.start();
process.send?.('ready');
