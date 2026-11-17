import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The tests run inside workerd with the bindings from wrangler.jsonc; the
// Durable Objects are local ones that start empty.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: { include: ['test/**/*.test.js'] },
});
