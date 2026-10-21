import {Button, Checkbox, Select, Spin, Typography} from 'antd';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import type {useChatResearch} from './useChatResearch';

interface Props {value: ReturnType<typeof useChatResearch>; disabled: boolean; projectId?: string;}

/** Research is consented for this message only; plain chat retains its ordinary project context. */
export function ChatResearchControls({value, disabled, projectId}: Props): JSX.Element {
    const availability = useFeatureAvailability('research_tools');
    const reason = !availability.enabled ? availability.reason : value.reason;
    return <div className="model-chat__research-controls">
        <Checkbox checked={value.enabled} disabled={disabled || !projectId || !availability.enabled && !value.enabled} onChange={event => {if (!disabled && projectId && (availability.enabled || !event.target.checked)) value.setEnabled(event.target.checked);}}>Исследовать источники</Checkbox>
        {!projectId && <Typography.Text type="secondary">Доступно в чате проекта</Typography.Text>}
        {value.enabled && <div className="model-chat__research-settings">
            <Typography.Text type="secondary">Для этого сообщения модель сможет искать и читать данные. Исследование добавляет запросы к модели и выбранному поисковому MCP. Поисковые запросы и адреса страниц передаются провайдеру MCP.</Typography.Text>
            {value.loading ? <Spin size="small"/> : <>
                <Checkbox checked={value.project} disabled={disabled || !availability.enabled || !value.choices?.project.available && !value.project} onChange={event => value.setProject(event.target.checked)}>База знаний проекта</Checkbox>
                <label>Внешние источники<Select aria-label="Поисковый MCP исследования" allowClear placeholder="Без внешнего поиска" value={value.externalId} disabled={disabled || !availability.enabled || !value.choices?.external.length}
                    onChange={id => value.setExternalId(id)} options={value.choices?.external.map(item => ({value: item.assetId, label: `${item.name} · v${item.version}${item.available ? '' : ' · недоступен'}`, disabled: !item.available, title: item.reason}))}/></label>
                {!value.choices?.external.length && !value.error && <Typography.Text type="secondary">Назначьте проекту совместимый поисковый MCP в каталоге, чтобы добавить внешний поиск.</Typography.Text>}
            </>}
            {reason && <Typography.Text type="warning" role="status">{reason}</Typography.Text>}
            <details><summary>Пределы и доступ к источникам</summary><Typography.Paragraph type="secondary">До {value.choices?.limits.stepsPerRecipient ?? 6} шагов на ответ и до {value.choices?.limits.externalCallsPerRound ?? 16} внешних обращений за раунд, до 15 минут на весь раунд. Читаются индексированные фрагменты проекта и публичные HTTP(S) страницы через выбранный MCP. Закрытые адреса, локальные файлы и произвольные команды недоступны. Все шаги сохраняются в личной истории.</Typography.Paragraph></details>
            <Button size="small" type="link" disabled={disabled || value.loading} onClick={value.reload}>Проверить источники</Button>
        </div>}
    </div>;
}
