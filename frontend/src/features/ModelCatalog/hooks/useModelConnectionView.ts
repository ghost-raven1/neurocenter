import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../common/utils/errorMessage';
import { useSectionUpdates } from '../../../core/socket/hooks/useSectionUpdates';
import { useAuthRequestOwner } from '../../UserBlock/hooks/useAuthRequestOwner';
import { modelCatalogApi } from '../api';
import type { IRemoteConnection } from '../interfaces';

/**
 * Общий адрес провайдера читает только главный администратор (8.19 P2-1):
 * повторное чтение идёт по событию каталога, без опроса — авто-проверка (P2-3)
 * публикует изменение через section:changed и вид подтягивается сам.
 */
export function useModelConnectionView(modelId: string, enabled: boolean) {
    const { captureOwner } = useAuthRequestOwner();
    const [view, setView] = useState<IRemoteConnection | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const generation = useRef(0);
    const refresh = useCallback(async (): Promise<void> => {
        const owns = captureOwner();
        if (!owns()) return;
        const request = ++generation.current;
        const current = (): boolean => owns() && request === generation.current;
        setLoading(true);
        try {
            const value = await modelCatalogApi.connection(modelId);
            if (current()) {
                setView(value);
                setError('');
            }
        } catch (cause) {
            if (current()) setError(errorMessage(cause, 'Не удалось прочитать настройку подключения.'));
        } finally {
            if (current()) setLoading(false);
        }
    }, [modelId, captureOwner]);
    useEffect(() => {
        generation.current++;
        setView(null);
        setError('');
        if (!enabled) {
            setLoading(false);
            return;
        }
        void refresh();
    }, [refresh, enabled]);
    useSectionUpdates(
        ['catalog'],
        () => {
            void refresh();
        },
        enabled,
    );
    return { view, loading, error, refresh };
}
