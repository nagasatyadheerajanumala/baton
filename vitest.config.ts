import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Never discover the developer's real Codex / Claude Code MCP servers during tests.
    env: { BATON_NO_DISCOVERY: '1' },
  },
});
