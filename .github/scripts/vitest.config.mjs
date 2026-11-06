import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      '.github/scripts/**/*.test.mjs',
      'config/scripts/fork-electron-builder-config.test.mjs'
    ],
    testTimeout: 30_000
  }
})
