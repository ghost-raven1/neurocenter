import { Button, Form, Input, message, Modal, Select } from 'antd';
import { FC, useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';

import { useAppDispatch } from '../../../core/hooks';
import type { ISkillCreateRequest, ISkillUpdateRequest } from '../../../core/api/interfaces';
import { RootState } from '../../../store';

import { createSkill, fetchSkillList, fetchSkillTree, updateSkill } from '../redux/actions';
import { closeEditor } from '../redux/reducers';
import { notifySkillMutation } from '../skillMutationFeedback';

interface ISkillEditorModalProps {
    /** Каталог для создания скилла (selectedPath). */
    dirPath: string;
}

interface IEditorValues {
    name: string;
    slug?: string;
    mcp?: string[];
    plugins?: string[];
    specialization?: string;
    tags?: string[];
    body?: string;
    note?: string;
}

/**
 * Модалка создания/редактирования скилла (`.md`): markdown-тело + мета + связи с MCP/плагинами.
 *
 * @component
 */
const SkillEditorModal: FC<ISkillEditorModalProps> = ({ dirPath }) => {
    const dispatch = useAppDispatch();
    const { editorOpen, editorMode, editorPath, editorSkill, editorSaving } = useSelector(
        (state: RootState) => state.skills,
    );
    const [ form ] = Form.useForm<IEditorValues>();

    useEffect(() => {
        if (!editorOpen) {
            return undefined;
        }

        if (editorMode === 'edit' && editorSkill !== null) {
            form.setFieldsValue({
                name: editorSkill.meta.name,
                mcp: editorSkill.meta.mcp,
                plugins: editorSkill.meta.plugins,
                specialization: editorSkill.meta.specialization,
                tags: editorSkill.meta.tags,
                body: editorSkill.body,
            });
        } else {
            form.resetFields();
        }

        return undefined;
    }, [ editorOpen, editorMode, editorSkill, form ]);

    const handleCancel = useCallback(
        (): void => {
            dispatch(closeEditor());
        },
        [dispatch],
    );

    const handleSave = useCallback((): void => {
        form
            .validateFields()
            .then((values: IEditorValues) => {
                const meta = {
                    mcp: values.mcp ?? [],
                    plugins: values.plugins ?? [],
                    specialization: values.specialization,
                    tags: values.tags ?? [],
                };
                const afterSave = (): void => {
                    dispatch(closeEditor());
                    dispatch(fetchSkillTree());
                    dispatch(fetchSkillList({ path: dirPath }));
                };

                if (editorMode === 'create') {
                    const request: ISkillCreateRequest = {
                        path: dirPath,
                        slug: values.slug ?? '',
                        name: values.name,
                        body: values.body ?? '',
                        meta,
                    };

                    dispatch(createSkill(request))
                        .unwrap()
                        .then(result => {
                            notifySkillMutation(result, 'Скилл создан');
                            afterSave();
                        })
                        .catch(() => message.error('Не удалось создать скилл'));

                    return;
                }

                const request: ISkillUpdateRequest = {
                    name: values.name,
                    body: values.body ?? '',
                    meta,
                    note: values.note,
                };

                dispatch(updateSkill({ path: editorPath ?? '', request }))
                    .unwrap()
                    .then(result => {
                        notifySkillMutation(result, 'Скилл сохранён (новая версия)');
                        afterSave();
                    })
                    .catch(() => message.error('Не удалось сохранить скилл'));
            })
            .catch(() => undefined);
    }, [dispatch, dirPath, editorMode, editorPath, form]);

    const title = editorMode === 'create' ? 'Новый скилл' : `Скилл: ${editorSkill?.meta.name ?? editorPath ?? ''}`;

    return (
        <Modal
            title={title}
            open={editorOpen}
            width={720}
            destroyOnClose
            onCancel={handleCancel}
            footer={[
                <Button key="cancel" onClick={handleCancel}>Отмена</Button>,
                <Button key="save" type="primary" loading={editorSaving} onClick={handleSave}>Сохранить</Button>,
            ]}
        >
            <Form form={form} layout="vertical">
                <Form.Item name="name" label="Наименование" rules={[{ required: true, message: 'Укажите наименование' }]}>
                    <Input placeholder="Например: code-review" />
                </Form.Item>

                {editorMode === 'create' ? (
                    <Form.Item name="slug" label="Идентификатор" rules={[{ required: true, message: 'Укажите идентификатор' }]}>
                        <Input placeholder="через-дефис, напр. code-review" />
                    </Form.Item>
                ) : null}

                <Form.Item label="МCP-серверы" name="mcp">
                    <Select mode="tags" placeholder="mcp-server" />
                </Form.Item>

                <Form.Item label="Плагины" name="plugins">
                    <Select mode="tags" placeholder="plugin" />
                </Form.Item>

                <Form.Item label="Специализация" name="specialization">
                    <Input placeholder="напр. testing" />
                </Form.Item>

                <Form.Item label="Теги" name="tags">
                    <Select mode="tags" placeholder="теги" />
                </Form.Item>

                <Form.Item name="body" label="Содержимое (Markdown)" rules={[{ required: true, message: 'Укажите содержимое' }]}>
                    <Input.TextArea rows={14} placeholder="# SKILL: ..." />
                </Form.Item>

                {editorMode === 'edit' ? (
                    <Form.Item name="note" label="Комментарий к версии">
                        <Input placeholder="что изменилось" />
                    </Form.Item>
                ) : null}
            </Form>
        </Modal>
    );
};

export default SkillEditorModal;
