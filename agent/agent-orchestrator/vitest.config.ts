import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DQA_CONTENT_MODE: 'off',
    },
  },
})
