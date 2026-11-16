import { useEffect, useState } from 'react';
import { errorMessage } from '../../../common/utils/errorMessage';
import { useFeatureAvailability } from '../../FeatureFlags/hooks/useFeatureAvailability';
import { personalProviderApi } from '../api';
import type { IPersonalProviderView } from '../model';

export interface IProviderAccessStatus {
    view?: IPersonalProviderView;
    error: string;
    loading: boolean;
}

/**
 * Read-only статус «Мой доступ» для деталей модели (8.19 P1-2): лёгкое чтение my-access
 * без журнала и записи; ввод ключа остаётся только в ProviderAccessModal.
 */
export function useProviderAccessStatus(modelId: string, enabled: boolean): IProviderAccessStatus {
    const availability = useFeatureAvailability('personal_remote_provider_credentials');
    const [state, setState] = useState<IProviderAccessStatus>({ view: undefined, error: '', loading: enabled });
    useEffect(() => {
        if (!enabled || !availability.enabled) {
            setState({ view: undefined, error: '', loading: false });
            return;
        }
        const controller = new AbortController();
        setState({ view: undefined, error: '', loading: true });
        personalProviderApi
            .read(modelId, controller.signal)
            .then((view) => {
                setState({ view, error: '', loading: false });
            })
            .catch((cause) => {
                if (controller.signal.aborted) return;
                setState({
                    view: undefined,
                    error: errorMessage(cause, 'Не удалось проверить личный доступ к провайдеру.'),
                    loading: false,
                });
            });
        return () => controller.abort();
    }, [modelId, enabled, availability.enabled]);
    return state;
}
