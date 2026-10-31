import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/rag-core-contract.cjs'
        : '../../shared/rag-core-contract.cjs',
    import.meta.url,
);
export const { localRagCore } = createRequire(import.meta.url)(
    fileURLToPath(source),
) as typeof import('../../../../../services/shared/rag-core-contract.cjs');
