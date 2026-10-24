import {Alert, Button, Checkbox, Modal, Spin, Typography} from 'antd';
import {useEffect, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelChatApi} from './api';
import type {IModelChatParticipant} from './types';
import {FeatureAvailabilityNotice,useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';

interface Props {modelId: string; projectId: string; participants?: IModelChatParticipant[]; joining?: boolean; inline?: boolean; saving: boolean; error?: string; onSave: (ids: string[]) => Promise<boolean>; onClose: () => void;}

/** Only existing project agents can join; unavailable saved participants remain visible and removable. */
export function ChatParticipantsEditor({modelId, projectId, participants, joining, inline, saving, error, onSave, onClose}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner();
    const availability=useFeatureAvailability('group_chat');
    const [items, setItems] = useState<IModelChatParticipant[]>([]), [selected, setSelected] = useState(participants?.map(agent => agent.agentId) ?? []);
    const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const controller = new AbortController(), owns = captureOwner(); setLoading(true); setLoadError('');
        void modelChatApi.agents(modelId, projectId, controller.signal).then(values => {if (owns() && !controller.signal.aborted) setItems(values);})
            .catch(cause => {if (owns() && !controller.signal.aborted) setLoadError(errorMessage(cause, 'Не удалось загрузить агентов проекта.'));})
            .finally(() => {if (owns() && !controller.signal.aborted) setLoading(false);});
        return () => controller.abort();
    }, [modelId, projectId, captureOwner, attempt]);
    const roster = new Map([...participants ?? [], ...items].map(agent => [agent.agentId, agent]));
    const invalid = selected.some(id => roster.get(id)?.status !== 'active');
    const save = async (): Promise<void> => {if(!availability.enabled)return;const owns = captureOwner(); if (await onSave(selected) && owns()) onClose();};
    const title='Участники диалога';
    const disabled=!availability.enabled || loading || !!loadError || (!participants || joining) && selected.length < 1 || selected.length > 8 || invalid || saving;
    const content=<>
        {inline&&<h3>{title}</h3>}
        <FeatureAvailabilityNotice features={['group_chat']}/>
        <Typography.Paragraph type="secondary">{joining ? 'Выберите агентов проекта. История и документы останутся в этом диалоге.' : participants ? 'Добавляйте и убирайте агентов; история сохранится даже без участников.' : 'Выберите от одного до восьми агентов проекта.'} Сообщение получат все участники; @имя позволяет обратиться к отдельным агентам. Каждый отвечает от своего имени.</Typography.Paragraph>
        {error && <Alert type="error" showIcon message={error}/>}
        {loading ? <Spin tip="Загружаем агентов проекта…"/> : loadError ? <Alert type="error" showIcon message={loadError} action={<Button onClick={() => setAttempt(attempt + 1)}>Повторить</Button>}/>
            : !roster.size ? <Alert type="info" showIcon message="В проект пока не добавлены агенты. Добавьте их во вкладке «Агенты» каталога."/>
                : <div className="model-chat__agent-options">{[...roster.values()].map(agent => {
                    const checked = selected.includes(agent.agentId), unavailable = agent.status !== 'active';
                    return <div key={agent.agentId} className="model-chat__agent-option"><Checkbox checked={checked} disabled={saving || !checked && (unavailable || selected.length >= 8)}
                        onChange={event => setSelected(event.target.checked ? [...selected, agent.agentId] : selected.filter(id => id !== agent.agentId))}>{agent.name} <span className="model-chat__agent-slug">@{agent.slug}</span></Checkbox>
                        <Typography.Text type={unavailable ? 'warning' : 'secondary'}>{unavailable ? agent.reason || ({disabled: 'Отключён в проекте', removed: 'Удалён из проекта', blocked: 'Недоступен', active: ''})[agent.status] : agent.modelName || 'Модель текущего диалога'}</Typography.Text></div>;
                })}</div>}
        {invalid && <Typography.Paragraph type="warning">Уберите недоступных участников, чтобы сохранить состав группы.</Typography.Paragraph>}
    </>;
    return inline ? <section aria-label={title}>{content}<div className="model-chat__participant-actions"><Button disabled={saving} onClick={onClose}>Отмена</Button><Button type="primary" loading={saving} disabled={disabled} onClick={()=>{void save();}}>Сохранить участников</Button></div></section>
        : <Modal open title={title} onCancel={saving ? undefined : onClose} closable={!saving} maskClosable={!saving} keyboard={!saving}
            okText="Сохранить участников" cancelText="Отмена" confirmLoading={saving}
            okButtonProps={{disabled}} cancelButtonProps={{disabled:saving}} onOk={()=>{void save();}}>{content}</Modal>;
}
