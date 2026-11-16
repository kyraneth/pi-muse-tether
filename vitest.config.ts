import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { setupFiles: ['./scripts/test-isolation.mjs'], include: ['tests/**/*.test.ts'], exclude: ['tests/host.test.ts'] } });
