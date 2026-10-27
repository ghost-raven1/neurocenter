import { Alert, Button, Descriptions, InputNumber, Modal, Space, Switch, Typography } from 'antd';
import { useState } from 'react';
import type { IBridgeDevice } from './api';
import { useRuntimeCacheSettings } from './useRuntimeCacheSettings';
import { runtimeCacheMiB, runtimeCacheTargetMaxMiB } from './runtimeCacheSettingsController';
import { FeatureButton } from '../FeatureFlags/FeatureAvailability';

/** The owner changes this computer's shared cache policy; success comes from its completed receipt. */
export function RuntimeCacheSettings({device}: {device: IBridgeDevice}) {
    return device.report.capabilities?.some(capability => ['runtime-cache-policy-v1', 'runtime-cache-target-v2'].includes(capability)) ? <RuntimeCacheSettingsForm device={device} />
        : <Space direction="vertical"><Button size="small" disabled>Кэш комплектов</Button><Typography.Text type="secondary">Обновите мост, чтобы управлять кэшем комплектов.</Typography.Text></Space>;
}

function RuntimeCacheSettingsForm({device}: {device: IBridgeDevice}) {
    const [open, setOpen] = useState(false);
    const cache = useRuntimeCacheSettings(device);
    const minMiB = cache.supportsTarget ? 1 : 1024, maxMiB = cache.supportsTarget ? runtimeCacheTargetMaxMiB : 16384;
    const cleanupMinimum = cache.supportsCurrentOnly ? 0 : 1;
    const locked = cache.busy || cache.pending;
    const duplicateTerminalMessage = !!cache.job && !!cache.error && cache.error === cache.job.message && ['failed', 'cancelled'].includes(cache.job.state);
    return <>
        <Button size="small" onClick={() => {setOpen(true); if (!cache.status && !cache.pending && !cache.reason) void cache.inspect();}}>Кэш комплектов</Button>
        {open && <Modal open title={`Кэш комплектов: ${device.name}`} footer={null} onCancel={() => setOpen(false)}>
            <Space direction="vertical" size="middle">
                <Typography.Paragraph>{cache.supportsTarget
                    ? 'Кэш общий для всех проектов на этом компьютере. Превышение целевого объёма не останавливает обновления и не удаляет сохранённые комплекты. Для обновления нужно свободное место на диске; оно проверяется отдельно.'
                    : 'Кэш общий для всех проектов на этом компьютере. Изменение лимита не удаляет сохранённые комплекты. Свободное место на диске проверяется отдельно.'}</Typography.Paragraph>
                {cache.status ? <Descriptions size="small" column={1}>
                    <Descriptions.Item label="Занято">{(cache.status.usedBytes / runtimeCacheMiB).toLocaleString('ru-RU', {maximumFractionDigits: 1})} МиБ</Descriptions.Item>
                    <Descriptions.Item label={cache.supportsTarget ? 'Действующий целевой объём' : 'Действующий лимит'}>{cache.status.limitBytes / runtimeCacheMiB} МиБ</Descriptions.Item>
                    <Descriptions.Item label="Проверено">{new Date(cache.status.observedAt).toLocaleString('ru-RU')}</Descriptions.Item>
                </Descriptions> : <Typography.Text type="secondary">{cache.supportsTarget
                    ? 'Обновите данные, чтобы получить текущий целевой объём и размер кэша. Целевой объём по умолчанию — 2048 МиБ.'
                    : 'Обновите данные, чтобы получить текущий лимит и размер кэша. Лимит по умолчанию — 2048 МиБ.'}</Typography.Text>}
                {cache.supportsTarget && cache.status && cache.status.usedBytes > cache.status.limitBytes
                    && <Alert type="info" showIcon message="Кэш превышает целевой объём" description="Обновления доступны, если на диске достаточно свободного места." />}
                <Space direction="vertical">
                    <label htmlFor={`runtime-cache-limit-${device.id}`}>{cache.supportsTarget ? 'Целевой объём кэша, МиБ' : 'Лимит кэша, МиБ'}</label>
                    <InputNumber id={`runtime-cache-limit-${device.id}`} min={minMiB} max={maxMiB} step={1} precision={0}
                        value={cache.draftMiB} disabled={locked || !!cache.setReason} onChange={value => cache.edit(value)} />
                    <Typography.Text type="secondary">{cache.supportsTarget ? 'Положительное целое число МиБ.' : 'Целое число от 1024 до 16384 МиБ.'}</Typography.Text>
                </Space>
                <Space wrap>
                    <Button loading={cache.busy && cache.intent?.request.runtimeCachePolicy.action === 'inspect'} disabled={locked || !!cache.reason} onClick={() => {void cache.inspect();}}>Обновить данные</Button>
                    <FeatureButton features={['computer_connections']} type="primary" loading={cache.busy && cache.intent?.request.runtimeCachePolicy.action === 'set'}
                        disabled={locked || !!cache.setReason || !cache.status || !Number.isSafeInteger(cache.draftMiB) || cache.draftMiB! < minMiB || cache.draftMiB! > maxMiB}
                        onClick={() => {void cache.set();}}>{cache.supportsTarget ? 'Сохранить целевой объём' : 'Сохранить лимит'}</FeatureButton>
                </Space>
                {cache.setReason && <Alert type="info" showIcon message={cache.setReason} />}
                {cache.supportsCleanup ? <Space direction="vertical">
                    <Typography.Title level={5}>Копии после обновления моста</Typography.Title>
                    <Typography.Paragraph>После успешного обновления удаляются проверенные неиспользуемые копии моста. Ручные изменения и копии восстановления сохраняются. Кэш комплектов настраивается отдельно.</Typography.Paragraph>
                    <Typography.Text type="secondary">{cache.supportsCurrentOnly
                        ? 'Чтобы хранить только актуальный мост, укажите 0 предыдущих копий и 0 дней ожидания.'
                        : 'Обновите мост, чтобы хранить только актуальную версию; прежний мост сохраняет минимум одну копию на один день.'}</Typography.Text>
                    <Space><Switch aria-label="Автоочистка копий обновления" checked={cache.cleanupDraft.enabled}
                        disabled={locked || !!cache.reason || !cache.cleanupDraft.enabled && !!cache.cleanupReason}
                        onChange={enabled => {if (!enabled || !cache.cleanupReason) cache.editCleanup({enabled});}} />Автоочистка копий обновления</Space>
                    <label htmlFor={`bridge-cleanup-count-${device.id}`}>Сколько предыдущих копий хранить</label>
                    <InputNumber id={`bridge-cleanup-count-${device.id}`} min={cleanupMinimum} max={10} step={1} precision={0}
                        value={cache.cleanupDraft.keepPrevious} disabled={locked || !!cache.reason} onChange={keepPrevious => cache.editCleanup({keepPrevious})} />
                    <label htmlFor={`bridge-cleanup-age-${device.id}`}>Не удалять копии моложе, дней</label>
                    <InputNumber id={`bridge-cleanup-age-${device.id}`} min={cleanupMinimum} max={90} step={1} precision={0}
                        value={cache.cleanupDraft.minAgeDays} disabled={locked || !!cache.reason} onChange={minAgeDays => cache.editCleanup({minAgeDays})} />
                    <Button loading={cache.busy && cache.intent?.request.runtimeCachePolicy.action === 'set-cleanup'}
                        disabled={locked || !!cache.reason || cache.cleanupDraft.enabled && !!cache.cleanupReason || !cache.cleanupPolicy
                            || !Number.isInteger(cache.cleanupDraft.keepPrevious) || cache.cleanupDraft.keepPrevious! < cleanupMinimum || cache.cleanupDraft.keepPrevious! > 10
                            || !Number.isInteger(cache.cleanupDraft.minAgeDays) || cache.cleanupDraft.minAgeDays! < cleanupMinimum || cache.cleanupDraft.minAgeDays! > 90}
                        onClick={() => {void cache.setCleanup();}}>Сохранить хранение копий</Button>
                    {cache.cleanupReason && !cache.reason && <Alert type="info" showIcon message={cache.cleanupReason} description="Выключить автоочистку можно и при недоступности функции." />}
                </Space> : <Typography.Text type="secondary">Обновите мост, чтобы настроить хранение копий обновления.</Typography.Text>}
                {cache.job && !duplicateTerminalMessage && <Alert role="status" type={cache.job.state === 'succeeded' && !cache.error ? 'success' : cache.job.state === 'failed' ? 'warning' : 'info'} showIcon
                    message={cache.job.state === 'succeeded' && !cache.error ? 'Компьютер подтвердил настройки' : cache.job.message} />}
                {cache.error && <Alert role="alert" type="error" showIcon message={cache.error} />}
                {cache.pending && <Space direction="vertical"><Typography.Text>Запрос сохранён. Новое изменение станет доступно после подтверждения результата.</Typography.Text>
                    <Button loading={cache.busy} disabled={cache.busy || !cache.canRecover} onClick={() => {void cache.recover();}}>Проверить сохранённый запрос</Button></Space>}
            </Space>
        </Modal>}
    </>;
}
