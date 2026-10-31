import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import tseslint from 'typescript-eslint';
import {serviceRules} from '../../scripts/lint/service-rules.mjs';

/** Lint authored service sources; generated output and tests have separate checks. */
export default defineConfig(
    {ignores: ['dist/**', 'coverage/**', 'node_modules/**']},
    {
        files: ['src/**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        linterOptions: {reportUnusedDisableDirectives: 'error'},
        rules: serviceRules,
    },
);
