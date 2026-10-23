import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import {packageCoverage} from '../../services/shared/test-coverage.mjs';
import {isolateBridgeTestProcess} from './test/process-environment.mjs';

const isolation=isolateBridgeTestProcess();

export default defineConfig({test:{environment:'node',include:['test/**/*.test.{ts,tsx,js,cjs,mjs}'],
    env:isolation.environment,
    coverage:packageCoverage(fileURLToPath(new URL('.',import.meta.url)))}});
