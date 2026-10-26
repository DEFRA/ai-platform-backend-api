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
      // The floors are the coverage measured at ab412ca (843 tests, plan 8):
      // coverage never falls below where the B28 refactor started.
      thresholds: {
        lines: 97.3,
        functions: 98.55,
        branches: 92.54,
        statements: 97.34
      },
      // Shared CredentialIssuer and TenantOrchestrator contract suites, not
      // application code - they are exercised (and so already covered) via
      // the adapter test files that call them, not directly.
      exclude: [
        ...configDefaults.exclude,
        'coverage',
        'src/adapters/credential-issuer-contract.js',
        'src/adapters/tenant-orchestrator-contract.js'
      ]
    },
    setupFiles: ['.vite/mongo-memory-server.js', '.vite/setup-files.js']
  }
})
