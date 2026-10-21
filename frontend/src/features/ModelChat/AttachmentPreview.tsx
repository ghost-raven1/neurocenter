import {Alert, Modal, Spin, Typography} from 'antd';
import {useEffect, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelChatApi} from './api';
import type {IModelChatAttachmentPreview} from './types';

interface Props {conversationId: string; attachmentId: string; onClose: () => void;}

/** The preview is extracted plain text, never an HTML document or an executable original. */
export function AttachmentPreview({conversationId, attachmentId, onClose}: Props): JSX.Element {
    const {captureOwner} = useAuthRequestOwner();
    const [value, setValue] = useState<IModelChatAttachmentPreview>(), [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController(), owns = captureOwner();
        void modelChatApi.previewAttachment(conversationId, attachmentId, controller.signal)
            .then(result => {if (owns() && !controller.signal.aborted) setValue(result);})
            .catch(cause => {if (owns() && !controller.signal.aborted) setError(errorMessage(cause, 'Не удалось открыть документ.'));});
        return () => controller.abort();
    }, [conversationId, attachmentId, captureOwner]);
    return <Modal open centered width={800} title={value?.attachment.name || 'Текст документа'} onCancel={onClose} footer={null} className="model-chat-preview">
        {error && <Alert type="error" showIcon message={error}/>}{!value && !error && <Spin tip="Загружаем текст…"/>}
        {value && <><Typography.Paragraph type="secondary">Этот текст включается в сообщение модели. Документ не добавляется в базу знаний проекта.</Typography.Paragraph><pre>{value.text}</pre></>}
    </Modal>;
}
