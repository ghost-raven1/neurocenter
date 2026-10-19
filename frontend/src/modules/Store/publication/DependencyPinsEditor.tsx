import { Alert, Button, Select, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import bffApi from '../../../core/api/bff';
import type { IAiPlugin, IDependencyPin } from '../../../core/api/interfaces';
import { errorMessage } from '../../../common/utils/errorMessage';
import { appendDependencyPin, readDependencyPin } from './dependencyPins';

interface Props {
    value?: IDependencyPin[];
    onChange?: (value: IDependencyPin[]) => void;
    disabled?: boolean;
    ownId?: string;
    onLoadingChange?: (value: boolean) => void;
}

/** Версия выбирается пользователем; обновление каталога не заменяет уже закреплённый хэш. */
export function DependencyPinsEditor({value = [], onChange, disabled, ownId, onLoadingChange}: Props) {
    const [assets, setAssets] = useState<IAiPlugin[]>([]);
    const [catalogLoading, setCatalogLoading] = useState(true);
    const [catalogError, setCatalogError] = useState('');
    const [partialCatalog, setPartialCatalog] = useState(false);
    const [catalogPage, setCatalogPage] = useState(1);
    const [reload, setReload] = useState(0);
    const [assetId, setAssetId] = useState<string>();
    const [versions, setVersions] = useState<number[]>([]);
    const [version, setVersion] = useState<number>();
    const [versionsLoading, setVersionsLoading] = useState(false);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState('');
    const request = useRef(0);
    const active = useRef(true);
    const addingRef = useRef(false);
    useEffect(() => { active.current = true; return () => { active.current = false; request.current += 1; }; }, []);
    useEffect(() => {
        let cancelled = false;
        setCatalogLoading(true); setCatalogError('');
        void bffApi.listAiPlugins({pageSize: 100}).then(result => {
            if (cancelled) { return; }
            setAssets(result.items.filter(item => item.id !== ownId));
            setPartialCatalog(result.total > result.items.length);
            setCatalogPage(1);
        }).catch((cause: unknown) => { if (!cancelled) { setCatalogError(errorMessage(cause, 'Не удалось загрузить доступные инструменты. Уже закреплённые зависимости сохранены.')); } })
            .finally(() => { if (!cancelled) { setCatalogLoading(false); } });
        return () => { cancelled = true; };
    }, [reload, ownId]);

    const loadMore = async (): Promise<void> => {
        if (catalogLoading) { return; }
        setCatalogLoading(true); setCatalogError('');
        try {
            const nextPage = catalogPage + 1;
            const result = await bffApi.listAiPlugins({pageSize: 100, page: nextPage});
            if (!active.current) { return; }
            setAssets(previous => [...new Map([...previous, ...result.items.filter(item => item.id !== ownId)].map(item => [item.id, item])).values()]);
            setPartialCatalog(nextPage * result.size < result.total); setCatalogPage(nextPage);
        } catch (cause: unknown) { if (active.current) { setCatalogError(errorMessage(cause, 'Не удалось загрузить следующую страницу. Выбранные версии сохранены.')); } }
        finally { if (active.current) { setCatalogLoading(false); } }
    };

    const chooseAsset = (id: string): void => {
        const current = ++request.current;
        setAssetId(id); setVersion(undefined); setVersions([]); setError(''); setVersionsLoading(true);
        void bffApi.listAiPluginVersions(id).then(items => {
            if (!active.current || request.current !== current) { return; }
            setVersions([...new Set(items.map(item => item.version).filter(item => Number.isSafeInteger(item) && item > 0))].sort((a, b) => b - a));
        }).catch((cause: unknown) => { if (active.current && request.current === current) { setError(errorMessage(cause, 'Версии недоступны. Выберите инструмент снова; зависимости сохранены.')); } })
            .finally(() => { if (active.current && request.current === current) { setVersionsLoading(false); } });
    };

    const add = async (): Promise<void> => {
        const asset = assets.find(item => item.id === assetId);
        if (!asset || version === undefined || disabled || addingRef.current) { return; }
        addingRef.current = true; setAdding(true); setError(''); onLoadingChange?.(true);
        try {
            const pin = await readDependencyPin(bffApi, asset, version);
            const next = appendDependencyPin(value, pin, ownId);
            if (active.current) { onChange?.(next); setAssetId(undefined); setVersion(undefined); setVersions([]); }
        } catch (cause: unknown) { if (active.current) { setError(errorMessage(cause, 'Не удалось закрепить выбранную версию. Уже добавленные зависимости сохранены.')); } }
        finally { addingRef.current = false; if (active.current) { setAdding(false); onLoadingChange?.(false); } }
    };

    const blocked = disabled || adding;
    return <Space direction="vertical" style={{width: '100%'}}>
        <Typography.Text type="secondary">Выберите до 20 MCP или плагинов и точную версию каждого. SHA-256 закрепляется при добавлении; новые версии не подставляются автоматически.</Typography.Text>
        {catalogError && <Alert type="error" showIcon message={catalogError} action={<Button size="small" disabled={blocked} onClick={() => setReload(count => count + 1)}>Повторить</Button>} />}
        {partialCatalog && <Button disabled={blocked || catalogLoading} loading={catalogLoading} onClick={() => void loadMore()}>Загрузить ещё инструменты</Button>}
        <Select aria-label="Инструмент зависимости" style={{width: '100%'}} placeholder="Выберите MCP или плагин" value={assetId}
            showSearch optionFilterProp="label" loading={catalogLoading} disabled={blocked || catalogLoading || value.length >= 20}
            onChange={chooseAsset} options={assets.map(item => ({value: item.id, label: `${item.name} — ${item.kind === 'mcp' ? 'MCP' : 'плагин'}`}))} />
        <Space wrap>
            <Select aria-label="Версия зависимости" style={{minWidth: 180}} placeholder="Выберите версию" value={version} loading={versionsLoading}
                disabled={blocked || !assetId || versionsLoading} onChange={setVersion} options={versions.map(item => ({value: item, label: `Версия ${item}`}))}
                notFoundContent="Сохранённых версий нет" />
            <Button disabled={blocked || version === undefined || value.length >= 20} loading={adding} onClick={() => void add()}>Закрепить версию</Button>
        </Space>
        {error && <Alert type="error" showIcon role="alert" message={error} />}
        {value.map((pin, index) => <div key={`${pin.kind}:${pin.id}`} style={{border: '1px solid #d9d9d9', borderRadius: 6, padding: 10}}>
            <Space wrap style={{width: '100%', justifyContent: 'space-between'}}>
                <Typography.Text strong style={{maxWidth: '100%', overflowWrap: 'anywhere'}}>{assets.find(item => item.id === pin.id)?.name ?? pin.id} · {pin.kind === 'mcp' ? 'MCP' : 'плагин'} · версия {pin.version}</Typography.Text>
                <Button disabled={blocked} aria-label={`Убрать зависимость ${index + 1}`} onClick={() => onChange?.(value.filter((_, i) => i !== index))}>Убрать</Button>
            </Space>
            <Typography.Text style={{display: 'block', overflowWrap: 'anywhere', fontFamily: 'monospace'}}>SHA-256: {pin.manifest}</Typography.Text>
        </div>)}
    </Space>;
}
