/** Shared correctness rules for Node services, formatting is handled separately by Prettier. */
export const serviceRules = {
    // TypeScript owns name resolution, including decorators and Node globals.
    'no-undef': 'off',
    // Input validators intentionally reject forbidden control bytes.
    'no-control-regex': 'off',
    // Public errors must not expose sensitive transport or credential causes.
    'preserve-caught-error': 'off',
    // Best-effort cleanup can deliberately ignore a secondary failure.
    'no-empty': ['error', {allowEmptyCatch: true}],
    // Services use Node's require/createRequire for optional and CommonJS dependencies.
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-unused-vars': ['error', {ignoreRestSiblings: true, argsIgnorePattern: '^_'}],
};
