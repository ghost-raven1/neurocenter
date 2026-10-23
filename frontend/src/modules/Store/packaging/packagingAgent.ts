import {modelChatUnavailableReason} from '../../../features/ModelChat/model';
import type {ICatalogModel} from '../../../features/ModelCatalog/types';
import type {ToolBuildAgent} from './types';

const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const modelId = (value: unknown): value is string => typeof value === 'string' && /^model-[a-z0-9][a-z0-9-]{0,120}$/.test(value);

/** Only verified common chat models can be explicitly selected for a build. */
export function packagingAgentModelAvailable(model: ICatalogModel): boolean {
    return modelId(model.id) && !model.archivedAt && digest(model.modelPin) && !modelChatUnavailableReason(model, true, false, false)
        && (model.runtime === 'ollama' ? digest(model.manifestSha256) : digest(model.verificationSha256));
}

/** Exact model identity and bounded attempts survive durable request recovery. */
export function validPackagingAgent(value: unknown): value is ToolBuildAgent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return Object.keys(item).every(key => ['modelId', 'expectedModelPin', 'maxAttempts'].includes(key))
        && modelId(item.modelId) && digest(item.expectedModelPin)
        && Number.isInteger(item.maxAttempts) && Number(item.maxAttempts) >= 1 && Number(item.maxAttempts) <= 3;
}
