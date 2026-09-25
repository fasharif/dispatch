// Each workspace has its own ESLint config; this root config covers files outside them.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'apps/**', 'packages/**', 'tools/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
