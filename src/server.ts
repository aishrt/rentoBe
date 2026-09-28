import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connectDb, disconnectDb } from './db.js';
import { env } from './env.js';
import { logger } from './integrations/logger.js';
import { flushSentry, initSentry, reportError } from './integrations/sentry.js';
import { createJobRunner } from './jobs/runner.js';
import { markShuttingDown } from './lib/lifecycle.js';
import { startRealtime } from './realtime/realtime.js';

const SHUTDOWN_TIMEOUT_MS = 55_000; // inside the 60 s ECS stop timeout (plan §13.4)
const JOB_STOP_TIMEOUT_MS = 20_000;

async function main() {
  initSentry();
  await connectDb();

  // One process: REST API, Socket.IO and the job runner (plan §1.1).
  const server = createServer(createApp());
  const realtime = await startRealtime(server);
  const jobRunner = env.RUN_JOBS ? createJobRunner({ concurrency: env.JOB_CONCURRENCY }) : undefined;

  server.listen(env.PORT, () => {
    logger.info(`Rento Vroom API listening on http://localhost:${env.PORT}`);
    jobRunner?.start();
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    markShuttingDown();
    setTimeout(() => {
      logger.error('Shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    try {
      // Plan §13.4: stop claiming jobs (unfinished ones go back in the queue), close sockets so
      // browsers reconnect to another task, let requests in progress finish, then disconnect.
      await jobRunner?.stop(JOB_STOP_TIMEOUT_MS);
      await realtime.close(); // also closes the HTTP server once its requests finish
      await disconnectDb();
      await flushSentry();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Shutdown failed');
      reportError(error, { tags: { area: 'shutdown' } });
      await flushSentry();
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start the API');
  reportError(error, { tags: { area: 'startup' } });
  await flushSentry();
  process.exit(1);
});
