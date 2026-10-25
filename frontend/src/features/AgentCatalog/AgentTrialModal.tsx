import { Alert, Button, Checkbox, Descriptions, Modal, Radio, Select, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { FeatureButton, useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { AgentTrialStatus } from './AgentTrialStatus';
import { agentTrialPending } from './readinessModel';
import type { IAgentReadinessItem, IAgentTrial, TAgentTrialTool } from './readinessTypes';

interface IProps {
    projectId: string; name: string; item: IAgentReadinessItem;
    busy: boolean; loading: boolean; error: string; uncertain: boolean; checking?: boolean;
    onClose: () => void; onRefresh: () => void; onReplay: () => void;
    onStart: (modelId: string, tool: TAgentTrialTool, consent: boolean) => void;
    onCancel: (trial: IAgentTrial) => void;
}
const labels = { prompt_sent: 'Промпт передан модели', model_response: 'Контрольное задание выполнено', project_search: 'Поиск данных проекта' };
const checkLabels = { passed: 'Подтверждено', failed: 'Ошибка', not_run: 'Не выполнялось' };
const date = (value: string): string => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : 'Время не указано';

/** Opening this panel only reads metadata; a model call requires the explicit start action. */
export function AgentTrialModal({ projectId, name, item, busy, loading, error, uncertain, checking = false, onClose, onRefresh, onReplay, onStart, onCancel }: IProps): JSX.Element {
    const history = useHistory(), searchAvailability = useFeatureAvailability('project_search');
    const fixed = item.eligibility.modelSelection === 'fixed';
    const [selected, setSelected] = useState(fixed ? item.eligibility.resolvedModelId ?? '' : item.latestTrial?.receipt.modelId ?? (!loading && !checking && !uncertain ? item.eligibility.models.find(model => model.available)?.id : undefined) ?? '');
    const modelTouched = useRef(false);
    useEffect(() => {if (!fixed && !loading && !checking && !uncertain && !modelTouched.current && !selected) {
        const first = item.latestTrial?.receipt.modelId ?? item.eligibility.models.find(model => model.available)?.id; if (first) setSelected(first);
    }}, [fixed, loading, checking, uncertain, selected, item]);
    const [tool, setTool] = useState<TAgentTrialTool>('none'), [consent, setConsent] = useState(false);
    const trial = item.latestTrial, pending = agentTrialPending(trial);
    const model = item.eligibility.models.find(value => value.id === (fixed ? item.eligibility.resolvedModelId : selected));
    const search = item.eligibility.tools.find(value => value.kind === 'project_search');
    const searchAllowed = !!search?.available && searchAvailability.enabled;
    const blocked = busy || loading || checking || !!error || uncertain || pending || !item.eligibility.canRun || !model?.available
        || tool === 'project_search' && (!searchAllowed || !!search?.requiresConsent && !consent);
    return <Modal open title={`Испытание в чате · ${name}`} className="agent-trial" width={680} footer={null} onCancel={onClose} maskClosable={false}>
        <Typography.Paragraph type="secondary">Короткое контрольное задание проверит вызов выбранной модели с сохранённым промптом агента. Запрос может расходовать лимит провайдера.</Typography.Paragraph>
        <AgentTrialStatus item={item} checking={checking} />
        {trial && <div className="agent-trial__result">
            {pending && <Spin size="small" />}
            <Typography.Text>{trial.message}</Typography.Text>
            {!trial.current && <Alert type="warning" showIcon message={trial.staleReason || 'Промпт, параметры или модель изменились. Предыдущий результат сохранён.'} />}
            <details><summary>Подробности испытания</summary>
                {checking && <Typography.Paragraph type="secondary">Последняя сохранённая квитанция. Её актуальность для текущих настроек ещё проверяется.</Typography.Paragraph>}
                <Descriptions size="small" column={1}>
                    <Descriptions.Item label="Область">Чат Нейроцентра · {trial.receipt.modelName}</Descriptions.Item>
                    <Descriptions.Item label="Шаблон">v{trial.receipt.agentVersion}</Descriptions.Item>
                    <Descriptions.Item label="Запущено">{date(trial.createdAt)}</Descriptions.Item>
                    {trial.finishedAt && <Descriptions.Item label="Завершено">{date(trial.finishedAt)}</Descriptions.Item>}
                </Descriptions>
                <div className="agent-trial__checks">{trial.receipt.checks.map(check => <div key={check.kind}>
                    <Typography.Text strong>{labels[check.kind]}</Typography.Text>
                    <Tag color={check.status === 'passed' ? 'green' : check.status === 'failed' ? 'red' : undefined}>{checkLabels[check.status]}</Tag>
                    <Typography.Text type="secondary">{check.message}</Typography.Text>
                </div>)}</div>
                <Typography.Paragraph type="secondary">Это диагностический результат для указанной модели и конфигурации. Настройки OpenCode подтверждаются мостом отдельно.</Typography.Paragraph>
                <details><summary>Закреплённая конфигурация</summary><Descriptions size="small" column={1}>
                    <Descriptions.Item label="Модель"><code>{trial.receipt.modelPin}</code></Descriptions.Item>
                    <Descriptions.Item label="Агент"><code>{trial.receipt.agentPin}</code></Descriptions.Item>
                    <Descriptions.Item label="Промпт"><code>{trial.receipt.promptSha256}</code></Descriptions.Item>
                    <Descriptions.Item label="Параметры"><code>{trial.receipt.configSha256}</code></Descriptions.Item>
                </Descriptions></details>
            </details>
        </div>}
        {error && <Alert showIcon type="error" message={error} action={<Button disabled={busy} onClick={onRefresh}>Перечитать состояние</Button>} />}
        {uncertain && <Alert showIcon type="warning" message="Ответ о запуске не подтверждён" description="Повтор отправит тот же ключ запроса. Новое испытание пока не создаётся."
            action={<Button disabled={busy} onClick={onReplay}>Повторить тот же запрос</Button>} />}
        {!pending && <div className="agent-trial__setup">
            <Typography.Text strong>Модель для этого испытания</Typography.Text>
            {fixed ? <Typography.Paragraph>{model?.name || 'Закреплённая модель недоступна'} <Tag>Закреплена в агенте</Tag></Typography.Paragraph>
                : <Select aria-label="Модель для испытания" value={model?.id} disabled={busy || uncertain} placeholder="Выберите модель проекта" onChange={value => {modelTouched.current = true; setSelected(value);}}
                    options={item.eligibility.models.map(value => ({ value: value.id, label: value.name, disabled: !value.available, title: value.reason }))} />}
            {(!item.eligibility.canRun || model && !model.available) && <Alert showIcon type="info" message={model?.reason || item.eligibility.reason || 'Испытание пока недоступно.'} />}
            {!item.eligibility.models.some(value => value.available) && <Button onClick={() => { onClose(); history.push(`/projects/${encodeURIComponent(projectId)}?tab=store&catalogTab=models`); }}>Открыть модели проекта</Button>}
            {(search?.available || tool === 'project_search') && <><Radio.Group aria-label="Область испытания" value={tool} disabled={busy || uncertain} onChange={event => { setTool(event.target.value); setConsent(false); }}>
                <Radio value="none">Промпт и ответ модели</Radio><Radio value="project_search" disabled={!searchAllowed}>Также поиск данных проекта</Radio>
            </Radio.Group>
                {!searchAvailability.enabled && <Typography.Text type="secondary">{searchAvailability.reason}</Typography.Text>}
                {tool === 'project_search' && search?.requiresConsent && <Checkbox checked={consent} disabled={busy || uncertain} onChange={event => setConsent(event.target.checked)}>Разрешаю поиск в данных проекта для этого испытания</Checkbox>}</>}
            {!search?.available && (search?.reason || tool === 'project_search') && <Typography.Text type="secondary">{search?.reason || 'Поиск данных проекта сейчас недоступен. Можно испытать промпт и ответ модели без поиска.'}</Typography.Text>}
        </div>}
        {pending && <Typography.Paragraph type="secondary">Можно закрыть окно и вернуться к сохранённому состоянию испытания.</Typography.Paragraph>}
        <Space wrap className="agent-trial__actions"><Button onClick={onClose}>Закрыть</Button>
            {pending && trial?.canCancel && <Button danger disabled={busy} onClick={() => onCancel(trial)}>Остановить испытание</Button>}
            {!pending && <FeatureButton features={['agents', 'group_chat', 'model_chat', 'model_hosting', ...(tool === 'project_search' ? ['project_search' as const] : [])]}
                type="primary" disabled={blocked} loading={busy} onClick={() => { if (!blocked && model) onStart(model.id, tool, consent); }}>{trial ? 'Запустить ещё раз' : 'Запустить испытание'}</FeatureButton>}
        </Space>
    </Modal>;
}
