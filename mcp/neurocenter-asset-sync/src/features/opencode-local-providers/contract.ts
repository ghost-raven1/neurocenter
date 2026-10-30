import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const source=new URL(import.meta.url.endsWith('.ts')?'../../../../../services/shared/opencode-local-providers.cjs':'../../shared/opencode-local-providers.cjs',import.meta.url);
export const contract=createRequire(import.meta.url)(fileURLToPath(source)) as typeof import('../../../../../services/shared/opencode-local-providers.cjs');
export type {GlobalProvidersLimits,OpenCodeGlobalProvidersInventory,OpenCodeGlobalProvidersResult,GlobalProvider,GlobalProvidersIssue} from '../../../../../services/shared/opencode-local-providers.cjs';
