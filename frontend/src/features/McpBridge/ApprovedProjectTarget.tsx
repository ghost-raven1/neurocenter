import { Alert, Button, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import bffApi from '../../core/api/bff';
import type { IProjectAsset } from '../../core/api/interfaces';
import { bridgeApi, type IInstallPlan } from './api';
import { approvedAdoptionTarget } from './inventoryHelpers';
import { errorMessage } from '../../common/utils/errorMessage';

interface Props {
    projectId:string; kind:string; catalog:Array<{id:string;kind:string;name:string}>; disabled:boolean;
    onChange(plan:IInstallPlan|undefined):void;
}
/** Цель выбирается явно из проектного каталога; новая head-версия никогда не подставляется автоматически. */
export function ApprovedProjectTarget({projectId,kind,catalog,disabled,onChange}: Props) {
    const [assets,setAssets] = useState<IProjectAsset[]>([]); const [asset,setAsset] = useState<IProjectAsset>();
    const [versions,setVersions] = useState<number[]>([]); const [version,setVersion] = useState<number>();
    const [plan,setPlan] = useState<IInstallPlan>(); const [loading,setLoading] = useState(false); const [error,setError] = useState('');
    const [refresh,setRefresh] = useState(0);
    useEffect(() => {
        let cancelled=false; setLoading(true);
        bffApi.listProjectAssets(projectId).then(values => { if (!cancelled) { setAssets(values.filter(item => item.assetKind === kind)); } })
            .catch(cause => { if (!cancelled) { setError(errorMessage(cause,'Не удалось прочитать проектный каталог.')); } })
            .finally(() => { if (!cancelled) { setLoading(false); } });
        return () => { cancelled=true; };
    },[projectId,kind,refresh]);
    useEffect(() => {
        if (!asset) { return; } let cancelled=false; setLoading(true); setError('');
        const request = asset.assetKind === 'skill' ? bffApi.getSkill(asset.assetId).then(value => [value.meta.version,...(value.meta.history ?? []).map(entry => entry.version)])
            : bffApi.listAiPluginVersions(asset.assetId).then(values => values.map(value => value.version));
        request.then(values => { if (!cancelled) { setVersions([...new Set(values.filter(value => Number.isSafeInteger(value) && value > 0))].sort((a,b) => b-a)); } })
            .catch(cause => { if (!cancelled) { setError(errorMessage(cause,'Не удалось прочитать точные версии.')); } })
            .finally(() => { if (!cancelled) { setLoading(false); } });
        return () => { cancelled=true; };
    },[asset,refresh]);
    useEffect(() => {
        if (!asset || !version) { return; } let cancelled=false; setLoading(true); setError('');
        bridgeApi.preparePlan({projectId,assetKind:asset.assetKind,assetId:asset.assetId,version}).then(value => {
            if (value.projectId !== projectId) { throw new Error('Одобрение относится к другому проекту.'); }
            approvedAdoptionTarget(value,{...asset,version});
            if (!cancelled) { setPlan(value); onChange(value); }
        }).catch(cause => { if (!cancelled) { setError(errorMessage(cause,'Не удалось получить одобрение точной версии.')); } })
            .finally(() => { if (!cancelled) { setLoading(false); } });
        return () => { cancelled=true; };
    },[projectId,asset,version,onChange,refresh]);
    return <Space direction="vertical" className="local-operation">
        <Select aria-label="Инструмент проектного каталога" style={{width:'100%'}} value={asset?.assetId} loading={loading} disabled={disabled}
            placeholder="Выберите инструмент из каталога проекта" onChange={id => {
                setAsset(assets.find(value => value.assetId === id)); setVersion(undefined); setVersions([]); setPlan(undefined); setError(''); onChange(undefined);
            }} options={assets.map(value => ({value:value.assetId,label:catalog.find(item => item.id === value.assetId && item.kind === value.assetKind)?.name || value.assetId}))} />
        <Select aria-label="Точная версия для принятия" style={{width:'100%'}} value={version} disabled={disabled || !asset || loading} loading={loading}
            placeholder="Выберите конкретную версию" onChange={value => { setVersion(value); setPlan(undefined); onChange(undefined); }}
            options={versions.map(value => ({value,label:`Версия ${value}`}))} />
        {plan && <><Typography.Text>Одобрена версия {plan.version}</Typography.Text><Typography.Text code className="local-operation__hash">SHA комплекта: {plan.manifest}</Typography.Text>
            {plan.packages?.map(value => <Typography.Text key={value.kind+':'+value.id} className="local-operation__hash">{value.name} · {value.kind} · версия {value.version} · {value.manifest}</Typography.Text>)}</>}
        {error && <Alert type="warning" showIcon message={error} description="Одобрение выбранной версии выполняется администратором в проектном каталоге. Автоматическое принятие недоступно."
            action={<Button disabled={disabled || loading} onClick={() => { setPlan(undefined); onChange(undefined); setRefresh(value => value+1); }}>Повторить проверку</Button>} />}
    </Space>;
}
