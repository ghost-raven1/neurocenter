import {Button, Form, Input, Select, Space, Typography} from 'antd';
import {MinusCircleOutlined, PlusOutlined} from '@ant-design/icons';
import {LearningEditorModal} from './LearningEditorModal';
import {evidenceKindLabel, outcomeLabel} from './model';
import type {LearningCommand, LearningEditorState, LearningExperienceInput} from './types';
import {learningTextRule} from './validation';

type Values = Omit<LearningExperienceInput, 'requestKey' | 'expectedRevision'>;
interface Props {revision: number; state: LearningEditorState; onClose: () => void; onSubmit: (command: LearningCommand, revision: number) => Promise<boolean>}

export function LearningExperienceModal(props: Props): JSX.Element {
    return <LearningEditorModal<Values> title="Записать опыт проекта" submitText="Сохранить опыт" currentRevision={props.revision} state={props.state} onClose={props.onClose}
        initialValues={{title: '', summary: '', outcome: 'unknown', evidence: [{kind: 'observation', status: 'unknown', summary: ''}]}}
        description="Сохраните результат работы и его основания. Наблюдение или отзыв не равны успешно пройденному тесту. Не включайте пароли и API-ключи."
        onSubmit={(value, revision) => props.onSubmit({kind: 'experience', value: {...value, evidence: value.evidence.map(item => ({kind: item.kind, status: item.status, summary: item.summary,
            ...(item.reference?.trim() ? {reference: item.reference} : {}), ...(item.sha256?.trim() ? {sha256: item.sha256.toLowerCase()} : {})})),
            context: value.context?.gitCommit?.trim() ? {gitCommit: value.context.gitCommit.toLowerCase()} : {}}}, revision)}>
        <Form.Item name="title" label="Что произошло" rules={[{required: true, whitespace: true, message: 'Назовите результат работы.'}, learningTextRule(256)]}><Input maxLength={256} /></Form.Item>
        <Form.Item name="summary" label="Задача, действия и результат" rules={[{required: true, whitespace: true, message: 'Опишите опыт.'}, learningTextRule(8192)]}><Input.TextArea autoSize={{minRows: 4, maxRows: 12}} maxLength={8192} /></Form.Item>
        <Form.Item name="outcome" label="Итог" rules={[{required: true}]}><Select options={Object.entries(outcomeLabel).map(([value, label]) => ({value, label}))} /></Form.Item>
        <Typography.Title level={5}>Основания</Typography.Title>
        <Form.List name="evidence" rules={[{validator: async (_, value: unknown[]) => {if (!value?.length) throw new Error('Добавьте хотя бы одно основание.');}}]}>
            {(fields, {add, remove}, {errors}) => <>
                {fields.map(field => <div key={field.key} className="learning-editor__evidence">
                    <Space wrap align="start"><Form.Item name={[field.name, 'kind']} label="Тип" rules={[{required: true}]}><Select className="learning-editor__kind" options={Object.entries(evidenceKindLabel).map(([value, label]) => ({value, label}))} /></Form.Item>
                        <Form.Item name={[field.name, 'status']} label="Результат" rules={[{required: true}]}><Select className="learning-editor__kind" options={[{value: 'passed', label: 'Успешно'}, {value: 'failed', label: 'Ошибка'}, {value: 'unknown', label: 'Не проверено'}]} /></Form.Item>
                        <Button type="text" aria-label={`Удалить основание ${field.name + 1}`} icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} /></Space>
                    <Form.Item name={[field.name, 'summary']} label="Что подтверждает это основание" rules={[{required: true, whitespace: true, message: 'Добавьте описание.'}, learningTextRule(4096)]}><Input.TextArea autoSize={{minRows: 2, maxRows: 6}} maxLength={4096} /></Form.Item>
                    <Form.Item name={[field.name, 'reference']} label="Ссылка или путь к результату" rules={[learningTextRule(1024)]}><Input maxLength={1024} /></Form.Item>
                    <Form.Item name={[field.name, 'sha256']} label="SHA-256 файла, если известен" rules={[{pattern: /^[a-f0-9]{64}$/i, message: 'SHA-256 должен содержать 64 шестнадцатеричных символа.'}]}><Input maxLength={64} /></Form.Item>
                </div>)}
                <Form.ErrorList errors={errors} /><Button type="dashed" icon={<PlusOutlined />} disabled={fields.length >= 32} onClick={() => add({kind: 'observation', status: 'unknown', summary: ''})}>Добавить основание</Button>
            </>}
        </Form.List>
        <Form.Item name={['context', 'gitCommit']} label="Коммит проекта (необязательно)" rules={[{pattern: /^[a-f0-9]{40,64}$/i, message: 'Укажите полный SHA коммита.'}]}><Input maxLength={64} /></Form.Item>
    </LearningEditorModal>;
}
