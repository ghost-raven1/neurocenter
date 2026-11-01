import { Form, Input, Select } from 'antd';
import { LearningEditorModal } from './LearningEditorModal';
import type { TLearningCommand, ILearningEditorState, LearningExperience, LearningHypothesisDraft } from './interfaces';
import { learningTextRule } from './validation';

interface IProps {
    revision: number;
    experiences: LearningExperience[];
    state: ILearningEditorState;
    onClose: () => void;
    onSubmit: (command: TLearningCommand, revision: number) => Promise<boolean>;
}
export function LearningHypothesisModal(props: IProps): JSX.Element {
    return (
        <LearningEditorModal<LearningHypothesisDraft>
            title="Предложить гипотезу"
            submitText="Создать гипотезу"
            currentRevision={props.revision}
            state={props.state}
            onClose={props.onClose}
            initialValues={{
                subject: 'project',
                title: '',
                statement: '',
                rationale: '',
                verificationPlan: '',
                experienceIds: [],
            }}
            description="Гипотеза остаётся предположением до проверки. Её исходный текст и основания сохранятся в истории."
            onSubmit={(value, revision) => props.onSubmit({ kind: 'hypothesis', value }, revision)}
        >
            <Form.Item name="subject" label="Направление" rules={[{ required: true }]}>
                <Select
                    options={[
                        { value: 'project', label: 'Знания о проекте и данных' },
                        { value: 'agent', label: 'Улучшение работы агентов' },
                    ]}
                />
            </Form.Item>
            <Form.Item
                name="title"
                label="Название"
                rules={[{ required: true, whitespace: true }, learningTextRule(256)]}
            >
                <Input maxLength={256} />
            </Form.Item>
            <Form.Item
                name="statement"
                label="Предположение"
                rules={[{ required: true, whitespace: true }, learningTextRule(8192)]}
            >
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} maxLength={8192} />
            </Form.Item>
            <Form.Item
                name="rationale"
                label="Почему это может быть верно"
                rules={[{ required: true, whitespace: true }, learningTextRule(8192)]}
            >
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} maxLength={8192} />
            </Form.Item>
            <Form.Item
                name="experienceIds"
                label="На каком опыте основана"
                rules={[
                    {
                        required: true,
                        type: 'array',
                        min: 1,
                        max: 50,
                        message: 'Выберите от 1 до 50 оснований из опыта проекта.',
                    },
                ]}
            >
                <Select
                    mode="multiple"
                    optionFilterProp="label"
                    options={props.experiences.map((item) => ({ value: item.id, label: item.title }))}
                />
            </Form.Item>
            <Form.Item
                name="verificationPlan"
                label="Как проверить и что опровергнет гипотезу"
                rules={[{ required: true, whitespace: true }, learningTextRule(8192)]}
            >
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} maxLength={8192} />
            </Form.Item>
        </LearningEditorModal>
    );
}
