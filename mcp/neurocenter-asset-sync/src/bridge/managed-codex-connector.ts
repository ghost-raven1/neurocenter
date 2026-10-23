import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

/** Source and standalone bridge archives use the same restriction for the pinned supply library. */
const shared=createRequire(import.meta.url)(fileURLToPath(new URL(import.meta.url.endsWith('.ts')
    ?'../../../../services/shared/codex-connector-source.cjs':'../shared/codex-connector-source.cjs',import.meta.url))) as typeof import('../../../../services/shared/codex-connector-source.cjs');
export const {isManagedCodexConnectorPackage,CODEX_MANAGED_INSTALL_MESSAGE}=shared;
