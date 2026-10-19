import { Alert, Button, Progress, Space, Tag, Typography } from 'antd';
import type { ICatalogModel } from './types';
import { modelHostingLabels } from './modelCatalogState';
import { useModelHosting } from './useModelHosting';

interface IProps { model: ICatalogModel; canManage: boolean; }

/** Прогресс и содержательная проверка отделены от назначения модели проекту. */
export function ModelHosting({ model, canManage }: IProps): JSX.Element {
    const { hosting, loading, busy, error, refresh, operate } = useModelHosting(model);
    const operation = hosting?.operation;
    const percent = typeof operation?.progress === 'number' ? Math.max(0, Math.min(100, operation.progress)) : undefined;
    return <Space direction="vertical" size={10} className="model-hosting">
        <Space wrap size={4}><Typography.Text strong>Хостинг</Typography.Text>
            <Tag color={hosting?.state === 'ready' ? 'blue' : hosting?.state === 'error' ? 'red' : undefined}>
                {hosting ? modelHostingLabels[hosting.state] : loading ? 'Проверяем…' : 'Не проверен'}
            </Tag>
        </Space>
        {hosting?.message && <Typography.Text type="secondary">{hosting.message}</Typography.Text>}
        {busy && <div role="status" aria-live="polite" className="model-hosting__progress">
            <Typography.Text>{operation?.message || 'Запускаем операцию…'}</Typography.Text>
            <Progress percent={percent} status="active" showInfo={percent !== undefined} />
        </div>}
        {hosting?.checkedAt && <Typography.Text type="secondary" className="model-hosting__checked">Проверено: {new Date(hosting.checkedAt).toLocaleString('ru-RU')}</Typography.Text>}
        {operation?.state === 'failed' && <Alert type="error" showIcon message="Последняя операция завершилась ошибкой" description={operation.message} />}
        {error && <Alert type="error" showIcon message={error} />}
        <Space wrap size={8}>
            {canManage && <>
                <Button disabled={busy || loading} loading={busy && operation?.action === 'start'} onClick={() => { void operate('start'); }}>Запустить</Button>
                <Button disabled={busy || loading || hosting?.state === 'missing' || hosting?.state === 'unavailable'} onClick={() => { void operate('check'); }}>Проверить модель</Button>
                <Button disabled={busy || loading || hosting?.state === 'missing' || hosting?.state === 'unavailable'} onClick={() => { void operate('stop'); }}>Выгрузить из памяти</Button>
            </>}
            <Button type="link" disabled={busy} loading={loading} onClick={() => { void refresh(); }}>Обновить статус</Button>
        </Space>
    </Space>;
}
