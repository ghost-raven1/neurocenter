import { Button, message, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, FC, useState } from 'react';
import { useSelector } from 'react-redux';

import Permission from '../../../common/components/Permission';
import { CodeBlock } from '../../../common/components/CodeBlock';
import bffApi from '../../../core/api/bff';
import type { IProjectSummary, ISkillFile, ISkillListSummary } from '../../../core/api/interfaces';
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

interface ILocalScan {
    root: string;
    query: string | null;
    projects: { project: string; path: string; skills: string[]; mcpServers: string[]; plugins: string[] }[];
    scannedCount: number;
    totalProjects: number;
}

/**
 * Таблица скиллов каталога + per-project установка на компьютер
 * (выбор проекта, live-статус «Установлено» по реального скану, установка/удаление SKILL.md).
 *
 * @component
 */
const { Text } = Typography;

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const SkillListTable: FC<ISkillListTableProps> = ({ dirPath }) => {
    const dispatch = useAppDispatch();
    const { skills, listLoading } = useSelector((state: RootState) => state.skills);
    const [ projects, setProjects ] = useState<IProjectSummary[]>([]);
    const [ projectName, setProjectName ] = useState('');
    const [ installed, setInstalled ] = useState<Set<string>>(new Set());
    const [ scanLoading, setScanLoading ] = useState(false);
    const [ viewSkill, setViewSkill ] = useState<ISkillFile | null>(null);
    const [ viewLoading, setViewLoading ] = useState(false);
    const [ installSkill, setInstallSkill ] = useState<ISkillListSummary | null>(null);
    const [ installLoading, setInstallLoading ] = useState(false);
    const [ installBody, setInstallBody ] = useState('');
    const [ installing, setInstalling ] = useState(false);

    useEffect(() => {
        bffApi.listProjects({ page: 1, size: 50 }).then((page) => setProjects(page.items)).catch(() => setProjects([]));
    }, []);

    const rescan = useCallback((name: string): void => {
        if (!name) {
            setInstalled(new Set());
            return;
        }
        setScanLoading(true);
        bffApi.scanLocalAssets({ q: name })
            .then((res: ILocalScan) => {
                const selected = (res.projects ?? []).find((p) => p.project === name);
                const slugs = selected?.skills ?? [];
                setInstalled(new Set(slugs));
            })
            .catch(() => setInstalled(new Set()))
            .finally(() => setScanLoading(false));
    }, []);

    useEffect(() => {
        rescan(projectName);
    }, [ projectName, rescan ]);

    const isInstalled = (slug: string): boolean => installed.has(slug) || installed.has(norm(slug));

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

    const handleOpenInstall = useCallback(
        (record: ISkillListSummary): void => {
            setInstallSkill(record);
            setInstallBody('');
            setInstallLoading(true);
            bffApi.getSkill(record.path)
                .then((file) => setInstallBody(file.body || ''))
                .catch(() => message.error('Не удалось загрузить содержимое скилла'))
                .finally(() => setInstallLoading(false));
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

    const doInstall = useCallback(
        (slug: string, body: string, action: 'install' | 'uninstall'): void => {
            if (!projectName) {
                message.warning('Сначала выберите проект');
                return;
            }
            setInstalling(true);
            bffApi.installLocalAsset({
                kind: 'skill',
                name: slug,
                projectName,
                content: action === 'install' ? body : undefined,
                action,
            })
                .then(() => {
                    message.success(action === 'install' ? `Скилл «${slug}» установлен в «${projectName}»` : `Скилл «${slug}» удалён из «${projectName}»`);
                    setInstallSkill(null);
                    rescan(projectName);
                })
                .catch(() => message.error('Не удалось установить скилл'))
                .finally(() => setInstalling(false));
        },
        [ projectName, rescan ],
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
            title: 'Установлено',
            key: 'installed',
            render: (_value, record) => (isInstalled(record.meta.slug) ? <Tag color="green">Установлено</Tag> : <Tag>—</Tag>),
        },
        {
            title: 'Действия',
            key: 'actions',
            render: (_value, record) => (
                <Space size="small">
                    <Button size="small" type="primary" ghost onClick={() => handleView(record.path)}>
                        Просмотр
                    </Button>
                    <Button
                        size="small"
                        type="primary"
                        loading={installing}
                        onClick={() => {
                            if (isInstalled(record.meta.slug) && projectName) {
                                doInstall(record.meta.slug, '', 'uninstall');
                            } else {
                                handleOpenInstall(record);
                            }
                        }}
                    >
                        {isInstalled(record.meta.slug) ? 'Удалить' : 'Установить'}
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
            <Space style={{ marginBottom: 12 }} wrap>
                <Text strong>Проект для установки:</Text>
                <Select
                    style={{ minWidth: 280 }}
                    placeholder="Выберите проект (каталог локальных проектов)"
                    value={projectName || undefined}
                    onChange={(v: string) => setProjectName(v)}
                    allowClear
                    loading={scanLoading}
                    options={projects.map((p) => ({ label: p.name, value: p.name }))}
                />
                {projectName && <Button size="small" type="link" onClick={() => rescan(projectName)}>Обновить статус</Button>}
            </Space>
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
            <Modal
                title={installSkill ? `Установка скилла «${installSkill.meta.name}» на компьютер` : ''}
                open={!!installSkill}
                onCancel={() => { if (!installLoading) { setInstallSkill(null); } }}
                footer={[
                    <Button key="copy" onClick={() => { void navigator.clipboard?.writeText(installBody); message.success('Скопировано в буфер обмена'); }}>
                        Скопировать
                    </Button>,
                    <Button
                        key="install"
                        type="primary"
                        loading={installing}
                        onClick={() => { if (installSkill) { doInstall(installSkill.meta.slug, installBody, 'install'); } }}
                    >
                        Установить в проект
                    </Button>,
                ]}
                width="72%"
            >
                {installSkill && (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <ol style={{ margin: 0, paddingLeft: 18 }}>
                            <li>Убедитесь, что выбран проект (поверх таблицы) и установлен <b>OpenCode</b>.</li>
                            <li>«Установить в проект» создаст <b>{`.opencode/skills/${installSkill.meta.slug}/SKILL.md`}</b> с содержимым ниже.</li>
                            <li>Перезапустите сессию OpenCode — скилл подхватится автоматически.</li>
                        </ol>
                        {installLoading
                            ? <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
                            : <div style={{ border: '1px solid #e0e0e0', borderRadius: 6, padding: 12, maxHeight: '55vh', overflow: 'auto', background: '#1f1f1f' }}>
                                <CodeBlock code={installBody || '(пусто)'} language="markdown" theme="dark" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5 }} />
                            </div>}
                    </Space>
                )}
            </Modal>
        </>
    );
};

export default SkillListTable;
