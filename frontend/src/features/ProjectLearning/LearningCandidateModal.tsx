import {Alert, Form, Input, Select} from 'antd';
import type {IProjectAgent} from '../AgentCatalog/types';
import {LearningEditorModal} from './LearningEditorModal';
import type {LearningCandidate, LearningCandidateInput, LearningCommand, LearningEditorState, LearningHypothesis} from './types';
import {learningTextRule} from './validation';

type Values = Omit<LearningCandidateInput, 'requestKey' | 'expectedRevision' | 'hypothesisId'>;
interface Props {revision: number; hypothesis: LearningHypothesis; previous?: LearningCandidate; agents: IProjectAgent[]; state: LearningEditorState; onClose: () => void; onSubmit: (command: LearningCommand, revision: number) => Promise<boolean>}

export function LearningCandidateModal(props: Props): JSX.Element {
    const checks = props.hypothesis.checks.filter(check => check.method === 'human_review' && check.result === 'passed');
    return <LearningEditorModal<Values> title="Подготовить знание к одобрению" submitText="Отправить на одобрение" currentRevision={props.revision} state={props.state} onClose={props.onClose}
        initialValues={{checkId: props.previous && checks.some(check => check.id === props.previous!.checkId) ? props.previous.checkId : checks[checks.length - 1]?.id ?? '', key: props.previous?.key ?? '', kind: props.previous?.kind ?? (props.hypothesis.subject === 'agent' ? 'instruction' : 'lesson'), title: props.previous?.title ?? props.hypothesis.title, content: props.previous?.content ?? props.hypothesis.statement, ...(props.previous?.targetAgentId ? {targetAgentId: props.previous.targetAgentId} : {})}}
        description="Отредактируйте будущий вывод или инструкцию. После сохранения появится кандидат; действующим контекстом он станет только после отдельного одобрения."
        onSubmit={(value, revision) => props.onSubmit({kind: 'candidate', value: {...value, hypothesisId: props.hypothesis.id, ...(value.targetAgentId ? {} : {targetAgentId: undefined})}}, revision)}>
        {props.hypothesis.status !== 'supported' && <Alert showIcon type="warning" message="Гипотеза больше не поддержана проверкой. Сервер повторно проверит основания кандидата." className="project-learning__notice" />}
        <Form.Item name="checkId" label="Подтверждающая проверка" rules={[{required: true}]}><Select options={checks.map(check => ({value: check.id, label: check.summary.slice(0, 160)}))} /></Form.Item>
        <Form.Item name="kind" label="Что будет принято" rules={[{required: true}]}><Select options={[{value: 'lesson', label: 'Вывод о проекте'}, {value: 'instruction', label: 'Инструкция для агента'}]} /></Form.Item>
        <Form.Item name="key" label="Постоянный ключ знания" extra="Один ключ объединяет версии. Чтобы заменить принятое знание, используйте его прежний ключ. Например: testing-before-release." rules={[{required: true}, {pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Латиница в нижнем регистре и цифры; слова разделяются дефисом.'}, {max: 64}]}><Input maxLength={64} /></Form.Item>
        <Form.Item name="title" label="Название" rules={[{required: true, whitespace: true}, learningTextRule(256)]}><Input maxLength={256} /></Form.Item>
        <Form.Item name="content" label="Текст знания или инструкции" rules={[{required: true, whitespace: true}, learningTextRule(16384)]}><Input.TextArea className="learning-editor__content" autoSize={{minRows: 7, maxRows: 18}} maxLength={16384} /></Form.Item>
        <Form.Item name="targetAgentId" label="Для какого агента" extra="Оставьте пустым, чтобы использовать в контексте всего проекта."><Select allowClear optionFilterProp="label" showSearch options={props.agents.filter(agent => !agent.removed).map(agent => ({value: agent.agentId, label: agent.card.name}))} /></Form.Item>
    </LearningEditorModal>;
}
