import { defineConfig } from 'vitest/config'

// Root tests cover the repo scripts; each package under packages/ runs its own suite.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts']
  }
})
