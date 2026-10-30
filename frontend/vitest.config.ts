import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import {packageCoverage} from '../services/shared/test-coverage.mjs';

export default defineConfig({resolve:{alias:{'@neurocenter/computer-setup':fileURLToPath(new URL('../services/shared/computer-setup.cjs',import.meta.url)),
'@neurocenter/opencode-local-providers':fileURLToPath(new URL('../services/shared/opencode-local-providers.cjs',import.meta.url)),
'@neurocenter/opencode-cli-install':fileURLToPath(new URL('../services/shared/opencode-cli-install.cjs',import.meta.url)),
    '@neurocenter/project-text-knowledge':fileURLToPath(new URL('../services/shared/project-text-knowledge.cjs',import.meta.url)),
    '@neurocenter/runtime-limits':fileURLToPath(new URL('../services/shared/runtime-limits.cjs',import.meta.url))}},
    test:{environment:'node',include:['test/**/*.test.{ts,tsx,js,cjs,mjs}'],
    coverage:packageCoverage(fileURLToPath(new URL('.',import.meta.url)))}});
