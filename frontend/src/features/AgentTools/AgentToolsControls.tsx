import {Alert, Button, Checkbox, Select, Space, Spin, Typography} from 'antd';
import type {useAgentTools} from './useAgentTools';
import type {AgentToolGrant} from './types';
export function AgentToolsGrantSummary({grant}: {grant: AgentToolGrant}): JSX.Element {
    return <><Typography.Text type="secondary">Разрешено: {[grant.rag ? 'база знаний проекта' : '',grant.systemRoles ? 'системная справка и диагностика' : '',grant.publicChats ? 'публичные чаты · ' + grant.publicChats.modelId : ''].filter(Boolean).join(', ')} · до 3 дополнительных шагов.</Typography.Text>
        {grant.publicChats && <details><summary>Версия модели поиска</summary><Typography.Text copyable>{grant.publicChats.expectedModelPin}</Typography.Text>{grant.publicChats.roomId && <div>Публичный диалог: {grant.publicChats.roomId}</div>}</details>}</>;
}
/** One compact source choice, not a second role form. Only explicit sending starts paid work. */
export function AgentToolsControls({value,disabled = false,projectId,conflict,onUseTools,onUseResearch}: {value: ReturnType<typeof useAgentTools>; disabled?: boolean; projectId?: string; conflict?: boolean; onUseTools?: () => void; onUseResearch?: () => void}): JSX.Element {
    const {draft,capabilities,update} = value, models = capabilities?.publicChats.models ?? [], modelKey = draft.model && JSON.stringify([draft.model.id,draft.model.pin]);
    const modelOptions: Array<{value: string; label: string; disabled?: boolean}> = models.map(model => ({value: JSON.stringify([model.id,model.pin]),label: model.name}));
    if (modelKey && !modelOptions.some(item => item.value === modelKey)) modelOptions.unshift({value: modelKey,label: (draft.model?.name ?? draft.model?.id ?? '') + ' · сохранённая версия',disabled: true});
    return <section aria-label="Инструменты агентов"><Checkbox checked={draft.enabled} disabled={disabled || !projectId || !capabilities?.available && !draft.enabled} onChange={event => update({enabled: event.target.checked})}>Использовать контекст и инструменты</Checkbox>
        <Typography.Paragraph type="secondary">До {capabilities?.limits.steps ?? 3} дополнительных шагов на ответ. Возможны дополнительные обращения к модели и embedding-поиск; открытие настроек ничего не запускает.</Typography.Paragraph>
        {!projectId && <Typography.Paragraph type="secondary">Выберите проект, чтобы использовать его знания и справку.</Typography.Paragraph>}
        {value.loading && <Spin size="small"/>}
        {draft.enabled && <Space direction="vertical" style={{width: '100%'}}>
            <Checkbox checked={draft.rag} disabled={disabled || !capabilities?.rag.available && !draft.rag} onChange={event => update({rag: event.target.checked})}>База знаний проекта</Checkbox>
            <Checkbox checked={draft.systemRoles} disabled={disabled || !capabilities?.systemRoles.available && !draft.systemRoles} onChange={event => update({systemRoles: event.target.checked})}>Системная справка и диагностика</Checkbox>
            <Checkbox checked={draft.publicChats} disabled={disabled || !capabilities?.publicChats.available && !draft.publicChats} onChange={event => update({publicChats: event.target.checked,consent: false})}>Поиск по публичным чатам проекта</Checkbox>
            {capabilities && !capabilities.publicChats.available && <Typography.Paragraph type="secondary">{capabilities.publicChats.reason || 'Для публичного поиска нужна подходящая модель проекта.'} <a href={'/store?tab=models&p=' + encodeURIComponent(projectId ?? '')}>Настроить модель поиска</a></Typography.Paragraph>}
            {draft.publicChats && <><label>Embedding-модель<Select aria-label="Модель поиска публичных чатов" value={modelKey} options={modelOptions} allowClear disabled={disabled} style={{width: '100%'}} placeholder="Выберите проверенную модель"
                onChange={key => {const model = models.find(item => JSON.stringify([item.id,item.pin]) === key); update({model: model && {id: model.id,pin: model.pin,name: model.name},modelTouched: true,consent: false});}}/></label>
                {!models.length && <a href={'/store?tab=models&p=' + encodeURIComponent(projectId ?? '')}>Подключить подходящую модель</a>}
                {draft.model && <details><summary>Точная версия модели поиска</summary><Typography.Text copyable>{draft.model.pin}</Typography.Text>{draft.roomId && <div>Поиск ограничен публичным диалогом: {draft.roomId}</div>}</details>}
                <Checkbox checked={draft.consent} disabled={disabled || !draft.model} onChange={event => update({consent: event.target.checked})}>Разрешаю передать запрос и публичные сообщения выбранной embedding-модели</Checkbox></>}
            <Typography.Text type="secondary">Справка даёт проверенные сведения и следующие действия. Изменения настроек требуют отдельного действия с вашими правами. Приватные чаты не входят в поиск.</Typography.Text>
        </Space>}
        {conflict && <Alert type="warning" showIcon message="Выберите один способ работы: инструменты агентов или исследование источников" description="Текст и оба выбора сохранены. Два контура одновременно не запускаются." action={<Space wrap><Button disabled={disabled} onClick={onUseTools}>Использовать инструменты агентов</Button><Button disabled={disabled} onClick={onUseResearch}>Использовать исследование</Button></Space>}/>}
        {(value.reason || !capabilities?.available && capabilities?.reason) && <Typography.Paragraph type="warning" role="status">{value.reason || capabilities?.reason}</Typography.Paragraph>}
        {value.error && !draft.enabled && <Typography.Paragraph type="warning">{value.error}</Typography.Paragraph>}
        <Typography.Paragraph type="secondary">{capabilities?.mcp.reason ?? 'Доступность MCP в этом контуре пока не подтверждена.'}</Typography.Paragraph>
        <Button size="small" disabled={disabled || value.loading || !projectId} onClick={value.reload}>Проверить доступность</Button>
    </section>;
}
