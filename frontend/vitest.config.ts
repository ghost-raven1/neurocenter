import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import {packageCoverage} from '../services/shared/test-coverage.mjs';

export default defineConfig({resolve:{alias:{'@neurocenter/computer-setup':fileURLToPath(new URL('../services/shared/computer-setup.cjs',import.meta.url))}},
    test:{environment:'node',include:['test/**/*.test.{ts,tsx,js,cjs,mjs}'],
    coverage:packageCoverage(fileURLToPath(new URL('.',import.meta.url)))}});
