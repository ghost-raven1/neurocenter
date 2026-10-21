import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Progress, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, LoadingOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ICatalogModel } from './types';
import { modelHostingLabels } from './modelCatalogState';
import { useModelHosting } from './useModelHosting';

interface IProps { model: ICatalogModel; canManage: boolean; compact?: boolean; onManage?: () => void; }

/** Прогресс и содержательная проверка отделены от назначения модели проекту. */
export function ModelHosting({ model, canManage, compact, onManage }: IProps): JSX.Element {
    const { hosting, loading, busy, error, refresh, operate } = useModelHosting(model);
    const operation = hosting?.operation;
    const remote = model.runtime !== 'ollama';
    const label = hosting ? remote && hosting.state === 'stopped' ? 'Не проверена' : remote && hosting.state === 'error' ? 'Ошибка подключения' : modelHostingLabels[hosting.state] : loading ? 'Проверяем…' : 'Не проверен';
    const percent = typeof operation?.progress === 'number' ? Math.max(0, Math.min(100, operation.progress)) : undefined;
    if (compact) {
        const state = hosting?.state;
        const StatusIcon = loading || busy ? LoadingOutlined : state === 'ready' ? CheckCircleOutlined : state === 'missing' || state === 'stopped' ? ClockCircleOutlined : ExclamationCircleOutlined;
        const message = error || operation?.state === 'failed' && operation.message || hosting?.message;
        return <div className={`model-runtime model-runtime_${state || 'unknown'}`}>
            <div className="model-runtime__summary"><span title={message || undefined}><StatusIcon aria-hidden="true" />
                {loading ? 'Проверяем подключение…' : hosting ? label : 'Статус не проверен'}</span>
                <Button type="text" size="small" icon={<ReloadOutlined />} loading={loading} disabled={busy} aria-label={`Обновить статус модели ${model.name}`}
                    onClick={() => { void refresh(); }} />
            </div>
            {busy && <div role="status" aria-live="polite" className="model-runtime__progress"><span>{operation?.message || 'Выполняем действие…'}</span><Progress size="small" percent={percent} status="active" showInfo={percent !== undefined} /></div>}
            {(error || operation?.state === 'failed') && <div role="alert" className="model-runtime__error">{message}</div>}
            {!error && operation?.state !== 'failed' && (state === 'unavailable' || state === 'error') && message && <div className="model-runtime__reason">{message}</div>}
            {canManage && !busy && !remote && (state === 'missing' || state === 'stopped') && <FeatureButton features={['model_hosting']} size="small" onClick={() => { void operate('start'); }}>{state === 'missing' ? 'Подготовить модель' : 'Запустить'}</FeatureButton>}
            {canManage && !busy && remote && state === 'stopped' && <FeatureButton features={['model_hosting']} size="small" onClick={() => { void operate('check'); }}>Проверить подключение</FeatureButton>}
            {canManage && !busy && !remote && state === 'error' && onManage && <FeatureButton features={['model_catalog']} size="small" onClick={onManage}>Проверить подключение</FeatureButton>}
        </div>;
    }
    return <Space direction="vertical" size={10} className="model-hosting">
        <Space wrap size={4}><Typography.Text strong>{remote ? 'Подключение API' : 'Хостинг'}</Typography.Text>
            <Tag color={hosting?.state === 'ready' ? 'blue' : hosting?.state === 'error' ? 'red' : undefined}>
                {label}
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
            {canManage && remote && <><FeatureButton features={['model_hosting']} type="primary" disabled={busy || loading} onClick={() => { void operate('check'); }}>Проверить подключение</FeatureButton>
                {onManage && <FeatureButton features={['model_catalog']} disabled={busy || loading} onClick={onManage}>Настроить API</FeatureButton>}</>}
            {canManage && !remote && hosting?.state !== 'unavailable' && <>
                <FeatureButton features={['model_hosting']} disabled={busy || loading} loading={busy && operation?.action === 'start'} onClick={() => { void operate('start'); }}>Запустить</FeatureButton>
                <FeatureButton features={['model_hosting']} disabled={busy || loading || hosting?.state === 'missing'} onClick={() => { void operate('check'); }}>Проверить модель</FeatureButton>
                <Button disabled={busy || loading || hosting?.state === 'missing'} onClick={() => { void operate('stop'); }}>Выгрузить из памяти</Button>
            </>}
            <Button type="link" disabled={busy} loading={loading} onClick={() => { void refresh(); }}>Обновить статус</Button>
        </Space>
    </Space>;
}
