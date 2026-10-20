import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // N37c: thresholds sit just under current reality (75.21% stmts /
    // 75.01% lines measured on the 421-test unit suite) so coverage
    // regressions fail `npm run test:cov`.
    coverage: {
      provider: 'v8',
      statements: 70,
      lines: 70,
      reporter: ['text'],
    },
  },
});
