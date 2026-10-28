import {Alert, Button, Descriptions, InputNumber, Select, Space, Spin, Switch, Tag, Typography} from 'antd';
import {isAxiosError} from 'axios';
import {useEffect, useRef, useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {quotaApi} from './api';
import type {createQuotaController} from './controller';
import {formatTokens, quotaEmail} from './model';
import {useModelTokenQuotas} from './useModelTokenQuotas';
import type {PeriodUnit, QuotaIdentity, QuotaState, QuotaUser} from './types';
import './ModelTokenQuotas.less';

type Controller = ReturnType<typeof createQuotaController>;
const displayTokens = (value: string | null): string => value === null ? 'Неизвестно' : formatTokens(value);
const periodOptions: Array<{value: PeriodUnit; label: string}> = [{value: 'day', label: 'дней'}, {value: 'hour', label: 'часов'}, {value: 'minute', label: 'минут'}, {value: 'second', label: 'секунд'}, {value: 'millisecond', label: 'мс'}];

/** Counters expose unknown and overrun explicitly; reserve is an admission estimate, never a billing ceiling. */
export function QuotaEditorContent({state, controller}: {state: QuotaState; controller: Pick<Controller, 'refresh' | 'recover' | 'reloadJournal' | 'save' | 'replay' | 'edit' | 'resolveConflict'>}): JSX.Element {
    const {view, pending} = state, locked = state.busy || !!pending, canManage = view?.canManage === true;
    return <div className="model-token-quotas__editor">
        {state.storageError && <Alert type="warning" showIcon role="alert" message={state.storageError} action={<Button size="small" disabled={state.busy} onClick={() => void controller.reloadJournal()}>Проверить сохранённый запрос</Button>}/>}
        {state.error && <Alert type="error" showIcon role="alert" message={state.error}/>}
        {state.notice && <div role="status"><Alert type="success" showIcon message={state.notice}/></div>}
        {state.busy && !view && <Spin aria-label="Загрузка персональной квоты"/>}
        {pending && <Alert showIcon type="info" message="Сохранённый запрос ожидает подтверждения" description={<Space wrap>
            <Button size="small" disabled={state.busy} onClick={() => void controller.recover()}>Проверить подтверждение</Button>
            {state.canReplay && <Button size="small" disabled={state.busy || !canManage || !!state.storageError} onClick={() => void controller.replay()}>Повторить тот же запрос</Button>}
            {state.rejected && state.missing && canManage && <Button size="small" disabled={state.busy || !!state.storageError} onClick={() => controller.resolveConflict(true)}>Вернуться к вводу</Button>}
        </Space>}/>}
        {view && <>
            <Space wrap size={4}>
                {!view.featureEnabled && <Tag>Преднастройка · контроль выключен</Tag>}
                {!view.coverage.managedText && <Tag>Канал пока не покрыт</Tag>}
                {!view.policy && <Tag>Бюджет не настроен</Tag>}
            </Space>
            {!view.coverage.managedText && <Typography.Text type="secondary">{view.coverage.reason || 'Этот канал пока не объявляется подконтрольным. Прямой локальный BYOK вне API Нейроцентра не учитывается этой квотой.'}</Typography.Text>}
            <Descriptions size="small" column={2} className="model-token-quotas__counters">
                <Descriptions.Item label="Учтено">{formatTokens(view.counters.chargedTokens)}</Descriptions.Item>
                <Descriptions.Item label="Резерв · оценка">{formatTokens(view.counters.activeReservedTokens)}</Descriptions.Item>
                <Descriptions.Item label="Осталось">{view.counters.remainingTokens === null ? 'Не задано' : formatTokens(view.counters.remainingTokens)}</Descriptions.Item>
                {view.counters.overrunTokens !== '0' && <Descriptions.Item label="Перерасход">{formatTokens(view.counters.overrunTokens)}</Descriptions.Item>}
            </Descriptions>
            {(view.counters.unknownCalls > 0 || view.counters.unknownHeldTokens !== '0') && <Tag color="warning">Неизвестный расход · оценка: {formatTokens(view.counters.unknownHeldTokens)} ({view.counters.unknownCalls} выз.)</Tag>}
            {canManage ? <>
                <label className="model-token-quotas__switch"><Switch aria-label="Ограничивать токены пользователя" checked={state.draft.enabled} disabled={locked || !view.coverage.managedText && !state.draft.enabled} onChange={value => controller.edit('enabled', value)}/><span>Ограничивать новые вызовы</span></label>
                <div className="model-token-quotas__fields">
                    <label>Бюджет, токенов<InputNumber aria-label="Бюджет пользователя в токенах" min={1} max={Number.MAX_SAFE_INTEGER} precision={0} value={state.draft.tokenLimit} disabled={locked} onChange={value => controller.edit('tokenLimit', value)}/></label>
                    <label>Период<div className="model-token-quotas__period"><InputNumber aria-label="Длительность периода квоты" min={1} max={31536000000} precision={0} value={state.draft.duration} disabled={locked} onChange={value => controller.edit('duration', value)}/><Select aria-label="Единица периода квоты" value={state.draft.unit} disabled={locked} options={periodOptions} onChange={value => controller.edit('unit', value)}/></div></label>
                </div>
                {state.conflict && <Alert showIcon type="warning" message="Настройки изменены в другом окне" description={<Space wrap>
                    <Button disabled={state.busy || !!pending && !(state.rejected && state.missing)} onClick={() => controller.resolveConflict(false)}>Использовать текущие</Button>
                    <Button disabled={state.busy || !!pending && !(state.rejected && state.missing)} onClick={() => controller.resolveConflict(true)}>Оставить мой ввод</Button>
                </Space>}/>}
                <Button type="primary" loading={state.busy} disabled={!!pending || !!state.storageError || !!state.conflict || state.baseRevision === undefined || !view.coverage.managedText && state.draft.enabled} onClick={() => void controller.save()}>Сохранить квоту</Button>
            </> : <Typography.Text type="secondary">Изменение квоты недоступно. Проверьте актуальные права главного администратора.</Typography.Text>}
            <details className="model-token-quotas__more"><summary>Подробности расхода</summary>
                <Descriptions size="small" column={2}>
                    <Descriptions.Item label="Факт: вход">{displayTokens(view.counters.actualInputTokens)}</Descriptions.Item>
                    <Descriptions.Item label="Факт: выход">{displayTokens(view.counters.actualOutputTokens)}</Descriptions.Item>
                    {view.policy && <Descriptions.Item label="Начало учёта">{new Date(view.policy.accountingStartedAt).toLocaleString('ru-RU')}. Ревизия {view.policy.revision}.</Descriptions.Item>}
                    {view.counters.nextBudgetChangeAt && <Descriptions.Item label="Ближайшее изменение бюджета">{new Date(view.counters.nextBudgetChangeAt).toLocaleString('ru-RU')}</Descriptions.Item>}
                </Descriptions>
                <Typography.Paragraph type="secondary">Новые вызовы проверяются по расходу и оценочному резерву. Последний ответ может превысить бюджет; это превышение сохраняется. Неизвестный расход не считается бесплатным.</Typography.Paragraph>
                <Typography.Paragraph type="secondary">Период — от 1 мс до 365 дней, по умолчанию сутки. Он независим от лимита запросов. При выключенном контроле настройку можно сохранить заранее; прежний расход и подтверждения остаются.</Typography.Paragraph>
                <Button size="small" type="link" loading={state.busy} onClick={() => void controller.refresh()}>Обновить сведения</Button>
            </details>
        </>}
        {!view && !state.busy && <Button size="small" onClick={() => void controller.refresh()}>{state.receipt ? 'Обновить расход' : 'Обновить сведения'}</Button>}
    </div>;
}
function QuotaEditor({identity, onPrivacyDenied}: {identity: QuotaIdentity; onPrivacyDenied: () => void}): JSX.Element {
    const {state, controller} = useModelTokenQuotas(identity, onPrivacyDenied);
    return <QuotaEditorContent state={state} controller={controller}/>;
}
function QuotaPicker({modelId, scope, writerEmail}: Omit<QuotaIdentity, 'userEmail'>): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), [users, setUsers] = useState<QuotaUser[]>(), [selected, setSelected] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
    const request = useRef<AbortController>();
    useEffect(() => () => request.current?.abort(), []);
    const clearPrivate = (): void => {
        if (!captureOwner()()) return;
        request.current?.abort(); setUsers(undefined); setSelected(''); setLoading(false);
        setError('Доступ администратора не подтверждён. Проверьте доступ, чтобы заново загрузить пользователей.');
    };
    const load = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns()) return;
        request.current?.abort(); const transport = new AbortController(); request.current = transport; setLoading(true); setError('');
        try {const data = await quotaApi.users(transport.signal); if (owns() && request.current === transport && !transport.signal.aborted) setUsers(data);}
        catch (cause) {if (owns() && request.current === transport && !transport.signal.aborted) {if (isAxiosError(cause) && [401, 403].includes(cause.response?.status ?? 0)) clearPrivate(); else {setUsers(undefined); setError(errorMessage(cause, 'Не удалось загрузить пользователей. Повторите проверку.'));}}}
        finally {if (owns() && request.current === transport && !transport.signal.aborted) setLoading(false);}
    };
    useEffect(() => {void load();}, [captureOwner]);
    const identity = {scope, writerEmail, modelId, userEmail: selected};
    return <div className="model-token-quotas__body">
        <label className="model-token-quotas__user">Пользователь платформы<Select aria-label="Пользователь персональной квоты" showSearch optionFilterProp="label" loading={loading} value={selected || undefined} placeholder="Выберите пользователя" onChange={value => setSelected(quotaEmail(value))} options={users?.map(user => ({value: quotaEmail(user.email), label: `${user.displayName ? user.displayName + ' · ' : ''}${user.email}${user.enabled ? '' : ' · отключён'}`}))}/></label>
        {error && <Alert type="error" showIcon role="alert" message={error} action={<Button size="small" loading={loading} onClick={() => void load()}>Проверить доступ</Button>}/>}
        {!selected && <Typography.Text type="secondary">Выберите сотрудника, даже если он ещё не вызывал эту модель. Лимит относится ко всем его проектам и агентам этой модели.</Typography.Text>}
        {selected && users && <QuotaEditor key={JSON.stringify(identity)} identity={identity} onPrivacyDenied={clearPrivate}/>}
    </div>;
}
/** First expansion loads private data; closing the native disclosure preserves owned draft and recovery state. */
function QuotaSection(props: Omit<QuotaIdentity, 'userEmail'>): JSX.Element {
    const [opened, setOpened] = useState(false);
    return <details className="model-token-quotas" onToggle={event => {if (event.currentTarget.open) setOpened(true);}}>
        <summary>Квоты токенов</summary>
        {opened && <QuotaPicker {...props}/>}
    </details>;
}

/** The editor stays in model details; current MainAdmin auth and target identity own all private reads. */
export function ModelTokenQuotas({modelId}: {modelId: string}): JSX.Element | null {
    const {scope} = useAuthRequestOwner(), user = useSelector((state: RootState) => state.userBlock.user);
    if (user?.activeRole !== 'Главный админ' || !scope) return null;
    return <QuotaSection key={JSON.stringify([scope, modelId])} scope={scope} modelId={modelId} writerEmail={quotaEmail(user.email)}/>;
}
