import globals from 'globals';
import { typescriptConfig } from '../../eslint.base.mjs';

export default typescriptConfig(import.meta.dirname, [
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // NestJS modules are decorated empty classes by design.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
]);
