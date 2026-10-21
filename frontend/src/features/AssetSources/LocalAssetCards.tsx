import type { ReactNode } from 'react';
import {Button,Card,Input,Space,Tag,Typography} from 'antd';
import type {ISourceAsset} from './types';

/** Локальный ассет уже опубликован: переход не создаёт повторный source-import. */
export function assetCatalogLink(asset:ISourceAsset):string {
    const params=new URLSearchParams({q:asset.imported?.name??asset.name});
    if(asset.kind==='model'||asset.kind==='agent'){params.set('tab',asset.kind==='model'?'models':'agents');}
    return '/store?'+params.toString();
}

/** Generated build identities stay available without obscuring the human card metadata. */
function LocalAssetMetadata({asset}:{asset:ISourceAsset}):JSX.Element {
    const generated=/^build-[a-f0-9]{16,}$/i.test(asset.version);
    const license=asset.license&&asset.license!=='NOASSERTION'?asset.license:undefined;
    return <>
        <Space wrap size={[6,4]}><Tag>Локальная упаковка</Tag>{!generated&&<Typography.Text type="secondary">Версия {asset.version}</Typography.Text>}{license&&<Typography.Text type="secondary">{license}</Typography.Text>}</Space>
        {(generated||!license)&&<details className="asset-sources__local-metadata"><summary>Сведения о сборке</summary><dl>
            <div><dt>{generated?'ID сборки':'Версия'}</dt><dd>{asset.version}</dd></div><div><dt>Лицензия</dt><dd>{license??'Не указана автором'}</dd></div>
        </dl></details>}
    </>;
}

/** Сохранённые упаковки доступны независимо от состояния внешнего репозитория. */
export function LocalAssetCards({assets,actions,query,onQuery,total}:{assets:ISourceAsset[];actions(asset:ISourceAsset):ReactNode;query?:string;onQuery?:(value:string)=>void;total?:number}):JSX.Element|null {
    if(!assets.length&&!onQuery){return null;}
    return <section aria-label="Упакованные на этой площадке">
        <Typography.Title level={3}>Упакованные на этой площадке</Typography.Title>
        <Typography.Paragraph type="secondary">Уже в общем каталоге · {total??assets.length}. Доступны без обновления внешнего источника.</Typography.Paragraph>
        {onQuery&&<div className="asset-sources__section-toolbar"><Input.Search aria-label="Поиск локальных упаковок" value={query??''} onChange={event=>onQuery(event.target.value)} placeholder="Найти среди локальных упаковок" allowClear/></div>}
        {!assets.length&&<Typography.Paragraph type="secondary">Локальных упаковок по этому запросу нет.</Typography.Paragraph>}
        <div className="asset-sources__grid">{assets.map(asset=><Card key={asset.id} size="small" title={asset.imported?.name??asset.name} className="asset-sources__card asset-sources__card_local">
            <div className="asset-sources__card-content">
                <LocalAssetMetadata asset={asset}/>
                <Typography.Paragraph>{asset.description||'Описание не добавлено в ассет.'}</Typography.Paragraph>
                <Typography.Text type={asset.imported?.unavailable?'warning':'secondary'}>{asset.imported?.unavailable?'Карточка временно недоступна. Обновите список после восстановления соединения.':asset.imported?.archived?'Карточка в архиве. Её можно вернуть в каталог.':'Доступен в общем каталоге'}</Typography.Text>
                <div className="asset-sources__card-actions"><Button href={assetCatalogLink(asset)} disabled={asset.imported?.archived||asset.imported?.unavailable}>Открыть в каталоге</Button>{actions(asset)}</div>
            </div>
        </Card>)}</div>
    </section>;
}
