import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { serviceRules } from './scripts/lint/service-rules.mjs';

/** Check repository-owned tooling, shared runtime and authored catalog components. */
export default defineConfig(
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            'coverage/**',
            'frontend/coverage/**',
            'services/*/coverage/**',
            'mcp/*/coverage/**',
            '.run/**',
            'vendor/**',
            'catalog-source/components/fetch-mcp/source/**',
        ],
    },
    {
        files: ['scripts/**/*.{js,cjs,mjs}', 'services/shared/**/*.{js,cjs,mjs}', 'eslint.config.mjs'],
        extends: [js.configs.recommended],
        languageOptions: { globals: globals.node },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: {
            'no-control-regex': 'off',
            'preserve-caught-error': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-unused-vars': [
                'error',
                {
                    ignoreRestSiblings: true,
                    varsIgnorePattern: '^_',
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
        },
    },
    {
        // These aliases belong to the pinned Preact bundle where the serialized function runs.
        files: ['scripts/catalog-plugins/recipes/rag-web-ui.mjs'],
        languageOptions: {
            globals: {
                s: 'readonly',
                i: 'readonly',
                W: 'readonly',
                V: 'readonly',
                u: 'readonly',
                l: 'readonly',
                ft: 'readonly',
                $: 'readonly',
            },
        },
    },
    {
        files: [
            'scripts/**/*.{ts,cts,mts}',
            'services/shared/**/*.{ts,cts,mts}',
            'catalog-source/components/**/source/**/*.{ts,tsx}',
        ],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: serviceRules,
    },
);
