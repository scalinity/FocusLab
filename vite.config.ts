import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: { host: 'localhost', port: 5190, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
