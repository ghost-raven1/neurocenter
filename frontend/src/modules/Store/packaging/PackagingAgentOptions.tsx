import {Alert, Button, Checkbox, Form, Select, Typography} from 'antd';
import type {usePackagingAgent} from './usePackagingAgent';

interface Props {agent: ReturnType<typeof usePackagingAgent>; enabled: boolean; reason: string; disabled: boolean; locked: boolean}

/** Consent covers this build's bounded planning and review calls, never opening the modal. */
export function PackagingAgentOptions({agent, enabled, reason, disabled, locked}: Props) {
    return <section className="tool-packaging__agent" aria-label="Помощь Упаковщика">
        <Checkbox checked={agent.checked} disabled={disabled || !enabled && !agent.checked} onChange={event => agent.setChecked(event.target.checked)}>Помощь Упаковщика</Checkbox>
        <Typography.Paragraph type="secondary">Необязательно: выбранная модель подготовит рецепт и разберёт результат проверки. Обычная упаковка доступна без модели.</Typography.Paragraph>
        {!enabled && <Typography.Paragraph type="secondary">{reason}</Typography.Paragraph>}
        {agent.checked && <>
            <Form.Item label="Модель Упаковщика" extra="Проверенные чат-модели из общего каталога.">
                <Select aria-label="Модель Упаковщика" value={agent.selection?.modelId} placeholder="Выберите модель" showSearch optionFilterProp="label" loading={agent.loading} disabled={disabled || !enabled}
                    options={agent.models.map(model => ({value: model.id, label: model.name}))} onChange={agent.choose}/>
            </Form.Item>
            <Typography.Paragraph type="secondary">После нажатия «Упаковать» — до {agent.selection?.maxAttempts ?? 3} попыток, до {(agent.selection?.maxAttempts ?? 3) * 2} обращений к модели. Ей передаются сведения выбранного источника и результат проверки запуска. Внешний API может тарифицировать эти обращения.</Typography.Paragraph>
            {locked ? <Typography.Paragraph type="secondary">Модель, её версия и предел попыток закреплены в сохранённом запросе.</Typography.Paragraph>
                : agent.blocker && <Alert type={agent.error ? 'error' : 'info'} showIcon message={agent.blocker} action={enabled && !agent.loading ? <Button onClick={agent.refresh}>Проверить модели</Button> : undefined}/>}
        </>}
    </section>;
}
