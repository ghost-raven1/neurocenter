import {Alert, Checkbox, Form, Modal, Select, Space, Button, Typography} from 'antd';
import {useState} from 'react';
import type {ICatalogModel} from '../ModelCatalog/types';
import type {LearningExperience} from './types';

interface Values {experienceIds: string[]; modelId: string; approved: boolean}
interface Props {revision: number; experiences: LearningExperience[]; models: ICatalogModel[]; busy: boolean; error: string; unconfirmed: boolean; onClose: () => void; onStart: (ids: string[], modelId: string, revision: number) => Promise<boolean>}

export function LearningAnalysisModal(props: Props): JSX.Element {
    const [revision, setRevision] = useState(props.revision);
    return <Modal open centered title="Построить гипотезы по опыту" width={720} className="learning-editor" onCancel={props.onClose} closable={!props.busy} maskClosable={false} keyboard={!props.busy} footer={null}>
        <Typography.Paragraph type="secondary">Выбранная модель получит только отмеченный опыт и его основания. Результатом будут предположения о проекте и работе агентов; они требуют проверки и одобрения.</Typography.Paragraph>
        {props.error && <Alert showIcon type="error" message={props.error} className="project-learning__notice" />}
        {revision !== props.revision && <Alert type="warning" showIcon message="Список проекта обновился" className="project-learning__notice" description={<Button onClick={() => setRevision(props.revision)}>Использовать актуальную ревизию {props.revision}</Button>} />}
        <Form<Values> layout="vertical" initialValues={{experienceIds: [], modelId: props.models[0]?.id, approved: false}} disabled={props.busy || props.unconfirmed} onFinish={value => {void props.onStart(value.experienceIds, value.modelId, revision).then(ok => {if (ok) props.onClose();});}}>
            <Form.Item name="experienceIds" label="Какой опыт анализировать" rules={[{required: true, type: 'array', min: 1, max: 50, message: 'Выберите от 1 до 50 записей.'}]}><Select mode="multiple" optionFilterProp="label" options={props.experiences.map(item => ({value: item.id, label: item.title}))} /></Form.Item>
            <Form.Item name="modelId" label="Модель проекта" rules={[{required: true, message: 'Выберите модель.'}]}><Select optionFilterProp="label" showSearch options={props.models.map(item => ({value: item.id, label: item.name}))} /></Form.Item>
            {!props.models.length && <Alert showIcon type="info" message="Сначала назначьте проекту доступную модель chat или vision в каталоге." className="project-learning__notice" />}
            <Form.Item name="approved" valuePropName="checked" rules={[{validator: async (_, value: boolean) => {if (!value) throw new Error('Подтвердите отправку выбранного опыта.');}}]}><Checkbox>Разрешаю передать выбранный опыт этой модели для анализа</Checkbox></Form.Item>
            <Space className="learning-editor__actions"><Button disabled={props.busy} onClick={props.onClose}>{props.unconfirmed ? 'Закрыть и проверить результат' : 'Отмена'}</Button><Button type="primary" htmlType="submit" loading={props.busy} disabled={!props.models.length || props.unconfirmed || revision !== props.revision}>Построить гипотезы</Button></Space>
        </Form>
    </Modal>;
}
