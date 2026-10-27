import {Alert,Button,Space,Typography} from 'antd';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {sourceAssetReady} from './archiveUpload';
import type {ISourceAsset} from './types';

/** Archive acceptance, common catalogue publication and project updates are separate steps. */
export function AssetArchiveStatus({assets,blocked,onCompleteSupply}:{assets:ISourceAsset[];blocked:boolean;onCompleteSupply:()=>void}) {
    const ready=assets.filter(sourceAssetReady).length;
    const incomplete=assets.length-ready;
    return <Alert type={incomplete?'warning':'success'} showIcon message={`Файлы готовы: ${ready} из ${assets.length}`} description={
        <Space direction="vertical" size="small" className="asset-sources__content">
            <Typography.Text>Выберите карточки ниже, чтобы добавить или обновить общий каталог.{incomplete>0&&' Для остальных карточек добавьте недостающие файлы.'}</Typography.Text>
            <Space wrap>
                {incomplete>0&&<FeatureButton features={['asset_sources']} disabled={blocked} onClick={onCompleteSupply}>Дополнить поставку архивом</FeatureButton>}
                <Button href="/store">Перейти в каталог</Button>
            </Space>
            <details>
                <summary>{incomplete?'Как дополнить архив и обновить проект':'Как обновить проект'}</summary>
                <Space direction="vertical" size="small" className="asset-sources__content">
                    <Typography.Text type="secondary">Опись архива проверена. Из архива / без сетевой дозагрузки.</Typography.Text>
                    <Typography.Text>Загрузка архива не меняет версии общего каталога и проектов.</Typography.Text>
                    {incomplete>0&&<Typography.Text>Дополнительный архив должен содержать полную опись и описания ассетов, а также недостающие файлы всех заявленных платформ и зависимостей. Уже загруженные бинарные файлы повторять не нужно.</Typography.Text>}
                    <Typography.Text>После добавления в каталог выберите проект: «Закрепить новую версию» для инструментов или «Обновить шаблон» для агентов. Установка на компьютер — отдельный шаг.</Typography.Text>
                </Space>
            </details>
        </Space>
    }/>;
}
