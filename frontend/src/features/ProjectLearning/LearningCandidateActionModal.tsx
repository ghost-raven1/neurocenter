import { Alert, Checkbox, Form, Input, Tag, Typography } from 'antd';
import { LearningEditorModal } from './LearningEditorModal';
import type { LearningCandidate, TLearningCommand, ILearningEditorState } from './interfaces';
import { learningTextRule } from './validation';

type TAction = 'approve' | 'reject' | 'revoke' | 'activate';
interface IValues {
    reason: string;
    confirmed: boolean;
}
interface IProps {
    revision: number;
    candidate: LearningCandidate;
    action: TAction;
    state: ILearningEditorState;
    onClose: () => void;
    onSubmit: (command: TLearningCommand, revision: number) => Promise<boolean>;
}
const labels: Record<TAction, string> = {
    approve: 'Одобрить знание',
    reject: 'Отклонить кандидата',
    revoke: 'Отозвать знание',
    activate: 'Вернуть эту версию',
};
const descriptions: Record<TAction, string> = {
    approve:
        'Эта версия станет действующей для своего ключа и появится в контексте обучения проекта. Ранее принятая версия этого ключа сохранится в истории.',
    reject: 'Кандидат останется в истории, но не попадёт в действующий контекст проекта.',
    revoke: 'Эта версия перестанет использоваться. Более старая версия не будет включена автоматически.',
    activate:
        'Выбранная ранее одобренная версия снова станет действующей. Текущая версия этого ключа сохранится в истории.',
};

export function LearningCandidateActionModal(props: IProps): JSX.Element {
    return (
        <LearningEditorModal<IValues>
            title={labels[props.action]}
            submitText={labels[props.action]}
            currentRevision={props.revision}
            state={props.state}
            onClose={props.onClose}
            initialValues={{ reason: '', confirmed: false }}
            description={descriptions[props.action]}
            recovery={props.action === 'revoke'}
            onSubmit={({ reason }, revision) =>
                props.onSubmit({ kind: props.action, candidateId: props.candidate.id, value: { reason } }, revision)
            }
        >
            <Typography.Paragraph>
                <Typography.Text strong>{props.candidate.title}</Typography.Text> <Tag>v{props.candidate.version}</Tag>
                <Typography.Text code>{props.candidate.key}</Typography.Text>
            </Typography.Paragraph>
            <div className="project-learning__text project-learning__preview">{props.candidate.content}</div>
            {props.action === 'approve' && (
                <Alert
                    type="info"
                    showIcon
                    className="project-learning__notice"
                    message="Действует только в этом проекте. Гипотезы и история проверок сами по себе не применяются к агентам."
                />
            )}
            <Form.Item
                name="reason"
                label="Основание решения"
                rules={[
                    { required: true, whitespace: true, message: 'Кратко поясните решение.' },
                    learningTextRule(2048),
                ]}
            >
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={2048} />
            </Form.Item>
            <Form.Item
                name="confirmed"
                valuePropName="checked"
                rules={[
                    {
                        validator: async (_, value: boolean) => {
                            if (!value) throw new Error('Подтвердите решение.');
                        },
                    },
                ]}
            >
                <Checkbox>Я проверил текст и подтверждаю это решение</Checkbox>
            </Form.Item>
        </LearningEditorModal>
    );
}
