import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  // recommendedTypeChecked covers the important correctness rules without
  // the noise of strictTypeChecked (which flags every IndexedDB unsafe cast,
  // non-null assertion, and void-expression-in-arrow pattern).
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Adapter methods must be declared async to match the NoydbAdapter
      // interface, even when the implementation is purely synchronous.
      '@typescript-eslint/require-await': 'off',
      // Number interpolation in template literals is safe and common.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Web API and SDK boundary code (IndexedDB, WebAuthn, AWS SDK)
      // legitimately returns values typed as `any` or unresolved types
      // through the DOM lib / third-party type defs. Disabling these
      // rules avoids noise without losing real-world safety — the
      // adapter code casts the untyped values through explicit `as`
      // assertions on the next line.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // IndexedDB uses `DOMException | null` for error properties.
      // DOMException is an Error subclass at runtime, but eslint's type
      // check flags the null case. Our reject() calls are correct.
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '*.config.*', '*.mjs'],
  },
)
