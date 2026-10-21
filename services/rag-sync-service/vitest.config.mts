import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import {packageCoverage} from '../shared/test-coverage.mjs';

export default defineConfig({test:{environment:'node',include:['test/**/*.test.{ts,tsx,js,cjs,mjs}'],
    coverage:packageCoverage(fileURLToPath(new URL('.',import.meta.url)))}});
