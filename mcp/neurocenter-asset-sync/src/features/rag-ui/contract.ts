import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/rag-ui-contract.cjs'
        : '../../shared/rag-ui-contract.cjs',
    import.meta.url,
);
export const { localRagUi, ragUiReady } = createRequire(import.meta.url)(
    fileURLToPath(source),
) as typeof import('../../../../../services/shared/rag-ui-contract.cjs');
