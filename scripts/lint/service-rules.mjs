/** Project-owned interfaces and type aliases expose their kind in their names. */
export const typeNamingConvention = [
    { selector: 'interface', format: null, custom: { regex: '^I[A-Z]', match: true } },
    { selector: 'typeAlias', format: null, custom: { regex: '^T[A-Z]', match: true } },
];

/** Shared correctness rules for Node services, formatting is handled separately by Prettier. */
export const serviceRules = {
    '@typescript-eslint/naming-convention': ['error', ...typeNamingConvention],
    // TypeScript owns name resolution, including decorators and Node globals.
    'no-undef': 'off',
    // Input validators intentionally reject forbidden control bytes.
    'no-control-regex': 'off',
    // Public errors must not expose sensitive transport or credential causes.
    'preserve-caught-error': 'off',
    // Best-effort cleanup can deliberately ignore a secondary failure.
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Services use Node's require/createRequire for optional and CommonJS dependencies.
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
};

/** Test doubles may use partial values and intentionally unused callback arguments. */
export const serviceTestRules = {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
};
