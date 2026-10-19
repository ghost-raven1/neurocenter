import { errorMessage } from '../../../common/utils/errorMessage';
import type { IBridgeJob } from '../api';
import type { IRagUiDraft, IRagUiRequest } from './ragUiState';
import { createBridgeRequestKey } from '../bridgeRequestKey';

export interface IRagUiLaunchState { scope: string; busy: boolean; error: string; submitted?: IBridgeJob; }
interface IOptions {
    getScope: () => string; captureOwner: () => () => boolean;
    create: (input: IRagUiRequest) => Promise<IBridgeJob>; reload: () => Promise<void>;
    onChange: (state: IRagUiLaunchState) => void; newKey?: () => string;
}
export const initialRagUiLaunchState = (scope = ''): IRagUiLaunchState => ({ scope, busy: false, error: '' });

/** Неизвестный исход POST повторяется с тем же ключом, без второго запуска окна. */
export function createRagUiLaunchController(options: IOptions) {
    let active = false, epoch = 0, serial = 0, lock: symbol | undefined;
    let state = initialRagUiLaunchState();
    const keys = new Map<string, string>();
    const update = (changes: Partial<IRagUiLaunchState>): void => { state = { ...state, ...changes }; options.onChange(state); };
    return {
        activate(): void { active = true; epoch++; serial++; lock = undefined; state = initialRagUiLaunchState(options.getScope()); options.onChange(state); },
        dispose(): void { active = false; epoch++; serial++; },
        async submit(input: IRagUiDraft): Promise<void> {
            const owns = options.captureOwner(), capturedEpoch = epoch, scope = state.scope;
            if (!active || lock || !owns() || scope !== options.getScope()) return;
            const sequence = ++serial;
            const current = (): boolean => active && epoch === capturedEpoch && serial === sequence && owns() && options.getScope() === scope;
            const token = Symbol('open-rag-ui'); lock = token;
            update({ busy: true, error: '' });
            try {
                const signature = JSON.stringify(input), requestKey = keys.get(signature) || createBridgeRequestKey(options.newKey);
                keys.set(signature, requestKey);
                const job = await options.create({ ...input, requestKey });
                if (!job || typeof job.id !== 'string' || job.kind !== 'open-rag-ui' || job.deviceId !== input.deviceId
                    || job.projectId !== input.projectId || job.bindingId !== input.expectedBindingId || job.assetId !== input.assetId
                    || job.assetKind !== input.assetKind || Number(job.version) !== input.version || job.expectedManifest !== input.expectedManifest
                    || job.expectedInstanceId !== input.expectedInstanceId) {
                    throw new Error('Мост не подтвердил задание для выбранной установки. Обновите данные и повторите проверку.');
                }
                if (!current()) return;
                keys.delete(signature);
                update({ submitted: job });
                void options.reload().catch(() => {
                    if (current()) update({ error: 'Задание принято, но его состояние не обновилось. Обновите данные моста.' });
                });
            } catch (failure) {
                if (current()) update({ error: errorMessage(failure, 'Не удалось подтвердить запуск интерфейса. Повторная проверка использует тот же запрос.') });
            } finally {
                if (lock === token) { lock = undefined; if (current()) update({ busy: false }); }
            }
        },
    };
}
