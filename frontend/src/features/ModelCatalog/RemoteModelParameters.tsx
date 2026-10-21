import { Collapse, Form, InputNumber, Typography } from 'antd';
import type { ICatalogModel } from './types';

interface IProps { model: ICatalogModel; }

/** Числовые параметры подключения остаются на сервере и не меняют карточку модели. */
export function RemoteModelParameters({ model }: IProps): JSX.Element {
    return <Collapse ghost><Collapse.Panel header="Параметры модели" key="parameters" forceRender>
        <Typography.Paragraph type="secondary">Пустые поля используют настройки провайдера. Параметры отдельного запроса могут переопределить эти значения.</Typography.Paragraph>
        {model.capability !== 'embedding' && <>
            <Form.Item name={['options', 'temperature']} label="Температура" extra="От 0 до 2. Меньше — более предсказуемые ответы."
                rules={[{ type: 'number', min: 0, max: 2, message: 'Число от 0 до 2' }]}>
                <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} placeholder="По умолчанию у провайдера" />
            </Form.Item>
            <Form.Item name={['options', 'topP']} label="Top P" extra="От 0 до 1. Ограничивает разнообразие вариантов ответа."
                rules={[{ type: 'number', min: 0, max: 1, message: 'Число от 0 до 1' }]}>
                <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} placeholder="По умолчанию у провайдера" />
            </Form.Item>
            <Form.Item name={['options', 'maxOutputTokens']} label="Максимум токенов ответа" rules={[{ type: 'integer', min: 1, max: 32768, message: 'Целое число от 1 до 32768' }]}>
                <InputNumber min={1} max={32768} precision={0} style={{ width: '100%' }} placeholder="По умолчанию у провайдера" />
            </Form.Item>
            {model.runtime === 'remote-ollama' && <Form.Item name={['options', 'contextWindow']} label="Размер контекста, токенов" preserve={false}
                rules={[{ type: 'integer', min: 128, max: 2097152, message: 'Целое число от 128 до 2097152' }]}>
                <InputNumber min={128} max={2097152} precision={0} style={{ width: '100%' }} placeholder="По умолчанию у провайдера" />
            </Form.Item>}
        </>}
        <Form.Item name="timeoutMs" label="Ожидание ответа, мс" extra="От 1 000 до 300 000 мс. По умолчанию — 90 000 мс."
            rules={[{ type: 'integer', min: 1000, max: 300000, message: 'Целое число от 1000 до 300000' }]}>
            <InputNumber min={1000} max={300000} step={1000} precision={0} style={{ width: '100%' }} placeholder="90 000" />
        </Form.Item>
    </Collapse.Panel></Collapse>;
}
