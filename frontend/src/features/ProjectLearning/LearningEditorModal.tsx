import { FeatureButton, useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import {Alert, Button, Form, Modal, Space, Typography} from 'antd';
import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {useUnsavedLearning} from './useUnsavedLearning';
import type {LearningEditorState} from './types';

interface Props<T extends object> {
    title: string; submitText: string; currentRevision: number; initialValues: T;
    state: LearningEditorState; children: ReactNode; description?: ReactNode;
    onClose: () => void; onSubmit: (value: T, revision: number) => Promise<boolean>;
    recovery?: boolean;
}

/** A CAS conflict preserves the draft and requires an explicit choice before using the new revision. */
export function LearningEditorModal<T extends object>(props: Props<T>): JSX.Element {
    const availability = useFeatureAvailability(...(props.recovery ? [] : ['project_learning' as const]));
    const [form] = Form.useForm<T>();
    const formId = useId();
    const [revision, setRevision] = useState(props.currentRevision), [dirty, setDirty] = useState(false);
    const confirmation = useRef<{destroy(): void}>();
    const notice = useRef<HTMLDivElement>(null);
    useUnsavedLearning(dirty);
    useEffect(() => () => confirmation.current?.destroy(), []);
    useEffect(() => {
        if (props.state.error || props.state.conflict || props.state.unconfirmed) notice.current?.scrollIntoView({block: 'nearest'});
    }, [props.state.error, props.state.conflict, props.state.unconfirmed]);
    const close = (): void => {
        if (props.state.busy) return;
        if (props.state.unconfirmed) {props.onClose(); return;}
        if (!dirty) {props.onClose(); return;}
        confirmation.current = Modal.confirm({title: 'Закрыть без сохранения?', content: 'Несохранённый текст останется только в этой форме.', okText: 'Закрыть', cancelText: 'Продолжить редактирование', onOk: props.onClose});
    };
    const submit = async (value: T): Promise<void> => {
        if (!availability.enabled) return;
        if (props.state.busy || props.state.unconfirmed || props.state.conflict && revision !== props.currentRevision) return;
        if (await props.onSubmit(value, revision)) props.onClose();
    };
    return <Modal open centered destroyOnClose width={720} className="learning-editor" title={props.title} onCancel={close}
        footer={<div className="learning-editor__actions"><Button disabled={props.state.busy} onClick={close}>{props.state.unconfirmed ? 'Закрыть и проверить результат' : 'Отмена'}</Button><Space wrap>
            <FeatureButton features={props.recovery ? [] : ['project_learning']} type="primary" htmlType="submit" form={formId} loading={props.state.busy} disabled={props.state.unconfirmed || props.state.conflict && revision !== props.currentRevision}>{props.submitText}</FeatureButton>
        </Space></div>} maskClosable={false} keyboard={!props.state.busy} closable={!props.state.busy}>
        {props.description && <Typography.Paragraph type="secondary">{props.description}</Typography.Paragraph>}
        <div ref={notice}>
        {props.state.error && <Alert className="project-learning__notice" type="error" showIcon message={props.state.error} />}
        {props.state.unconfirmed && <Alert className="project-learning__notice" type="warning" showIcon message="Ответ запроса ещё не подтверждён" description="Квитанция с исходным текстом сохранена. Закройте форму и проверьте результат в блоке восстановления запроса." />}
        {props.state.conflict && <Alert className="project-learning__notice" type="warning" showIcon message="Проект изменился. Ваш текст сохранён в форме."
            description={<><Typography.Paragraph>Проверьте актуальные сведения проекта перед повторным сохранением.</Typography.Paragraph><Button disabled={props.state.busy || revision === props.currentRevision} onClick={() => setRevision(props.currentRevision)}>Использовать актуальную ревизию {props.currentRevision}</Button></>} />}
        </div>
        <Form id={formId} form={form} layout="vertical" scrollToFirstError initialValues={props.initialValues} disabled={props.state.busy || props.state.unconfirmed} onValuesChange={() => setDirty(true)} onFinish={value => {void submit(value);}}>
            {props.children}
        </Form>
    </Modal>;
}
