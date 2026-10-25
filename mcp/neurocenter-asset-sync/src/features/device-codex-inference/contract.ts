import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
export type {DeviceCodexPayload,DeviceCodexContext,DeviceCodexResult,DeviceCodexResponse} from '../../../../../services/shared/device-codex-inference.cjs';
const shared=createRequire(import.meta.url)(fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../../../../services/shared/device-codex-inference.cjs':'../../shared/device-codex-inference.cjs',import.meta.url))) as typeof import('../../../../../services/shared/device-codex-inference.cjs');
export const {DEVICE_CODEX_PROTOCOL,DEVICE_CODEX_CAPABILITY,DEVICE_CODEX_DISPATCH_CAPABILITY,DEVICE_CODEX_JOB,deviceCodexCandidateIdentity,normalizeDeviceCodexPayload,normalizeDeviceCodexContext,normalizeDeviceCodexResult}=shared;
