import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // node, not jsdom, and the DOM tests opt IN with a
    //   // @vitest-environment jsdom
    // docblock on their first line.
    //
    // 86 of the 99 test files here are pure logic — risk matrices, RBAC, CSV,
    // contrast maths — and none of them touch a DOM. Building one for each cost
    // 90 seconds of a 160-second run, more than every test in the suite put
    // together.
    //
    // The docblock is preferred over environmentMatchGlobs because it puts the
    // requirement in the file that has it: a new DOM test that forgets it fails
    // immediately and obviously, where a glob nobody maintains would quietly
    // stop covering things.
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,jsx}', 'stack/**/*.test.{js,mjs}', 'worker/**/*.test.js'],
    exclude: ['node_modules/**', 'stack/node_modules/**', '.vendor/**'],
  },
})
