import { Collapse, Form, Input, InputNumber, Select, Typography } from 'antd';
import type { ICatalogModel } from './types';

interface IProps { model: ICatalogModel; }

/** Параметры подключения остаются на сервере и не меняют карточку модели. */
export function RemoteModelParameters({ model }: IProps): JSX.Element {
    return <Collapse ghost><Collapse.Panel header="Параметры модели" key="parameters" forceRender>
        <Typography.Paragraph type="secondary">Пустые числовые поля используют настройки провайдера. Параметры генерации могут переопределяться в отдельном запросе; совместимость OpenAI задаётся администратором для подключения.</Typography.Paragraph>
        {model.runtime === 'remote-openai' && <>
            <Form.Item name={['options', 'responseModel']} label="Идентификатор модели в ответе" preserve={false}
                extra="Если API возвращает другое каноническое имя, укажите его точно. Пусто — ожидается идентификатор из карточки."
                rules={[{ pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/, message: 'Укажите идентификатор модели без адреса API' },
                    { validator: (_rule, value: string | undefined) => value?.includes('://') ? Promise.reject(new Error('Укажите идентификатор модели без адреса API')) : Promise.resolve() }]}>
                <Input allowClear maxLength={200} placeholder={model.model} />
            </Form.Item>
            {model.capability !== 'embedding' && <Form.Item name={['options', 'tokenLimitParameter']} label="Параметр лимита токенов" preserve={false}
                extra="Настройка API для всех запросов этой модели. Пусто — max_tokens; автоматического повтора с другим параметром нет.">
                <Select allowClear placeholder="max_tokens (по умолчанию)" options={[{ value: 'max_tokens', label: 'max_tokens' }, { value: 'max_completion_tokens', label: 'max_completion_tokens' }]} />
            </Form.Item>}
        </>}
        {model.capability !== 'embedding' && <>
            <Form.Item name={['options', 'temperature']} label="Температура" extra="От 0 до 2. Меньше — более предсказуемые ответы."
                rules={[{ type: 'number', min: 0, max: 2, message: 'Число от 0 до 2' }]}>
                <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} placeholder="По умолчанию у провайдера" />
            </Form.Item>
            <Form.Item name={['options', 'topP']} label="Top P" extra="От 0 до 1. Ограничивает разнообразие вариантов ответа."
                rules={[{ type: 'number', min: 0, max: 1, message: 'Число от 0 до 1' }]}>
                <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} placeholder="По умолчанию у провайдера" />
            </Form.Item>
            <Form.Item name={['options', 'maxOutputTokens']} label="Максимум токенов ответа"
                extra={model.runtime === 'remote-openai' ? 'Для max_completion_tokens лимит включает рассуждения и применяется также к проверке подключения. Без лимита проверка запрашивает 64 токена.' : undefined}
                rules={[{ type: 'integer', min: 1, max: 32768, message: 'Целое число от 1 до 32768' }]}>
                <InputNumber min={1} max={32768} precision={0} style={{ width: '100%' }} placeholder="По умолчанию у провайдера" />
            </Form.Item>
            {(model.runtime === 'remote-ollama' || model.runtime === 'remote-openai') && <Form.Item name={['options', 'contextWindow']} label="Размер контекста, токенов" preserve={false}
                extra={model.runtime === 'remote-openai' ? 'Размер окна из документации провайдера; не увеличивает фактический лимит API. Если поле пустое, размер окна неизвестен.' : undefined}
                rules={[{ type: 'integer', min: 128, max: 2097152, message: 'Целое число от 128 до 2097152' }]}>
                <InputNumber min={128} max={2097152} precision={0} style={{ width: '100%' }} placeholder={model.runtime === 'remote-openai' ? 'Не указан' : 'По умолчанию у провайдера'} />
            </Form.Item>}
        </>}
        <Form.Item name="timeoutMs" label="Ожидание ответа, мс" extra="От 1 000 до 300 000 мс. По умолчанию — 90 000 мс."
            rules={[{ type: 'integer', min: 1000, max: 300000, message: 'Целое число от 1000 до 300000' }]}>
            <InputNumber min={1000} max={300000} step={1000} precision={0} style={{ width: '100%' }} placeholder="90 000" />
        </Form.Item>
    </Collapse.Panel></Collapse>;
}
