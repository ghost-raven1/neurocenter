import { Alert, Button, Empty, Select, Spin, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { roleFlag, roleName, type SystemRoleId } from '../SystemRoles/types';
import { ServiceComposer } from './ServiceComposer';
import { ServiceTurnContent } from './ServiceTurnContent';
import { useSystemRoleChat } from './useSystemRoleChat';
import {roleConversationApi} from './api';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {clearRoleDraft} from './roleDraft';
import {originSystemRoleApi} from '../ChatSystemRoles/api';
import {chatRoleOriginKey, type ChatRoleLaunch, type ChatRoleOrigin, type ChatRoleAction} from '../ChatSystemRoles/types';
import '../SystemRoles/SystemRoles.less';
import './SystemRoleChat.less';

interface Props {agentId?: SystemRoleId; initialInstruction?: string; projectId?: string; canExecute?: boolean; historyOnly?: boolean; origin?: ChatRoleOrigin; embedded?: boolean; launch?: ChatRoleLaunch; onActionChange?: (action?: ChatRoleAction) => void;}

/** Role conversations and readonly legacy projections share durable private receipts. */
export function SystemRoleChat({ agentId, initialInstruction, projectId, canExecute = true, historyOnly = false, origin, embedded = false, launch, onActionChange }: Props): JSX.Element {
    const initialTask = useRef(initialInstruction);
    const {scope} = useAuthRequestOwner();
    const originKey = origin ? chatRoleOriginKey(origin) : undefined;
    const transport = useMemo(() => agentId ? roleConversationApi(agentId) : origin ? originSystemRoleApi(origin) : undefined, [originKey, agentId]);
    const availability = useFeatureAvailability('system_role_chat', ...(embedded ? ['chat_system_roles' as const] : []), ...(agentId ? ['service_role_conversations' as const] : []));
    const [draft, setDraft] = useState(0), [activeLaunch, setActiveLaunch] = useState(launch), currentLaunch = useRef(activeLaunch); currentLaunch.current = activeLaunch;
    const appliedLaunch = useRef<number | undefined>(launch?.key);
    const automaticRead = useRef<{owner: object; id: string}>(), [readRetry, setReadRetry] = useState(0);
    const value = useSystemRoleChat(projectId, availability.enabled && canExecute && !historyOnly, {transport, agentId, origin: originKey, suspended: embedded && !origin,
        onAccepted: turn => {currentLaunch.current?.onAccepted?.(turn.instruction); setActiveLaunch(undefined); if (agentId) {clearRoleDraft(scope, projectId, agentId); initialTask.current = ''; setDraft(item => item + 1);}}});
    useEffect(() => {
        if ((!embedded && !agentId) || !value.dialogs.length || value.detail || value.receipt || value.busy) return;
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
        {!embedded && <div className="service-chat__heading"><div><Typography.Text strong>{agentId ? `Чат · ${roleName(agentId)}` : 'История системных задач'}</Typography.Text><Typography.Paragraph type="secondary">Личные задачи системным агентам и проверенные результаты.</Typography.Paragraph></div>
            {!embedded && !historyOnly && <Button disabled={value.busy || !!value.receipt} onClick={() => { value.newDialog(); setDraft(item => item + 1); }}>Новый диалог</Button>}
            <Button loading={value.loading} disabled={value.busy} onClick={refresh}>Обновить</Button></div>}
        {embedded && (activeLaunch || value.pendingIntent) && <Typography.Text type="secondary">Системная задача · результат виден только вам. Продолжайте в общем поле сообщения.</Typography.Text>}
        {!embedded && <label className="service-chat__history-label">История диалогов<Select aria-label={agentId ? `История · ${roleName(agentId)}` : 'История системных задач'} value={value.detail?.dialog.id} placeholder="Выберите сохранённый диалог" loading={value.loading} disabled={value.busy} showSearch optionFilterProp="label"
            options={dialogs.map(item => ({ value: item.id, label: (item.legacy ? 'Прежняя история · ' : '') + item.title + ' · ' + new Date(item.updatedAt).toLocaleDateString('ru-RU') }))} onChange={id => { void value.select(id); setDraft(item => item + 1); }} /></label>}
        {(value.error || value.receipt) && <div className="service-chat__feedback" ref={feedback}>
            {value.error && <Alert type="warning" showIcon message={value.error} action={<Button size="small" disabled={value.busy} onClick={() => { if (value.receipt) void value.recover(); else refresh(); }}>Повторить проверку</Button>} />}
            {value.receipt && <Alert type="warning" showIcon message="Проверяем принятие отправленной задачи" description="Запрос сохранён в этой сессии браузера. Новая отправка заблокирована, пока сервер не подтвердит исход. Проверка не вызывает модель; повтор использует прежний ключ и показанный контекст."
            action={<div className="service-chat__recovery"><Button size="small" loading={value.busy} onClick={() => { void value.recover(); }}>Проверить отправку</Button>
                {value.canReplay && <Button size="small" disabled={value.busy || !replayEnabled.current} onClick={() => { if (replayEnabled.current) void value.replay(); }}>Повторить тот же запрос</Button>}</div>} />}
        </div>}
        <div className="service-chat__messages" aria-label={embedded ? 'Ваши системные задачи' : 'Сообщения сервисного диалога'}>
            {value.loading && !value.detail ? <Spin tip="Читаем историю…" /> : !value.detail?.turns.length ? embedded ? null : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={historyOnly ? 'Сохранённых задач в этом диалоге нет.' : value.receipt ? 'Отправленная задача сохранена. Проверьте её принятие.' : agentId ? `Опишите задачу для роли «${roleName(agentId)}». Перед отправкой вы увидите точный контекст.` : 'Опишите задачу координатору или выберите системного агента. Перед отправкой вы увидите точный контекст.'} />
                : value.detail.turns.map(turn => <ServiceTurnContent key={turn.id} turn={turn} busy={value.busy} onAction={value.action} />)}
        </div>
        {embedded && !availability.enabled && <Alert type="info" showIcon message={availability.reason} description="История, проверка отправки и отмена принятых задач доступны."/>}
        {agentId && value.detail?.dialog.legacy && <Alert type="info" showIcon message="Прежняя история этой роли" description="Сообщения и действия сохранены. Для новой задачи начните новый диалог этой роли."/>}
        {!historyOnly && (!agentId || !value.detail?.dialog.legacy || !!value.pendingIntent) && (!embedded || availability.enabled || value.pendingIntent) && (!embedded || activeLaunch || value.pendingIntent || value.prepared) && <ServiceComposer key={value.receipt ? 'pending' : draft + ':' + (activeLaunch?.key ?? 'new')} value={value} projectId={projectId} canExecute={canExecute} fixedAgentId={agentId}
            initial={activeLaunch && launch?.key === activeLaunch.key ? {...activeLaunch,instruction: launch.instruction} : activeLaunch ?? (agentId ? {agentId,instruction: initialTask.current ?? ''} : undefined)} compact={embedded} onActionChange={activeLaunch ? onActionChange : undefined} />}
    </div>;
}
