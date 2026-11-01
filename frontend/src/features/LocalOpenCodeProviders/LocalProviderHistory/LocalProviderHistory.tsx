import { Button } from 'antd';
import {
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as OPEN,
} from '@neurocenter/opencode-local-providers';
import { terminal } from '../model';
import type { ILocalProviderHistoryProps } from './interfaces';
/** History and cancellation use the selected adapter's journal, independently of creation flags. */
export function LocalProviderHistory({ value }: ILocalProviderHistoryProps): JSX.Element {
    const { state, controller, canOpen, canRead } = value;
    return (
        <>
            <details>
                <summary>История и восстановление</summary>
                <Button disabled={state?.busy} onClick={() => void controller.refresh()}>
                    Обновить историю
                </Button>
            </details>
            {state?.replayKinds.map((kind) => (
                <Button
                    key={kind}
                    disabled={state.busy || (kind === OPEN ? !canOpen : !canRead)}
                    onClick={() => void controller.replay(kind)}
                >
                    Повторить тот же запрос: {kind === OPEN ? 'открытие окна' : 'чтение'}
                </Button>
            ))}
            {([READ, OPEN] as const).map(
                (kind) =>
                    state?.jobs[kind] &&
                    !terminal(state.jobs[kind]) && (
                        <Button
                            key={kind}
                            danger
                            disabled={state.busy || !canRead}
                            onClick={() => void controller.cancel(kind)}
                        >
                            Отменить {kind === OPEN ? 'открытие' : 'чтение'}
                        </Button>
                    ),
            )}
        </>
    );
}
