import { Alert, Button, Descriptions, InputNumber, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import type { IBridgeDevice } from './api';
import { useRuntimeCacheSettings } from './useRuntimeCacheSettings';
import { runtimeCacheMiB } from './runtimeCacheSettingsController';
import { FeatureButton } from '../FeatureFlags/FeatureAvailability';

/** The owner explicitly changes this computer's shared budget; success comes from its completed receipt. */
export function RuntimeCacheSettings({device}: {device: IBridgeDevice}) {
    return device.report.capabilities?.includes('runtime-cache-policy-v1') ? <RuntimeCacheSettingsForm device={device} />
        : <Space direction="vertical"><Button size="small" disabled>Кэш комплектов</Button><Typography.Text type="secondary">Обновите мост, чтобы управлять кэшем комплектов.</Typography.Text></Space>;
}

function RuntimeCacheSettingsForm({device}: {device: IBridgeDevice}) {
    const [open, setOpen] = useState(false);
    const cache = useRuntimeCacheSettings(device);
    const locked = cache.busy || cache.pending;
    return <>
        <Button size="small" onClick={() => {setOpen(true); if (!cache.status && !cache.pending && !cache.reason) void cache.inspect();}}>Кэш комплектов</Button>
        {open && <Modal open title={`Кэш комплектов: ${device.name}`} footer={null} onCancel={() => setOpen(false)}>
            <Space direction="vertical" size="middle">
                <Typography.Paragraph>Кэш общий для всех проектов на этом компьютере. Изменение лимита не удаляет сохранённые комплекты. Свободное место на диске проверяется отдельно.</Typography.Paragraph>
                {cache.status ? <Descriptions size="small" column={1}>
                    <Descriptions.Item label="Занято">{(cache.status.usedBytes / runtimeCacheMiB).toLocaleString('ru-RU', {maximumFractionDigits: 1})} МиБ</Descriptions.Item>
                    <Descriptions.Item label="Действующий лимит">{cache.status.limitBytes / runtimeCacheMiB} МиБ</Descriptions.Item>
                    <Descriptions.Item label="Проверено">{new Date(cache.status.observedAt).toLocaleString('ru-RU')}</Descriptions.Item>
                </Descriptions> : <Typography.Text type="secondary">Обновите данные, чтобы получить текущий лимит и размер кэша. Лимит по умолчанию — 2048 МиБ.</Typography.Text>}
                <Space direction="vertical">
                    <label htmlFor={`runtime-cache-limit-${device.id}`}>Лимит кэша, МиБ</label>
                    <InputNumber id={`runtime-cache-limit-${device.id}`} min={1024} max={16384} step={1} precision={0}
                        value={cache.draftMiB} disabled={locked || !!cache.setReason} onChange={value => cache.edit(value)} />
                    <Typography.Text type="secondary">Целое число от 1024 до 16384 МиБ.</Typography.Text>
                </Space>
                <Space wrap>
                    <Button loading={cache.busy && cache.intent?.request.runtimeCachePolicy.action === 'inspect'} disabled={locked || !!cache.reason} onClick={() => {void cache.inspect();}}>Обновить данные</Button>
                    <FeatureButton features={['computer_connections']} type="primary" loading={cache.busy && cache.intent?.request.runtimeCachePolicy.action === 'set'}
                        disabled={locked || !!cache.setReason || !cache.status || !Number.isInteger(cache.draftMiB) || cache.draftMiB! < 1024 || cache.draftMiB! > 16384}
                        onClick={() => {void cache.set();}}>Сохранить лимит</FeatureButton>
                </Space>
                {cache.setReason && <Alert type="info" showIcon message={cache.setReason} />}
                {cache.job && <Alert role="status" type={cache.job.state === 'succeeded' && !cache.error ? 'success' : cache.job.state === 'failed' ? 'warning' : 'info'} showIcon
                    message={cache.job.state === 'succeeded' && !cache.error ? 'Компьютер подтвердил настройки кэша' : cache.job.message} />}
                {cache.error && <Alert role="alert" type="error" showIcon message={cache.error} />}
                {cache.pending && <Space direction="vertical"><Typography.Text>Запрос сохранён. Новое изменение станет доступно после подтверждения результата.</Typography.Text>
                    <Button loading={cache.busy} disabled={cache.busy || !cache.canRecover} onClick={() => {void cache.recover();}}>Проверить сохранённый запрос</Button></Space>}
            </Space>
        </Modal>}
    </>;
}
