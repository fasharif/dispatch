// Each workspace has its own ESLint config; this root config covers load/ (k6 scripts and the
// report generator).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/**',
      'packages/**',
      'tools/**',
      'load/results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['load/**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
  {
    files: ['load/**/*.ts'],
    languageOptions: { globals: { __ENV: 'readonly', open: 'readonly' } },
  },
);
