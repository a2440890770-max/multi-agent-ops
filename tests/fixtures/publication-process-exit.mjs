import { createBusinessDatabase } from '../../backend/src/database.ts';
import { TaskService } from '../../backend/src/task-service.ts';

process.once('message', async ({ command, databaseUrl }) => {
  const database = createBusinessDatabase(databaseUrl);
  const adapter = {
    mode: 'simulation',
    timeoutMs: 5000,
    send(input) {
      // This represents a provider receiving a request, followed by sender death.
      process.send({ received: input }, () => process.exit(23));
      return new Promise(() => {});
    },
  };
  try {
    await new TaskService(database.db, () => new Date(), {
      simulationPublicationAdapter: adapter,
    }).publish(command);
    process.exit(24);
  } catch {
    process.exit(25);
  }
});
