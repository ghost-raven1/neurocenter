import { Alert, Button, Empty, Select, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { roleFlag } from '../SystemRoles/types';
import { ServiceComposer } from './ServiceComposer';
import { ServiceTurnContent } from './ServiceTurnContent';
import { useSystemRoleChat } from './useSystemRoleChat';
import '../SystemRoles/SystemRoles.less';
import './SystemRoleChat.less';

/** Private service conversations share the common chat entrypoint and retain read-only recovery when disabled. */
export function SystemRoleChat({ projectId, canExecute = true }: { projectId?: string; canExecute?: boolean }): JSX.Element {
    const availability = useFeatureAvailability('system_role_chat'), value = useSystemRoleChat(projectId, availability.enabled && canExecute), [draft, setDraft] = useState(0);
    const replayAvailability = useFeatureAvailability('system_role_chat', roleFlag(value.receiptAgentId ?? 'agent-coordinator'));
    const replayEnabled = useRef(false); replayEnabled.current = replayAvailability.enabled && canExecute;
    const viewport = useRef<HTMLDivElement>(null), feedback = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (value.busy || !value.error && !value.receipt) return;
        const container = viewport.current, notice = feedback.current; if (!container || !notice) return;
        const bounds = container.getBoundingClientRect(), message = notice.getBoundingClientRect();
        const top = bounds.top + container.clientTop, bottom = top + container.clientHeight;
        // Reveal new feedback within its own scroll owner without moving keyboard focus or the page.
        if (message.top < top || message.bottom > bottom) container.scrollTop += message.top < top || message.height > container.clientHeight
            ? message.top - top - 8 : message.bottom - bottom + 8;
    }, [value.owner, value.error, value.receipt?.requestId, value.busy]);
    const dialogs = value.detail ? [value.detail.dialog, ...value.dialogs.filter(item => item.id !== value.detail!.dialog.id)] : value.dialogs;
    return <div className="service-chat" ref={viewport}>
        <div className="service-chat__heading"><div><Typography.Text strong>Сервисный чат</Typography.Text><Typography.Paragraph type="secondary">Личные задачи системным агентам и проверенные результаты.</Typography.Paragraph></div>
            <Button disabled={value.busy || !!value.receipt} onClick={() => { value.newDialog(); setDraft(item => item + 1); }}>Новый диалог</Button>
            <Button loading={value.loading} disabled={value.busy} onClick={() => { void value.refresh(); }}>Обновить</Button></div>
        <label className="service-chat__history-label">История диалогов<Select aria-label="История сервисного чата" value={value.detail?.dialog.id} placeholder="Выберите сохранённый диалог" loading={value.loading} disabled={value.busy} showSearch optionFilterProp="label"
            options={dialogs.map(item => ({ value: item.id, label: item.title + ' · ' + new Date(item.updatedAt).toLocaleDateString('ru-RU') }))} onChange={id => { void value.select(id); setDraft(item => item + 1); }} /></label>
        {(value.error || value.receipt) && <div className="service-chat__feedback" ref={feedback}>
            {value.error && <Alert type="warning" showIcon message={value.error} action={<Button size="small" disabled={value.busy} onClick={() => { void (value.receipt ? value.recover() : value.refresh()); }}>Повторить проверку</Button>} />}
            {value.receipt && <Alert type="warning" showIcon message="Проверяем принятие отправленной задачи" description="Запрос сохранён в этой сессии браузера. Новая отправка заблокирована, пока сервер не подтвердит исход. Проверка не вызывает модель; повтор использует прежний ключ и показанный контекст."
            action={<div className="service-chat__recovery"><Button size="small" loading={value.busy} onClick={() => { void value.recover(); }}>Проверить отправку</Button>
                {value.canReplay && <Button size="small" disabled={value.busy || !replayEnabled.current} onClick={() => { if (replayEnabled.current) void value.replay(); }}>Повторить тот же запрос</Button>}</div>} />}
        </div>}
        <div className="service-chat__messages" aria-label="Сообщения сервисного диалога">
            {value.loading && !value.detail ? <Spin tip="Читаем историю…" /> : !value.detail?.turns.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Опишите задачу координатору или выберите системного агента. Перед отправкой вы увидите точный контекст." />
                : value.detail.turns.map(turn => <ServiceTurnContent key={turn.id} turn={turn} busy={value.busy} onAction={value.action} />)}
        </div>
        <ServiceComposer key={draft} value={value} projectId={projectId} canExecute={canExecute} />
    </div>;
}
