import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import {packageCoverage} from '../shared/test-coverage.mjs';

export default defineConfig({test:{environment:'node',include:['src/**/tests/**/*.test.{ts,tsx}', 'src/**/test/**/*.test.{ts,tsx}', 'integration/test/**/*.test.{ts,tsx,js,cjs,mjs}', 'test/**/*.test.{ts,tsx,js,cjs,mjs}'],passWithNoTests:true,
    coverage:packageCoverage(fileURLToPath(new URL('.',import.meta.url)))}});
