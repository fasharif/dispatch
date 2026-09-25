// Shared ESLint settings for the TypeScript workspaces (type-aware, strict).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @param {string} tsconfigRootDir @param {import('typescript-eslint').ConfigArray} [extra] */
export function typescriptConfig(tsconfigRootDir, extra = []) {
  return tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'data/**'] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: {
        '@typescript-eslint/no-unused-vars': [
          'error',
          { ignoreRestSiblings: true, argsIgnorePattern: '^_' },
        ],
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', 'test/**/*.ts'],
      rules: {
        // Tests build partial fakes and index fixtures they know are present.
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    ...extra,
    { files: ['**/*.mjs', '**/*.cjs', '**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  );
}
