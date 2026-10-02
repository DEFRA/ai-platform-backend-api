import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    fileParallelism: false,
    // mongodb-memory-server downloads a ~600MB binary on first run, which can exceed the default 10s hook timeout
    hookTimeout: 120000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      // A shared CredentialIssuer contract suite, not application code - it
      // is exercised (and so already covered) via the adapter test files
      // that call it, not directly.
      exclude: [
        ...configDefaults.exclude,
        'coverage',
        'src/adapters/credential-issuer-contract.js'
      ]
    },
    setupFiles: ['.vite/mongo-memory-server.js', '.vite/setup-files.js']
  }
})
