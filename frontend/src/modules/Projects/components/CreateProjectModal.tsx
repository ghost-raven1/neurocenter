import { Alert, Collapse, Form, Input, Modal, message } from 'antd';
import { FC, useRef, useState } from 'react';

import { useAppDispatch } from '../../../core/hooks';
import { createProject } from '../redux/actions';
import { useAuthRequestOwner } from '../../../features/UserBlock/useAuthRequestOwner';
import { submitProjectCreation } from '../projectCreation';

interface ICreateFormValues { name: string; externalResourceId?: string; }
interface IProps { open: boolean; onClose: () => void; onCreated: (id: string) => void; }

/** Создание проекта: обязательное имя и дополнительные настройки по запросу. */
const CreateProjectModal: FC<IProps> = ({open, onClose, onCreated}) => {
    const { captureOwner } = useAuthRequestOwner();
    const dispatch = useAppDispatch();
    const [form] = Form.useForm<ICreateFormValues>();
    const [saving, setSaving] = useState(false);
    const lock=useRef(false);
    const submit = async (values: ICreateFormValues): Promise<void> => {
        const isCurrent = captureOwner();
        if (!isCurrent()) { return; }
        if(lock.current){return;}lock.current=true;
        setSaving(true);
        try {
            await submitProjectCreation({
                isCurrent,
                create: () => dispatch(createProject({name:values.name.trim(),externalResourceId:values.externalResourceId?.trim() ?? ''})).unwrap(),
                onCreated: id => {
                    message.success('Проект создан. Можно добавлять инструменты.');
                    form.resetFields(); onCreated(id);
                },
                onError: error => { message.error(typeof error === 'string' ? error : 'Не удалось создать проект. Проверьте данные и повторите попытку.'); },
            });
        } finally { if(isCurrent()){lock.current=false;setSaving(false);} }
    };
    return <Modal title="Новый проект" open={open} onCancel={()=>{if(!lock.current){onClose();}}} onOk={() => form.submit()} confirmLoading={saving} okText="Создать проект" cancelText="Отмена" destroyOnClose closable={!saving} keyboard={!saving} maskClosable={!saving} cancelButtonProps={{disabled:saving}}>
        <Form form={form} layout="vertical" onFinish={values => { void submit(values); }} preserve={false}>
            <Form.Item name="name" label="Название проекта" extra="Название команды или продукта, в том числе по-русски. Локальная папка связывается отдельно." rules={[{required:true,whitespace:true,message:'Введите название проекта'},{max:128,message:'До 128 символов'},{pattern:/^[^/\\\x00-\x1f]+$/,message:'Без слешей и управляющих символов'}]}><Input placeholder="Например, team-portal" autoFocus /></Form.Item>
            <Collapse ghost><Collapse.Panel key="settings" header="Дополнительные настройки">
                <Form.Item name="externalResourceId" label="Внешний идентификатор" extra="Заполняется, если используется внешний сервис прав."><Input placeholder="Необязательно" /></Form.Item>
            </Collapse.Panel></Collapse>
            <Alert showIcon type="info" message="Лимит базы знаний включается автоматически" description="После создания проекта администратор может проверить и изменить его на вкладке «Квоты»." />
        </Form>
    </Modal>;
};
export default CreateProjectModal;
