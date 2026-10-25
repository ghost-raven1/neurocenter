import {Alert, Button, Checkbox, Select, Space, Spin, Typography} from 'antd';
import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useModelCatalog} from '../ModelCatalog/useModelCatalog';
import {modelChatApi} from '../ModelChat/api';
import {modelChatUnavailableReason} from '../ModelChat/model';
import type {IModelChatParticipant} from '../ModelChat/types';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import type {ProjectChatDetail} from './types';

interface Props {
    projectId: string; detail: ProjectChatDetail; saving: boolean; error: string; onClose: () => void;
    onSave: (agentIds: string[], modelId: string | undefined, modelPin: string | undefined, expectedRevision: number) => Promise<boolean>;
}
const configuration = (detail: ProjectChatDetail): string => JSON.stringify([detail.room.modelId, detail.room.modelPin, [...detail.room.agentIds].sort()]);

/** Only shared-room agents are configured here; project membership remains managed by its own screen. */
export function ProjectChatParticipants({projectId, detail, saving, error, onClose, onSave}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), flags = useFeatureAvailability('project_chat', 'group_chat', ...(detail.room.id && detail.room.id !== '00000000-0000-0000-0000-000000000000' ? ['project_chat_dialogs' as const] : [])), models = useModelCatalog(projectId);
    const [modelId, setModelId] = useState(detail.room.modelId ?? ''), [selected, setSelected] = useState(detail.room.agentIds);
    const [items, setItems] = useState<IModelChatParticipant[]>(detail.agents), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0);
    const [base, setBase] = useState(() => configuration(detail));
    const [modelTouched, setModelTouched] = useState(false);
    const active = useRef(true);
    useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
    useEffect(() => {
        if (!modelId) {setItems(detail.agents); setLoadError(''); return;}
        const controller = new AbortController(), owns = captureOwner(); setLoading(true); setLoadError('');
        void modelChatApi.agents(modelId, projectId, controller.signal).then(value => {if (owns() && !controller.signal.aborted) setItems(value);})
            .catch(cause => {if (owns() && !controller.signal.aborted) setLoadError(errorMessage(cause, 'Не удалось проверить агентов проекта. Повторите.'));})
            .finally(() => {if (owns() && !controller.signal.aborted) setLoading(false);});
        return () => controller.abort();
    }, [projectId, modelId, captureOwner, attempt]);
    const assigned = new Set(models.catalog?.assignedModelIds ?? []);
    const availableModels = models.catalog?.items.filter(model => !modelChatUnavailableReason(model, true, true, assigned.has(model.id))) ?? [];
    const defaultChosen = useRef(!!detail.room.modelId);
    useEffect(() => {
        if (defaultChosen.current || modelTouched || detail.room.modelId || models.loading || models.error || !flags.enabled || !availableModels.length) return;
        defaultChosen.current = true; setModelId(availableModels[0].id);
    }, [models.catalog, models.loading, models.error, flags.enabled, modelTouched, detail.room.modelId]);
    const model = availableModels.find(value => value.id === modelId);
    const roster = new Map([...detail.agents, ...items].map(value => [value.agentId, value]));
    const invalid = selected.some(id => roster.get(id)?.status !== 'active'), changed = configuration(detail) !== base;
    const removal = !modelTouched && modelId === (detail.room.modelId ?? '') && selected.every(id => detail.room.agentIds.includes(id));
    const canSave = detail.canConfigure && !changed && selected.length <= 8 && (removal && detail.room.revision > 0 || flags.enabled && !loading && !loadError && (!selected.length || !!model && !invalid));
    const save = async (): Promise<void> => {
        if (!canSave) return;
        const chosenModel = removal ? detail.room.modelId ?? undefined : model?.id, chosenPin = removal ? detail.room.modelPin ?? undefined : model?.modelPin;
        const owns = captureOwner(), ok = await onSave(selected, selected.length ? chosenModel : undefined, selected.length ? chosenPin : undefined, detail.room.revision);
        if (ok && owns() && active.current) {
            // Adopt this acknowledged submission only; a later external configuration still requires review.
            const savedModel = selected.length ? chosenModel ?? null : null, savedPin = selected.length ? chosenPin ?? null : null;
            setModelId(savedModel ?? ''); setModelTouched(false);
            setBase(configuration({...detail, room: {...detail.room, agentIds: selected, modelId: savedModel, modelPin: savedPin}}));
            onClose();
        }
    };
    return <section className="project-chat__settings" aria-label="Настройка агентов команды">
        <div className="project-chat__settings-heading"><Typography.Title level={5}>Агенты команды</Typography.Title><Button disabled={saving} onClick={onClose}>Закрыть настройку</Button></div>
        <Typography.Paragraph type="secondary">{detail.room.visibility === 'PRIVATE' ? 'Доступ имеют только выбранные люди диалога.' : 'Люди проекта уже в чате.'} Выберите модель и агентов, если хотите спрашивать их здесь. Обычное сообщение коллегам не вызывает модель.</Typography.Paragraph>
        <label>Базовая модель<Select aria-label="Базовая модель агентов команды" value={modelId || undefined} placeholder="Выберите готовую модель проекта" showSearch optionFilterProp="label" loading={models.loading} disabled={saving || !flags.enabled || !detail.canConfigure} allowClear
            options={availableModels.map(value => ({value: value.id, label: value.name}))} onChange={value => {defaultChosen.current = true; setModelId(value ?? ''); setModelTouched(true); setLoadError('');}}/></label>
        {models.error && <Alert type="error" showIcon message={models.error} action={<Button onClick={() => {void models.refresh();}}>Повторить проверку моделей</Button>}/>}
        {!modelTouched && model?.modelPin && model.modelPin !== detail.room.modelPin && <Alert type="info" showIcon message="В каталоге обновилась версия модели" description="Ранее отправленные вопросы сохраняют свою версию. Для следующих вопросов можно принять проверенную версию из каталога."
            action={<Button disabled={!flags.enabled || saving} onClick={() => setModelTouched(true)}>Принять новую версию</Button>}/>}
        {!models.loading && !availableModels.length && !models.error && <Alert type="info" message="Для ответов агентов подключите готовую чат-модель в каталоге проекта."/>}
        {loading && <Spin tip="Проверяем агентов проекта…"/>}
        {loadError && <Alert type="error" showIcon message={loadError} action={<Button onClick={() => setAttempt(attempt + 1)}>Повторить проверку агентов</Button>}/>}
        <div className="project-chat__agent-options">{[...roster.values()].map(agent => {
            const checked = selected.includes(agent.agentId), unavailable = agent.status !== 'active';
            return <div key={agent.agentId}><Checkbox checked={checked} disabled={saving || !detail.canConfigure || !checked && (unavailable || selected.length >= 8 || !flags.enabled && !detail.room.agentIds.includes(agent.agentId))}
                onChange={event => setSelected(event.target.checked ? [...selected, agent.agentId] : selected.filter(id => id !== agent.agentId))}>{agent.name} · @{agent.slug}</Checkbox>
                <Typography.Text type={unavailable ? 'warning' : 'secondary'}>{unavailable ? agent.reason || 'Сейчас недоступен' : agent.modelName || 'Базовая модель команды'}</Typography.Text></div>;
        })}</div>
        {!roster.size && !loading && <Typography.Paragraph type="secondary">Агенты ещё не добавлены в проект. Чат участников уже доступен.</Typography.Paragraph>}
        {invalid && <Typography.Paragraph type="warning">Уберите недоступных агентов или выберите подходящую модель.</Typography.Paragraph>}
        {changed && <Alert type="warning" showIcon message="Другой администратор изменил состав" description={`Сейчас в группе: ${detail.agents.filter(agent => detail.room.agentIds.includes(agent.agentId)).map(agent => agent.name).join(', ') || 'без агентов'}. Ваш выбор сохранён.`}
            action={<Space wrap><Button onClick={() => {setModelId(detail.room.modelId ?? ''); setModelTouched(false); setSelected(detail.room.agentIds); setBase(configuration(detail));}}>Принять текущий состав</Button><Button onClick={() => setBase(configuration(detail))}>Оставить мой выбор</Button></Space>}/>}
        {error && <Alert type="error" showIcon message={error}/>}
        {!flags.enabled && <Typography.Paragraph type="secondary">{flags.reason} Убрать ранее подключённых агентов можно и сейчас.</Typography.Paragraph>}
        <Button type="primary" loading={saving} disabled={saving || !canSave} onClick={() => {void save();}}>Сохранить агентов</Button>
    </section>;
}
