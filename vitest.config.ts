import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is src/web: tests live across
// src/server, src/cli, and src/web.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
});
