import {Alert, Button, Card, InputNumber, Space, Spin, Switch, Typography} from 'antd';
import {useLayoutEffect, useMemo, useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelRateApi} from './api';
import {createModelRateController} from './controller';
import {initialModelRateState, rateDescription} from './model';
import type {ModelRateState} from './types';
import './ModelRateLimits.less';

interface Props {modelId: string; projectId?: string;}
function ModelRateEditor({modelId, projectId}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), [state, setState] = useState<ModelRateState>(initialModelRateState);
    const controller = useMemo(() => createModelRateController({read: signal => modelRateApi.read(modelId, projectId, signal), write: (input, signal) => modelRateApi.write(modelId, input, signal), captureOwner, onChange: setState}), [modelId, projectId, captureOwner]);
    useLayoutEffect(() => {controller.activate(); void controller.refresh(); return () => controller.dispose();}, [controller]);
    return <ModelRateLimitsContent state={state} controller={controller}/>;
}

/** Read-only presentation also stays available while the global enforcement flag is off. */
export function ModelRateLimitsContent({state, controller}: {state: ModelRateState; controller: Pick<ReturnType<typeof createModelRateController>, 'refresh' | 'save' | 'edit' | 'useCurrent' | 'keepDraft'>}): JSX.Element {
    const locked = state.saving || !!state.pending, canManage = state.policy?.canManage;
    return <Card size="small" title="Лимит запросов" className="model-rate-limits" extra={<Button type="link" size="small" loading={state.loading} disabled={state.saving} onClick={() => void controller.refresh()}>Обновить</Button>}>
        {state.loading && !state.policy && <Spin aria-label="Загрузка лимита модели"/>}
        {state.error && <Alert type="error" showIcon message={state.error}/>}
        {state.notice && <div role="status"><Alert type="success" showIcon message={state.notice}/></div>}
        {state.policy && <>
            <Typography.Text strong>{rateDescription(state.policy)}</Typography.Text>
            {!state.policy.featureEnabled && <Alert type="info" showIcon message="Общий контроль лимитов выключен" description="Настройки сохраняются для последующего включения. Сейчас запросы выполняются без этого ограничения."/>}
            <Typography.Paragraph type="secondary">Лимит общий для всех пользователей и агентов этой модели. По умолчанию — 5 запросов за 5 секунд. При достижении лимита запрос ожидает свободное место до 30 секунд.</Typography.Paragraph>
            {canManage ? <><label className="model-rate-limits__switch"><Switch aria-label="Ограничивать запросы" checked={state.draft.enabled} disabled={locked} onChange={value => controller.edit('enabled', value)}/><span>Ограничивать запросы</span></label>
                <div className="model-rate-limits__fields"><label>Запросов<InputNumber aria-label="Число запросов" min={1} max={1000} precision={0} value={state.draft.requests} disabled={locked} onChange={value => controller.edit('requests', value)}/></label><label>За период, секунд<InputNumber aria-label="Период лимита в секундах" min={1} max={86400} precision={3} value={state.draft.seconds} disabled={locked} onChange={value => controller.edit('seconds', value)}/></label></div>
                {!state.draft.enabled && <Typography.Text type="secondary">Для этой модели ограничение будет отключено.</Typography.Text>}
                {state.conflict && <Alert type="warning" showIcon message="Настройки изменились" description={<><p>Сейчас на сервере: {rateDescription(state.conflict)}.</p><Space wrap><Button onClick={() => controller.useCurrent()}>Использовать текущие</Button><Button onClick={() => controller.keepDraft()}>Оставить мой ввод</Button></Space></>}/>}
                <Button type="primary" loading={state.saving} disabled={state.loading || !!state.conflict} onClick={() => void controller.save()}>{state.pending ? 'Повторить сохранение' : 'Сохранить лимит'}</Button>
            </> : <Typography.Text type="secondary">Изменить лимит может главный администратор.</Typography.Text>}
        </>}
    </Card>;
}

/** Independent model policy is scoped to current authorization and never edits provider settings or pins. */
export function ModelRateLimits(props: Props): JSX.Element | null {
    const {scope} = useAuthRequestOwner(), role = useSelector((state: RootState) => state.userBlock.user?.activeRole);
    if (role !== 'Главный админ' && role !== 'Админ проекта') return null;
    return <ModelRateEditor key={JSON.stringify([scope, props.modelId, props.projectId])} {...props}/>;
}
