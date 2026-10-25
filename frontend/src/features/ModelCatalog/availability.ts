import type {ICatalogModel} from './types';

const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Public verification metadata may suggest an inference draft; the server rechecks readiness on submission. */
export function catalogInferenceModelReady(model: ICatalogModel): boolean {
    return model.capability !== 'embedding' && !model.archivedAt && digest(model.modelPin)
        && (model.runtime === 'ollama' ? digest(model.manifestSha256)
            : model.runtime === 'device-codex' || digest(model.verificationSha256));
}
