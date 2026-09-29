import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Each test file starts its own in-memory MongoDB, so the first run can take a while.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/rento-vroom-test-placeholder',
      JWT_ACCESS_SECRET: 'test-only-secret-that-is-at-least-32-characters-long',
      ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
      FRONTEND_URL: 'http://localhost:5173',
      FRONTEND_ORIGINS: 'http://localhost:5173',
      MAIL_DRIVER: 'console',
      EMAIL_FROM: 'Rento Vroom <hello@mail.example.com>',
      LOG_LEVEL: 'silent',
      // Fake sandbox keys: tests replace every Stripe API call, and sign webhooks with this secret.
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    },
  },
});
