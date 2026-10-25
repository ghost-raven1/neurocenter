import { Alert, Button, Empty, Select, Spin, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { roleFlag } from '../SystemRoles/types';
import { ServiceComposer } from './ServiceComposer';
import { ServiceTurnContent } from './ServiceTurnContent';
import { useSystemRoleChat } from './useSystemRoleChat';
import {originSystemRoleApi} from '../ChatSystemRoles/api';
import {chatRoleOriginKey, type ChatRoleLaunch, type ChatRoleOrigin} from '../ChatSystemRoles/types';
import '../SystemRoles/SystemRoles.less';
import './SystemRoleChat.less';

interface Props {projectId?: string; canExecute?: boolean; historyOnly?: boolean; origin?: ChatRoleOrigin; embedded?: boolean; launch?: ChatRoleLaunch;}

/** The same durable private task history can live inside an ordinary chat or in the legacy archive. */
export function SystemRoleChat({ projectId, canExecute = true, historyOnly = false, origin, embedded = false, launch }: Props): JSX.Element {
    const originKey = origin ? chatRoleOriginKey(origin) : undefined;
    const transport = useMemo(() => origin ? originSystemRoleApi(origin) : undefined, [originKey]);
    const availability = useFeatureAvailability('system_role_chat', ...(embedded ? ['chat_system_roles' as const] : []));
    const [draft, setDraft] = useState(0), [activeLaunch, setActiveLaunch] = useState(launch), currentLaunch = useRef(activeLaunch); currentLaunch.current = activeLaunch;
    const appliedLaunch = useRef<number | undefined>(launch?.key);
    const automaticRead = useRef<{owner: object; id: string}>(), [readRetry, setReadRetry] = useState(0);
    const value = useSystemRoleChat(projectId, availability.enabled && canExecute && !historyOnly, {transport, origin: originKey, suspended: embedded && !origin,
        onAccepted: () => {currentLaunch.current?.onAccepted?.(); setActiveLaunch(undefined);}});
    useEffect(() => {
        if (!embedded || !value.dialogs.length || value.detail || value.receipt || value.busy) return;
        const id = value.dialogs[0].id;
        if (automaticRead.current?.owner === value.owner && automaticRead.current.id === id) return;
        automaticRead.current = {owner: value.owner, id}; void value.select(id);
    }, [value.owner, value.dialogs[0]?.id, value.detail?.dialog.id, value.receipt?.requestId, value.busy, readRetry]);
    useEffect(() => {
        if (!launch || appliedLaunch.current === launch.key || value.busy || value.receipt) return;
        value.invalidate(); appliedLaunch.current = launch.key; setActiveLaunch(launch);
    }, [launch?.key, value.busy, value.receipt?.requestId]);
    const replayAvailability = useFeatureAvailability('system_role_chat', roleFlag(value.receiptAgentId ?? 'agent-coordinator'));
    const replayEnabled = useRef(false); replayEnabled.current = replayAvailability.enabled && availability.enabled && canExecute && !historyOnly;
    const viewport = useRef<HTMLDivElement>(null), feedback = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!embedded || !activeLaunch) return;
        viewport.current?.scrollIntoView?.({block: 'nearest'});
        viewport.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }, [activeLaunch?.key]);
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
    const refresh = (): void => {automaticRead.current = undefined; setReadRetry(item => item + 1); void value.refresh();};
    return <div className={'service-chat' + (embedded ? ' service-chat_embedded' : '')} ref={viewport}>
        <div className="service-chat__heading"><div><Typography.Text strong>{embedded ? 'Системные задачи' : historyOnly ? 'Прежние сервисные диалоги' : 'Сервисный чат'}</Typography.Text><Typography.Paragraph type="secondary">{embedded ? 'Задачи и измерения видны только вам. В переписку участников они автоматически не отправляются.' : 'Личные задачи системным агентам и проверенные результаты.'}</Typography.Paragraph></div>
            {!embedded && !historyOnly && <Button disabled={value.busy || !!value.receipt} onClick={() => { value.newDialog(); setDraft(item => item + 1); }}>Новый диалог</Button>}
            <Button loading={value.loading} disabled={value.busy} onClick={refresh}>Обновить</Button></div>
        {!embedded && <label className="service-chat__history-label">История диалогов<Select aria-label="История сервисного чата" value={value.detail?.dialog.id} placeholder="Выберите сохранённый диалог" loading={value.loading} disabled={value.busy} showSearch optionFilterProp="label"
            options={dialogs.map(item => ({ value: item.id, label: item.title + ' · ' + new Date(item.updatedAt).toLocaleDateString('ru-RU') }))} onChange={id => { void value.select(id); setDraft(item => item + 1); }} /></label>}
        {(value.error || value.receipt) && <div className="service-chat__feedback" ref={feedback}>
            {value.error && <Alert type="warning" showIcon message={value.error} action={<Button size="small" disabled={value.busy} onClick={() => { if (value.receipt) void value.recover(); else refresh(); }}>Повторить проверку</Button>} />}
            {value.receipt && <Alert type="warning" showIcon message="Проверяем принятие отправленной задачи" description="Запрос сохранён в этой сессии браузера. Новая отправка заблокирована, пока сервер не подтвердит исход. Проверка не вызывает модель; повтор использует прежний ключ и показанный контекст."
            action={<div className="service-chat__recovery"><Button size="small" loading={value.busy} onClick={() => { void value.recover(); }}>Проверить отправку</Button>
                {value.canReplay && <Button size="small" disabled={value.busy || !replayEnabled.current} onClick={() => { if (replayEnabled.current) void value.replay(); }}>Повторить тот же запрос</Button>}</div>} />}
        </div>}
        <div className="service-chat__messages" aria-label={embedded ? 'Ваши системные задачи' : 'Сообщения сервисного диалога'}>
            {value.loading && !value.detail ? <Spin tip="Читаем историю…" /> : !value.detail?.turns.length ? embedded ? null : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={historyOnly ? 'Сохранённых задач в этом диалоге нет.' : 'Опишите задачу координатору или выберите системного агента. Перед отправкой вы увидите точный контекст.'} />
                : value.detail.turns.map(turn => <ServiceTurnContent key={turn.id} turn={turn} busy={value.busy} onAction={value.action} />)}
        </div>
        {embedded && !availability.enabled && <Alert type="info" showIcon message={availability.reason} description="История, проверка отправки и отмена принятых задач доступны."/>}
        {!historyOnly && (!embedded || availability.enabled || value.pendingIntent) && (!embedded || activeLaunch || value.pendingIntent || value.prepared) && <ServiceComposer key={value.receipt ? 'pending' : draft + ':' + (activeLaunch?.key ?? 'new')} value={value} projectId={projectId} canExecute={canExecute} initial={activeLaunch} compact={embedded} />}
    </div>;
}
