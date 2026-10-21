import {Checkbox, Form, Input, Select} from 'antd';
import {LearningEditorModal} from './LearningEditorModal';
import {checkResultLabel} from './model';
import type {LearningCommand, LearningEditorState, LearningExperience, LearningHypothesis} from './types';
import {learningTextRule} from './validation';

interface Values {result: 'passed' | 'failed' | 'inconclusive'; summary: string; experienceIds: string[]; confirmed: boolean}
interface Props {revision: number; hypothesis: LearningHypothesis; experiences: LearningExperience[]; state: LearningEditorState; onClose: () => void; onSubmit: (command: LearningCommand, revision: number) => Promise<boolean>}

export function LearningCheckModal(props: Props): JSX.Element {
    return <LearningEditorModal<Values> title={`Результат проверки · ${props.hypothesis.title}`} submitText="Записать проверку" currentRevision={props.revision} state={props.state} onClose={props.onClose}
        initialValues={{result: 'inconclusive', summary: '', experienceIds: [], confirmed: false}}
        description="Сначала выполните проверку по плану гипотезы. Здесь фиксируются её фактический результат и основания; форма сама не запускает тесты."
        onSubmit={(value, revision) => props.onSubmit({kind: 'check', hypothesisId: props.hypothesis.id, value: {result: value.result, summary: value.summary, experienceIds: value.experienceIds, method: 'human_review'}}, revision)}>
        <Form.Item label="План проверки"><div className="project-learning__text">{props.hypothesis.verificationPlan}</div></Form.Item>
        <Form.Item name="result" label="Результат" rules={[{required: true}]}><Select options={Object.entries(checkResultLabel).map(([value, label]) => ({value, label}))} /></Form.Item>
        <Form.Item name="summary" label="Что проверено, что получилось и какие есть ограничения" rules={[{required: true, whitespace: true}, learningTextRule(8192)]}><Input.TextArea autoSize={{minRows: 4, maxRows: 12}} maxLength={8192} /></Form.Item>
        <Form.Item name="experienceIds" label="Опыт с результатами проверки" rules={[{required: true, type: 'array', min: 1, max: 50, message: 'Выберите от 1 до 50 записей с результатами проверки.'}]}><Select mode="multiple" optionFilterProp="label" options={props.experiences.map(item => ({value: item.id, label: item.title}))} /></Form.Item>
        <Form.Item name="confirmed" valuePropName="checked" rules={[{validator: async (_, value: boolean) => {if (!value) throw new Error('Подтвердите выполнение проверки.');}}]}><Checkbox>Проверка выполнена; я подтверждаю описанный результат</Checkbox></Form.Item>
    </LearningEditorModal>;
}
