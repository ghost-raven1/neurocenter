import { Alert, Button, List, Space, Typography } from 'antd';
import { isAxiosError } from 'axios';
import { useRef, useState } from 'react';
import type { IProjectAsset } from '../../core/api/interfaces';
import bffApi from '../../core/api/bff';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { kindLabel } from './storeHelpers';

interface IProps { projectId: string; assets: IProjectAsset[]; canManage: boolean; onRemoved: () => Promise<void>; onRecheck: () => Promise<void>; }

/** Удаляет только назначение в каталоге; локальные файлы и данные инструмента не затрагиваются. */
export default function UnavailableProjectAssets({ projectId, assets, canManage, onRemoved, onRecheck }: IProps): JSX.Element | null {
    const { captureOwner } = useAuthRequestOwner();
    const lock = useRef(false);
    const [removing, setRemoving] = useState<string | null>(null);
    const [error, setError] = useState('');
    const remove = async (asset: IProjectAsset): Promise<void> => {
        const isCurrent = captureOwner();
        if (!isCurrent() || !canManage || lock.current) return;
        lock.current = true; setRemoving(asset.assetKind + ':' + asset.assetId); setError('');
        try {
            try {
                const result = await bffApi.removeProjectAsset(projectId, { assetId: asset.assetId, assetKind: asset.assetKind });
                if (result.ok !== true) throw new Error('Сервер не подтвердил удаление ссылки. Обновите каталог.');
            } catch (failure) {
                if (!isAxiosError(failure) || failure.response?.status !== 404) throw failure;
            }
            if (isCurrent()) await onRemoved();
        } catch (failure) {
            if (isCurrent()) setError(errorMessage(failure, 'Не удалось убрать ссылку. Обновите каталог и повторите.'));
        } finally {
            if (isCurrent()) { lock.current = false; setRemoving(null); }
        }
    };
    if (!assets.length) return null;
    return <Space direction="vertical" size={12} style={{ width: '100%', marginBottom: 20 }}>
        <Alert showIcon type="warning" message="В проекте есть недоступные инструменты"
            description={<Space direction="vertical" size={4}>
                <span>Назначения сохранены. Ниже перечислены ссылки, для которых сейчас нет доступной карточки.</span>
                {canManage ? <>
                    {assets.some(asset => asset.assetKind === 'skill') && <span>После переноса сервера восстановите файлы скиллов из резервной копии: Git их не переносит.</span>}
                    {assets.some(asset => asset.assetKind !== 'skill') && <span>Для встроенных MCP и плагинов синхронизируйте каталог на сервере. Пользовательские инструменты восстановите из копии или опубликуйте заново.</span>}
                    <span>Убирайте ссылку, если инструмент больше не нужен. Локальные файлы сохранятся.</span>
                </> : <span>Попросите администратора проверить публикацию и доступ к этим инструментам.</span>}
            </Space>}
            action={<Button disabled={removing !== null} onClick={() => { void onRecheck(); }}>Проверить снова</Button>} />
        {error && <Alert showIcon type="error" message={error} />}
        <List bordered dataSource={assets} renderItem={asset => <List.Item key={asset.assetKind + ':' + asset.assetId}
            actions={canManage ? [<Button key="remove" disabled={removing !== null} loading={removing === asset.assetKind + ':' + asset.assetId}
                aria-label={`Убрать ссылку ${asset.assetId}`} onClick={() => { void remove(asset); }}>Убрать ссылку</Button>] : []}>
            <Space direction="vertical" size={2}><Typography.Text>{kindLabel(asset.assetKind)}</Typography.Text><Typography.Text code style={{ overflowWrap: 'anywhere' }}>{asset.assetId}</Typography.Text></Space>
        </List.Item>} />
    </Space>;
}
