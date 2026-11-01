import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const source = new URL(
    import.meta.url.endsWith('.ts')
        ? '../../../../../services/shared/opencode-personal-key.cjs'
        : '../../shared/opencode-personal-key.cjs',
    import.meta.url,
);
export const contract = createRequire(import.meta.url)(
    fileURLToPath(source),
) as typeof import('../../../../../services/shared/opencode-personal-key.cjs');
export type {
    IOpenCodePersonalKeyPayload,
    IOpenCodePersonalKeyContext,
    IOpenCodePersonalKeyReceipt,
} from '../../../../../services/shared/opencode-personal-key.cjs';
