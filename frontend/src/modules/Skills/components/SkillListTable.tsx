import { Button, message, Modal, Popconfirm, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, FC, useState } from 'react';
import { useSelector } from 'react-redux';

import Permission from '../../../common/components/Permission';
import { CodeBlock } from '../../../common/components/CodeBlock';
import bffApi from '../../../core/api/bff';
import type { ISkillFile, ISkillListSummary } from '../../../core/api/interfaces';
import { useAppDispatch } from '../../../core/hooks';
import { skillCollectionManageKey, skillsPolitics } from '../../../features/UserBlock/permissions';
import { RootState } from '../../../store';

import { deleteSkill, fetchSkill, fetchSkillList, fetchSkillTree } from '../redux/actions';
import { openEditor } from '../redux/reducers';
import { notifySkillMutation } from '../skillMutationFeedback';

interface ISkillListTableProps {
    /** Путь каталога, для которого показан список (для перезагрузки после изменений). */
    dirPath: string;
}

/** Таблица каталога: просмотр, редактирование и удаление скиллов. */
const { Text } = Typography;

const SkillListTable: FC<ISkillListTableProps> = ({ dirPath }) => {
    const dispatch = useAppDispatch();
    const { skills, listLoading } = useSelector((state: RootState) => state.skills);
    const [ viewSkill, setViewSkill ] = useState<ISkillFile | null>(null);
    const [ viewLoading, setViewLoading ] = useState(false);
    const handleView = useCallback(
        (path: string): void => {
            setViewLoading(true);
            setViewSkill(null);
            bffApi.getSkill(path)
                .then((file) => setViewSkill(file))
                .catch(() => message.error('Не удалось загрузить скилл'))
                .finally(() => setViewLoading(false));
        },
        [],
    );

    const handleEdit = useCallback(
        (path: string): void => {
            dispatch(openEditor({ mode: 'edit', path }));
            dispatch(fetchSkill(path));
        },
        [dispatch],
    );

    const handleDelete = useCallback(
        (path: string): void => {
            dispatch(deleteSkill(path))
                .unwrap()
                .then(result => {
                    notifySkillMutation(result, 'Скилл удалён', 'delete');
                    dispatch(fetchSkillTree());
                    dispatch(fetchSkillList({ path: dirPath }));
                })
                .catch(() => {
                    message.error('Не удалось удалить скилл');
                });
        },
        [dispatch, dirPath],
    );

    const columns: ColumnsType<ISkillListSummary> = [
        { title: 'Наименование', key: 'name', render: (_value, record) => record.meta.name },
        { title: 'Идентификатор', key: 'slug', render: (_value, record) => record.meta.slug },
        { title: 'Версия', key: 'version', render: (_value, record) => `v${record.meta.version}` },
        {
            title: 'MCP',
            key: 'mcp',
            render: (_value, record) =>
                record.meta.mcp.length > 0
                    ? record.meta.mcp.map(item => <Tag key={item} color="blue">{item}</Tag>)
                    : '—',
        },
        {
            title: 'Плагины',
            key: 'plugins',
            render: (_value, record) =>
                record.meta.plugins.length > 0
                    ? record.meta.plugins.map(item => <Tag key={item}>{item}</Tag>)
                    : '—',
        },
        { title: 'Обновлён', key: 'updatedAt', render: (_value, record) => new Date(record.meta.updatedAt).toLocaleDateString('ru-RU') },
        {
            title: 'Действия',
            key: 'actions',
            render: (_value, record) => (
                <Space size="small">
                    <Button size="small" type="primary" ghost onClick={() => handleView(record.path)}>
                        Просмотр
                    </Button>
                    <Permission permissionKey={skillCollectionManageKey} politic={skillsPolitics}>
                        <Space size="small">
                            <Button size="small" onClick={() => handleEdit(record.path)}>
                                Редактировать
                            </Button>
                            <Popconfirm
                                title="Удалить скилл?"
                                okText="Удалить"
                                cancelText="Отмена"
                                onConfirm={() => handleDelete(record.path)}
                            >
                                <Button size="small" danger>
                                    Удалить из каталога
                                </Button>
                            </Popconfirm>
                        </Space>
                    </Permission>
                </Space>
            ),
        },
    ];

    return (
        <>
            <Table
                rowKey="path"
                size="small"
                loading={listLoading}
                dataSource={skills}
                columns={columns}
                pagination={false}
            />
            <Modal
                title={viewSkill ? `Скилл: ${viewSkill.meta.name}` : 'Скилл'}
                open={viewLoading || !!viewSkill}
                onCancel={() => { if (!viewLoading) { setViewSkill(null); } }}
                onOk={() => setViewSkill(null)}
                okText="Закрыть"
                width="72%"
            >
                {viewSkill ? (
                    <div>
                        <Space style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                            <Tag color="blue">v{viewSkill.meta.version}</Tag>
                            <Tag>slug: {viewSkill.meta.slug}</Tag>
                            <Tag>scope: {viewSkill.meta.scope}</Tag>
                            {viewSkill.meta.tags.map(tag => <Tag key={tag} color="geekblue">{tag}</Tag>)}
                        </Space>
                        {viewSkill.meta.description ? (
                            <Typography.Paragraph style={{ marginBottom: 12 }}>{viewSkill.meta.description}</Typography.Paragraph>
                        ) : null}
                        <div style={{ border: '1px solid #e0e0e0', borderRadius: 6, padding: 12, maxHeight: '60vh', overflow: 'auto', background: '#fafafa' }}>
                            <CodeBlock code={viewSkill.body} language="markdown" theme="light" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.5 }} />
                        </div>
                        <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                            Обновлено: {new Date(viewSkill.meta.updatedAt).toLocaleString('ru-RU')} · владелец: {viewSkill.meta.owner}
                        </Text>
                    </div>
                ) : (
                    <div style={{ textAlign: 'center', padding: 24 }}>
                        <Spin />
                    </div>
                )}
            </Modal>

        </>
    );
};

export default SkillListTable;
