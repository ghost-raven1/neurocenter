import { Alert, Button, List, Modal, Space, Spin, Switch, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import baseApi from '../../core/api/base';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { modelCatalogApi } from './api';
import { RemoteConnectionModal } from './RemoteConnectionModal';
import type { ICatalogModel } from './types';
import {FeatureAvailabilityNotice,FeatureButton,useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';

interface Source {scope:'global'|'project';projectId: string|null;projectName:string|null; provider: string; configKey: string; modelId: string | null; name: string | null; state: 'present' | 'disabled' | 'missing' | 'blocked'; credentialStatus: 'not-needed' | 'pending' | 'transferred' | 'unavailable' | 'manual'; contextWindow: number | null; outputTokenLimit: number | null; assigned: boolean; needsCheck: boolean; hasServerKey: boolean; revoked: boolean; archivedAt: string | null }
interface Settings { revision: number; enabled: boolean; transferCredentials: boolean; canTransferCredentials: boolean; sources: Source[] }
const stateLabel = { present: 'В конфигурации', disabled: 'Провайдер отключён', missing: 'Удалена из конфигурации', blocked: 'Нужна ручная настройка' };
const credentialLabel = { 'not-needed': '', pending: 'Нужен ключ на сервере', transferred: 'Ключ сохранён на сервере', unavailable: 'Перенос ключа недоступен', manual: 'Сохранено существующее подключение' };

/** Consent belongs to one owned computer; neither keys nor arbitrary provider configuration reach this form. */
export function OpenCodeModelSyncSettings({ deviceId, supported }: { deviceId: string; supported: boolean }): JSX.Element | null {
    const isMain = useSelector((state: RootState) => state.userBlock.user?.activeRole === 'Главный админ');
    const { captureOwner } = useAuthRequestOwner();
    const availability=useFeatureAvailability('opencode_model_sync');
    const [open, setOpen] = useState(false), [settings, setSettings] = useState<Settings>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [connection, setConnection] = useState<ICatalogModel>();
    const [notice, setNotice] = useState('');
    const lock = useRef(false);
    const path = '/api/devices/' + encodeURIComponent(deviceId) + '/opencode-model-sync';
    const load = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try { const { data } = await baseApi.get<Settings>(path); if (owns()) setSettings(data); }
        catch (cause) { if (owns()) setError(errorMessage(cause, 'Не удалось получить настройки моделей.')); }
        finally { lock.current = false; if (owns()) setBusy(false); }
    };
    const save = async (patch: Partial<Pick<Settings, 'enabled' | 'transferCredentials'>>): Promise<void> => {
        if(!availability.enabled&&(patch.enabled===true||patch.transferCredentials===true))return;
        const owns = captureOwner(); if (!owns() || lock.current || !settings) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const { data } = await baseApi.put<Settings>(path, { expectedRevision: settings.revision, enabled: settings.enabled, transferCredentials: settings.transferCredentials, ...patch });
            if (owns()) setSettings(data);
        } catch (cause) { if (owns()) setError(errorMessage(cause, 'Не удалось сохранить настройку. Обновите данные перед повтором.')); }
        finally { lock.current = false; if (owns()) setBusy(false); }
    };
    const configure = async (id: string): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try { const model = await modelCatalogApi.get(id); if (owns()) setConnection(model); }
        catch (cause) { if (owns()) setError(errorMessage(cause, 'Модель больше недоступна.')); }
        finally { lock.current = false; if (owns()) setBusy(false); }
    };
    const check = async (id: string): Promise<void> => {
        const owns = captureOwner(); if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError(''); setNotice('');
        try { const model = await modelCatalogApi.get(id); if (!owns()) return; await modelCatalogApi.operate(model, 'check'); if (owns()) setNotice('Проверка подключения запущена. Обновите статус через несколько секунд.'); }
        catch (cause) { if (owns()) setError(errorMessage(cause, 'Не удалось запустить проверку подключения.')); }
        finally { lock.current = false; if (owns()) setBusy(false); }
    };
    if (!isMain) return null;
    return <>
        <Button size="small" onClick={() => { setOpen(true); void load(); }}>Модели OpenCode</Button>
        {open && <Modal open title="Модели с этого компьютера" width={640} onCancel={() => { if (!lock.current) setOpen(false); }} footer={<Space><Button loading={busy} onClick={() => { void load(); }}>Обновить</Button><Button disabled={busy} onClick={() => setOpen(false)}>Закрыть</Button></Space>}>
            <FeatureAvailabilityNotice features={['opencode_model_sync']}/>
            {!supported && <Alert type="warning" showIcon message="Обновите мост для автоматического импорта моделей." />}
            {error && <Alert type="error" showIcon message={error} />}
            {notice && <Alert type="info" showIcon message={notice} />}
            {!settings && busy ? <Spin /> : settings && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Space><Switch aria-label="Автоматически добавлять модели OpenCode" checked={settings.enabled} disabled={busy||!settings.enabled&&!availability.enabled} onChange={enabled => { void save({ enabled }); }} /><Typography.Text>Автоматически добавлять модели из OpenCode</Typography.Text></Space>
                <Typography.Paragraph type="secondary">Мост проверяет общую конфигурацию компьютера и настройки привязанных проектов примерно раз в минуту. Общие модели появятся в каталоге без привязки к проекту; проектные — также в связанном проекте. Снятое вручную назначение не восстанавливается. Перед чатом запустите проверку API.</Typography.Paragraph>
                <Space><Switch aria-label="Разрешить перенос API-ключей с компьютера" checked={settings.transferCredentials} disabled={busy || !settings.canTransferCredentials || !settings.transferCredentials&&!availability.enabled} onChange={transferCredentials => { void save({ transferCredentials }); }} /><Typography.Text>Разрешить перенос API-ключей на сервер</Typography.Text></Space>
                <Typography.Paragraph type="secondary">После включения мост передаст ключи из поддерживаемых настроек OpenCode по защищённому каналу. Сервер сохранит их в зашифрованном виде. Существующие ручные подключения сохраняются. Выключение настройки прекращает новые передачи; уже сохранённый ключ можно отозвать в подключении модели.</Typography.Paragraph>
                {!settings.canTransferCredentials && <Alert type="info" showIcon message="Сначала настройте шифрование ключей моделей на сервере." />}
                <List size="small" dataSource={settings.sources} locale={{ emptyText: 'Модели ещё не обнаружены. Подключите компьютер и проверьте его общую конфигурацию OpenCode.' }} renderItem={source => <List.Item actions={source.modelId ? [<Button key="connection" size="small" disabled={busy || !!source.archivedAt} onClick={() => { void configure(source.modelId!); }}>Подключение</Button>,
                    ...(source.needsCheck && !source.revoked && !source.archivedAt ? [<FeatureButton features={['model_hosting']} key="check" size="small" disabled={busy || ['pending', 'unavailable'].includes(source.credentialStatus)} onClick={() => { void check(source.modelId!); }}>Проверить</FeatureButton>] : [])] : []}>
                    <div><Typography.Text strong>{source.name || source.configKey}</Typography.Text><div><Typography.Text type="secondary">{source.scope==='global'?'Общая конфигурация':source.projectName||'Конфигурация проекта'} · {source.provider} · {stateLabel[source.state]}{credentialLabel[source.credentialStatus] ? ' · ' + credentialLabel[source.credentialStatus] : ''}</Typography.Text></div>
                        <div><Typography.Text type="secondary">{source.archivedAt ? 'В архиве' : source.revoked ? 'Подключение отозвано' : source.needsCheck ? 'Перед чатом нужна проверка API' : source.modelId ? 'Подключение проверено' : ''}{source.modelId ? source.assigned ? ' · Добавлена в проект' : ' · Назначьте модель проекту в каталоге' : ''}</Typography.Text></div>
                        {(source.contextWindow || source.outputTokenLimit) && <Typography.Text type="secondary">{[source.contextWindow ? `Контекст: ${source.contextWindow.toLocaleString('ru-RU')}` : '', source.outputTokenLimit ? `Предел ответа: ${source.outputTokenLimit.toLocaleString('ru-RU')}` : ''].filter(Boolean).join(' · ')}</Typography.Text>}</div>
                </List.Item>} />
            </Space>}
        </Modal>}
        {connection && <RemoteConnectionModal key={connection.id + ':' + connection.revision} model={connection} onClose={() => setConnection(undefined)} onSaved={load} />}
    </>;
}
