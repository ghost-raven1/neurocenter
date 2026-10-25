import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../../../features/UserBlock/useAuthRequestOwner';
import {modelCatalogApi} from '../../../features/ModelCatalog/api';
import {requireModelCatalog} from '../../../features/ModelCatalog/modelCatalogState';
import type {ICatalogModel} from '../../../features/ModelCatalog/types';
import {packagingAgentModelAvailable} from './packagingAgent';
import type {ToolBuildAgent} from './types';

/** Listing is read-only and lazy; model calls begin only with explicit build submission. */
export function usePackagingAgent(scope: string, active: boolean, enabled: boolean, locked: boolean) {
    const {captureOwner} = useAuthRequestOwner();
    const [checked, setChecked] = useState(false), [selection, setSelection] = useState<ToolBuildAgent>();
    const [models, setModels] = useState<ICatalogModel[]>([]), [loading, setLoading] = useState(false);
    const [error, setError] = useState(''), [revision, setRevision] = useState(0);
    const context = useRef({scope, captureOwner});
    if (context.current.scope !== scope || context.current.captureOwner !== captureOwner) context.current = {scope, captureOwner};
    const view = context.current;
    const initialized = useRef<typeof view>();
    const currentContext = useRef({view, active, enabled, checked, locked}); currentContext.current = {view, active, enabled, checked, locked};
    const owned = useRef(view); // A selection belongs to one authenticated scope.
    const ownsSelection = owned.current === view;
    useEffect(() => {
        owned.current = view; setChecked(false); setSelection(undefined); setModels([]); setError('');
    }, [view]);
    useEffect(() => {
        if (!active || !enabled || !checked || locked || !ownsSelection) return;
        let closed = false;
        const owns = captureOwner(), current = () => !closed && owns() && currentContext.current.view === view
            && currentContext.current.active && currentContext.current.enabled && currentContext.current.checked && !currentContext.current.locked;
        setLoading(true); setError(''); setModels([]);
        void modelCatalogApi.list().then(value => {
            const catalog = requireModelCatalog(value);
            if (current()) {
                const available = catalog.items.filter(packagingAgentModelAvailable);
                setModels(available);
                if (initialized.current !== view && available.length) {
                    initialized.current = view;
                    setSelection({modelId: available[0].id, expectedModelPin: available[0].modelPin!, maxAttempts: 3});
                }
            }
        }).catch(cause => { if (current()) setError(errorMessage(cause, 'Не удалось загрузить модели. Повторите проверку или выключите помощь Упаковщика.')); })
            .finally(() => { if (current()) setLoading(false); });
        return () => { closed = true; };
    }, [active, enabled, checked, locked, captureOwner, view, revision, ownsSelection]);
    const selected = ownsSelection ? selection : undefined;
    const model = models.find(item => item.id === selected?.modelId && item.modelPin === selected?.expectedModelPin);
    const blocker = !enabled ? 'Помощь Упаковщика сейчас выключена. Сохранённый выбор остаётся в форме.'
        : loading ? 'Проверяем доступные модели…' : error || (!models.length ? 'Нет доступных проверенных чат-моделей. Подключите и проверьте модель в общем каталоге моделей, затем нажмите «Проверить модели».' : !selected ? 'Выберите проверенную чат-модель.' : !model ? 'Выбранная версия модели недоступна. Проверьте список и выберите модель снова.' : '');
    const canEdit = (): boolean => currentContext.current.view === view && currentContext.current.active && !currentContext.current.locked && captureOwner()();
    return {
        checked: ownsSelection && checked, selection: selected, models, loading, error, blocker,
        setChecked: (value: boolean) => {if (canEdit() && (!value || currentContext.current.enabled)) setChecked(value);},
        refresh: () => {if (canEdit() && currentContext.current.enabled) setRevision(value => value + 1);},
        choose: (id: string) => {const next = models.find(item => item.id === id); if (canEdit() && currentContext.current.enabled && next && packagingAgentModelAvailable(next)) {initialized.current = view; setSelection({modelId: next.id, expectedModelPin: next.modelPin!, maxAttempts: 3});}},
        restore: (value?: ToolBuildAgent) => {initialized.current = view; owned.current = view; setChecked(!!value); setSelection(value);},
        clear: () => {initialized.current = undefined; setChecked(false); setSelection(undefined);},
    };
}
