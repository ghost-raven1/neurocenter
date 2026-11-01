import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { typeNamingConvention } from '../scripts/lint/service-rules.mjs';

/** Check source correctness without imposing a formatting migration on existing features. */
export default defineConfig(
    {
        files: ['src/**/*.{ts,tsx}'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        plugins: { 'react-hooks': reactHooks },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: {
            '@typescript-eslint/naming-convention': ['error', ...typeNamingConvention],
            // TypeScript resolves DOM, module and type names; the JavaScript rule cannot do so.
            'no-undef': 'off',
            // Validators intentionally reject or strip forbidden control bytes; these are not accidental regex characters.
            'no-control-regex': 'off',
            // Public errors deliberately replace sensitive transport failures; the frontend targets ES2020.
            'preserve-caught-error': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
        },
    },
    {
        files: ['src/vite-env.d.ts'],
        rules: {
            // Vite augments these external ambient contracts by their exact public names.
            '@typescript-eslint/naming-convention': [
                'error',
                { selector: 'interface', filter: { regex: '^(ImportMeta|ImportMetaEnv)$', match: true }, format: null },
                ...typeNamingConvention,
            ],
        },
    },
    {
        files: ['src/core/api/base.ts'],
        rules: {
            // Axios declaration merging requires the original external interface name.
            '@typescript-eslint/naming-convention': [
                'error',
                { selector: 'interface', filter: { regex: '^AxiosRequestConfig$', match: true }, format: null },
                ...typeNamingConvention,
            ],
        },
    },
);
