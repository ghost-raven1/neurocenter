import { useCallback, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';

import { errorMessage } from '../../../common/utils/errorMessage';
import bffApi from '../../../core/api/bff';
import type { IProjectAsset } from '../../../core/api/interfaces';
import { useSectionUpdates } from '../../../core/socket/hooks/useSectionUpdates';

export interface IMultiProjectCatalogEntry {
    assets: IProjectAsset[];
    ready: boolean;
    error: string;
}

/**
 * Закреплённые каталоги набора проектов одним чтением: каждый проект читается независимо,
 * отказ одного не держит остальные. Смена состава или прав сразу скрывает прежние данные,
 * автоперечитывание — те же разделы, что у каталога проекта.
 */
export function useMultiProjectCatalog(projectIds: readonly string[], accessScope: string) {
    const key = JSON.stringify([accessScope, projectIds]);
    const current = useRef(key);
    current.current = key;
    const idsRef = useRef(projectIds);
    idsRef.current = projectIds;
    const [entries, setEntries] = useState<Record<string, IMultiProjectCatalogEntry>>({});
    const [loading, setLoading] = useState(false);
    const [ready, setReady] = useState(false);
    const refresh = useCallback(async (): Promise<void> => {
        const scope = current.current;
        const ids = idsRef.current;
        if (!ids.length) return;
        setLoading(true);
        const results = await Promise.allSettled(ids.map((id) => bffApi.projectCatalog(id)));
        if (current.current !== scope) return;
        const next: Record<string, IMultiProjectCatalogEntry> = {};
        results.forEach((result, index) => {
            const id = ids[index];
            if (result.status === 'fulfilled') {
                next[id] = { assets: result.value, ready: true, error: '' };
                return;
            }
            const status = isAxiosError(result.reason) ? result.reason.response?.status : undefined;
            const denied = status === 401 || status === 403 || status === 404;
            next[id] = {
                assets: denied ? [] : (next[id]?.assets ?? []),
                ready: false,
                error: errorMessage(result.reason, 'Не удалось прочитать каталог проекта. Повторите загрузку.'),
            };
        });
        setEntries(next);
        setLoading(false);
        setReady(true);
    }, []);
    useEffect(() => {
        setEntries({});
        setReady(false);
        if (!idsRef.current.length) return;
        setLoading(true);
        void refresh();
    }, [key, refresh]);
    useSectionUpdates(
        ['catalog', 'projects', 'access'],
        () => {
            if (idsRef.current.length) void refresh();
        },
        projectIds.length > 0,
    );
    return { entries, loading, ready, refresh };
}
