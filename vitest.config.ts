import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/**/*.spec.ts',
      'packages/**/tests/**/*.spec.{ts,tsx}',
    ],
    setupFiles: ['packages/ui-git-commit/tests/setup.ts'],
    environmentMatchGlobs: [
      ['packages/ui-git-commit/tests/**', 'jsdom'],
    ],
  },
})