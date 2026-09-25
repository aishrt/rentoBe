import { createApp } from './app.js';
import { connectDb, disconnectDb } from './db.js';
import { env } from './env.js';
import { logger } from './integrations/logger.js';
import { markShuttingDown } from './lib/lifecycle.js';

const SHUTDOWN_TIMEOUT_MS = 55_000; // inside the 60 s ECS stop timeout (plan §13.4)

async function main() {
  await connectDb();

  const server = createApp().listen(env.PORT, () => {
    logger.info(`Rento Vroom API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    markShuttingDown();
    setTimeout(() => {
      logger.error('Shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start the API');
  process.exit(1);
});
