import type { ReactNode } from 'react';
import {Button,Card,Space,Tag,Typography} from 'antd';
import type {ISourceAsset} from './types';

/** Локальный ассет уже опубликован: переход не создаёт повторный source-import. */
export function assetCatalogLink(asset:ISourceAsset):string {
    const params=new URLSearchParams({q:asset.imported?.name??asset.name});
    if(asset.kind==='model'||asset.kind==='agent'){params.set('tab',asset.kind==='model'?'models':'agents');}
    return '/store?'+params.toString();
}

/** Сохранённые упаковки доступны независимо от состояния внешнего репозитория. */
export function LocalAssetCards({assets,actions}:{assets:ISourceAsset[];actions(asset:ISourceAsset):ReactNode}):JSX.Element|null {
    if(!assets.length){return null;}
    return <section aria-label="Упакованные на этой площадке">
        <Typography.Title level={3}>Упакованные на этой площадке</Typography.Title>
        <Typography.Paragraph type="secondary">Эти ассеты уже добавлены в общий каталог. Они сохраняются на этой площадке и доступны без обновления внешнего источника.</Typography.Paragraph>
        <div className="asset-sources__grid">{assets.map(asset=><Card key={asset.id} size="small" title={asset.imported?.name??asset.name} className="asset-sources__card">
            <Space direction="vertical" className="asset-sources__content">
                <Space wrap><Tag>Локальная упаковка</Tag><Typography.Text type="secondary">{asset.version} · {asset.license}</Typography.Text></Space>
                <Typography.Paragraph>{asset.description||'Описание не добавлено в ассет.'}</Typography.Paragraph>
                <Typography.Text type={asset.imported?.unavailable?'warning':'secondary'}>{asset.imported?.unavailable?'Карточка временно недоступна. Обновите список после восстановления соединения.':asset.imported?.archived?'Карточка в архиве. Её можно вернуть в каталог.':'Доступен в общем каталоге'}</Typography.Text>
                <Space wrap><Button href={assetCatalogLink(asset)} disabled={asset.imported?.archived||asset.imported?.unavailable}>Открыть в каталоге</Button>{actions(asset)}</Space>
            </Space>
        </Card>)}</div>
    </section>;
}
