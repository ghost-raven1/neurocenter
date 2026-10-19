import { Form, Input, InputNumber, Modal } from 'antd';
import { FC, useEffect } from 'react';

export interface ICasValues {
    expectedHeadId: string;
    expectedHeadRevision: number;
}

interface IConfirmCasModalProps {
    open: boolean;
    title: string;
    confirmText?: string;
    loading?: boolean;
    defaultExpectedId?: string;
    defaultExpectedRevision?: number;
    onConfirm: (values: ICasValues) => void | Promise<void>;
    onCancel: () => void;
}

/**
 * Модальное окно подтверждения CAS-операций (активация head, rollback, релиз).
 * Показывает текущий head и требует подтвердить ожидаемые ID + revision,
 * защищая от конфликта и ABA после rollback.
 *
 * @component
 * @param {boolean} props.open - видимо ли окно
 * @param {string} props.title - заголовок
 * @param {string} [props.confirmText] - текст кнопки подтверждения
 * @param {boolean} [props.loading] - идёт ли подтверждение
 * @param {string} [props.defaultExpectedId] - предраскрытый expected ID
 * @param {number} [props.defaultExpectedRevision] - предраскрытая expected revision
 * @param {(values) => void | Promise<void>} props.onConfirm - подтверждение
 * @param {() => void} props.onCancel - отмена
 */
const ConfirmCasModal: FC<IConfirmCasModalProps> = ({
    open,
    title,
    confirmText = 'Подтвердить',
    loading = false,
    defaultExpectedId,
    defaultExpectedRevision,
    onConfirm,
    onCancel,
}) => {
    const [ form ] = Form.useForm<ICasValues>();

    useEffect(() => {
        if (open) {
            form.setFieldsValue({
                expectedHeadId: defaultExpectedId ?? '',
                expectedHeadRevision: defaultExpectedRevision ?? 0,
            });
        }
    }, [ open, defaultExpectedId, defaultExpectedRevision, form ]);

    const handleOk = async (): Promise<void> => {
        const values = await form.validateFields();
        await onConfirm(values);
    };

    return (
        <Modal open={open} title={title} onOk={handleOk} onCancel={onCancel} confirmLoading={loading} okText={confirmText}>
            <Form form={form} layout="vertical">
                <Form.Item
                    name="expectedHeadId"
                    label="Ожидаемый head ID"
                    rules={[ { required: true, message: 'Введите ID текущей версии' } ]}
                >
                    <Input placeholder="snapshot id" />
                </Form.Item>
                <Form.Item
                    name="expectedHeadRevision"
                    label="Ожидаемая revision"
                    rules={[ { required: true, message: 'Введите revision' } ]}
                >
                    <InputNumber style={{ width: '100%' }} min={0} />
                </Form.Item>
            </Form>
        </Modal>
    );
};

export default ConfirmCasModal;
