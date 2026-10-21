import { Alert, Col, Collapse, Form, Input, InputNumber, Row, Select, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { AGENT_DESCRIPTION_MAX_BYTES, AGENT_PROMPT_MAX_BYTES, agentModeLabels, agentModelPattern, agentPermissionLabels, promptBytes, validAgentText } from './model';
import type { IAgentCreate, IAgentDefinition } from './types';

export interface IAgentEditorValues extends Omit<IAgentCreate, 'definition'> { definition: IAgentDefinition }

/** Keep prompt bytes intact; only an empty optional OpenCode parameter is omitted. */
export function normalizedAgentDefinition(value: IAgentDefinition): IAgentDefinition {
    const permission = Object.fromEntries(Object.entries(value.permission ?? {}).filter(([, action]) => action !== undefined));
    const optional = Object.fromEntries(['model', 'temperature', 'topP', 'steps'].flatMap(key => {
        const raw = value[key as keyof IAgentDefinition];
        const normalized = typeof raw === 'string' ? raw.trim() : raw;
        return normalized === '' || normalized === null || normalized === undefined ? [] : [[key, normalized]];
    }));
    return { description: value.description.trim(), prompt: value.prompt, mode: value.mode, permission, ...optional };
}

export function AgentDefinitionFields({ form, disabled }: {form: FormInstance<IAgentEditorValues>; disabled: boolean}): JSX.Element {
    const prompt = Form.useWatch(['definition', 'prompt'], form) ?? '';
    const bytes = typeof prompt === 'string' ? promptBytes(prompt) : 0;
    return <>
        <Form.Item name={['definition', 'description']} label="Когда выбирать агента" extra="Одна строка · до 1024 байт UTF-8" rules={[{ required: true, whitespace: true, message: 'Опишите назначение агента' }, { validator: (_, value?: string) => value && (!validAgentText(value) || promptBytes(value) > AGENT_DESCRIPTION_MAX_BYTES) ? Promise.reject(new Error('Описание — одна строка корректного UTF-8, не больше 1024 байт')) : Promise.resolve() }]}>
            <Input.TextArea rows={2} placeholder="Например, проверяет изменения и объясняет найденные проблемы" />
        </Form.Item>
        <Form.Item name={['definition', 'prompt']} label="Промпт агента" extra={<span className={bytes > AGENT_PROMPT_MAX_BYTES ? 'agent-editor__limit' : ''}>{bytes.toLocaleString('ru-RU')} / {AGENT_PROMPT_MAX_BYTES.toLocaleString('ru-RU')} байт · Markdown</span>}
            rules={[{ required: true, whitespace: true, message: 'Добавьте инструкции для агента' }, { validator: (_, value: string | undefined) => value && (!validAgentText(value, true) || promptBytes(value) > AGENT_PROMPT_MAX_BYTES) ? Promise.reject(new Error('Промпт должен быть корректным UTF-8 без управляющих символов, до 64 КиБ')) : Promise.resolve() }]}>
            <Input.TextArea className="agent-editor__prompt" autoSize={{ minRows: 9, maxRows: 18 }} spellCheck={false} placeholder="Задача агента, порядок работы, ограничения и ожидаемый результат…" />
        </Form.Item>
        <Row gutter={12}><Col xs={24} sm={10}><Form.Item name={['definition', 'mode']} label="Как вызывать" rules={[{ required: true }]}>
            <Select options={Object.entries(agentModeLabels).map(([value, label]) => ({ value, label }))} />
        </Form.Item></Col><Col xs={24} sm={14}><Form.Item name={['definition', 'model']} label="Модель OpenCode" extra="Пусто — модель OpenCode по умолчанию. Подключение провайдера остаётся в OpenCode."
            rules={[{ max: 200, message: 'До 200 символов' }, { validator: (_, value?: string) => !value?.trim() || agentModelPattern.test(value.trim()) ? Promise.resolve() : Promise.reject(new Error('Формат: provider/model, без адреса API и ключа')) }]}>
            <Input placeholder="provider/model-id" allowClear />
        </Form.Item></Col></Row>
        <Collapse ghost className="agent-editor__advanced">
            <Collapse.Panel header="Параметры и разрешения" key="advanced">
                <Row gutter={12}><Col xs={24} sm={8}><Form.Item name={['definition', 'temperature']} label="Температура" rules={[{ type: 'number', min: 0, max: 2, message: 'Число от 0 до 2' }]}><InputNumber min={0} max={2} step={0.1} placeholder="По умолчанию" /></Form.Item></Col>
                    <Col xs={24} sm={8}><Form.Item name={['definition', 'topP']} label="Top P" rules={[{ type: 'number', min: 0, max: 1, message: 'Число от 0 до 1' }]}><InputNumber min={0} max={1} step={0.05} placeholder="По умолчанию" /></Form.Item></Col>
                    <Col xs={24} sm={8}><Form.Item name={['definition', 'steps']} label="Максимум шагов" rules={[{ type: 'integer', min: 1, max: 1000, message: 'Целое число от 1 до 1000' }]}><InputNumber min={1} max={1000} precision={0} placeholder="По умолчанию" /></Form.Item></Col></Row>
                <Typography.Paragraph type="secondary">Разрешения применяет OpenCode. Пустое значение использует его общую настройку; оно не означает запрет.</Typography.Paragraph>
                <Row gutter={12}>{Object.entries(agentPermissionLabels).map(([key, label]) => <Col xs={24} sm={12} key={key}><Form.Item name={['definition', 'permission', key]} label={label}>
                    <Select allowClear disabled={disabled} placeholder="Настройка OpenCode" options={[{ value: 'ask', label: 'Спрашивать' }, { value: 'allow', label: 'Разрешить' }, { value: 'deny', label: 'Запретить' }]} />
                </Form.Item></Col>)}</Row>
            </Collapse.Panel>
        </Collapse>
        <Alert type="info" showIcon message="Сохранение не вызывает модель" description="Настройки появятся при новом запуске OpenCode после подтверждения моста. Уже работающий OpenCode не перезапускается." />
    </>;
}
