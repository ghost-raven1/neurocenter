import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { serviceRules, serviceTestRules } from '../../scripts/lint/service-rules.mjs';

/** Lint authored service sources; generated output is excluded; test doubles use a scoped policy. */
export default defineConfig(
    { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
    {
        files: ['scripts/**/*.mjs'],
        extends: [js.configs.recommended],
        languageOptions: { globals: globals.node },
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }],
            'preserve-caught-error': 'off',
        },
    },
    {
        files: ['src/**/*.ts', 'integration/test/**/*.{ts,mjs,cjs}'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: serviceRules,
    },
    {
        files: ['src/**/tests/**/*.ts', 'src/**/test/**/*.ts', 'integration/test/**/*.{ts,mjs,cjs}'],
        rules: serviceTestRules,
    },
);
