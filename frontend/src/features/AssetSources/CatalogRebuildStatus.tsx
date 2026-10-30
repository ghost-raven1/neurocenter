import {Space,Tag,Typography} from 'antd';
import type {IBundledSourcePlan,ICatalogRebuild,ICatalogRebuildItem} from './types';
import './CatalogRebuildStatus.less';

const itemLabels:Record<ICatalogRebuildItem['state'],string>={ready:'Готово',pending:'В работе',attention:'Требует внимания','archive-required':'Нужен архив'};

/** A single compact receipt keeps detailed package outcomes available even when preparation is disabled. */
export function CatalogRebuildStatus({rebuild,error}:{rebuild?:ICatalogRebuild;error?:string}):JSX.Element|null{
    if(!rebuild&&!error)return null;
    const waiting=rebuild?.state==='preparing'&&rebuild.items.length===0;
    const title=waiting?'Ожидаем проверки запроса':rebuild?.state==='ready'?'Пакеты каталога подготовлены':rebuild?.state==='attention'?'Обновление пакетов требует внимания':'Пакеты каталога обновляются';
    return <section className="catalog-rebuild-status" aria-label="Обновление встроенных пакетов">
        <Space wrap><Typography.Text strong role="status">{rebuild?title:'Сведения об исходниках'}</Typography.Text><Typography.Link href="/operations">Операции</Typography.Link></Space>
        {error&&<Typography.Text type="warning">{error}</Typography.Text>}
        {rebuild&&<details><summary>{rebuild.items.length?`Результаты · ${rebuild.items.filter(item=>item.state==='ready').length} из ${rebuild.items.length} готовы`:waiting?'Что дальше':'Подробности'}</summary>
            {rebuild.message&&<Typography.Paragraph>{rebuild.message}</Typography.Paragraph>}
            <ul>{rebuild.items.map(item=><li key={item.id}><Space wrap><Typography.Text strong>{item.name}</Typography.Text><Tag color={item.state==='attention'?'gold':item.state==='ready'?'green':undefined}>{itemLabels[item.state]}</Tag></Space><Typography.Paragraph type="secondary">{item.message}</Typography.Paragraph></li>)}</ul>
            <Typography.Text type="secondary">Источник {rebuild.sourceRevision.slice(0,12)} · {new Date(rebuild.updatedAt).toLocaleString('ru-RU')}. Установки на компьютерах проверяются отдельно.</Typography.Text>
        </details>}
    </section>;
}

/** An unpublished recipe may exist even when the project's pin equals the current old catalog head. */
export function CatalogSourceUpdateHint({plan}:{plan:IBundledSourcePlan}):JSX.Element{
    return <div className="catalog-source-update" role="status"><Typography.Text type="warning">Доступны исходники {plan.sourceRevision}; пакет ещё не опубликован.</Typography.Text><Typography.Link href="/assets">Открыть исходники</Typography.Link></div>;
}
