import { ClockCircleOutlined, RollbackOutlined, SaveOutlined } from '@ant-design/icons';
import { Button, Card, Drawer, Empty, Input, List, message, Space, Spin, Table, Tag, Tree, Typography } from 'antd';
import { FC, useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import bffApi from '../../core/api/bff';
import type { IAiPlugin, IAiPluginFile, IAiPluginVersion } from '../../core/api/interfaces';
import { isMainAdminRole } from '../../features/UserBlock/roles';
import { RootState } from '../../store';

const { Title, Text } = Typography;

interface ITreeDataNode {
    title: string;
    key: string;
}

/**
 * Экран «MCP-бандлы»: каталог бандлов + просмотр/редактирование файлов,
 * версии (immutable history) и откат (rollback) к версии.
 *
 * @component
 * @returns JSX-элемент каталога бандлов MCP/плагинов
 */
const McpBundles: FC = () => {
    const [ bundles, setBundles ] = useState<IAiPlugin[]>([]);
    const [ loading, setLoading ] = useState(true);
    const [ active, setActive ] = useState<IAiPlugin | null>(null);
    const [ selectedPath, setSelectedPath ] = useState<string | null>(null);
    const [ fileContent, setFileContent ] = useState('');
    const [ fileLoading, setFileLoading ] = useState(false);
    const [ versions, setVersions ] = useState<IAiPluginVersion[]>([]);
    const [ rollingBack, setRollingBack ] = useState<number | null>(null);
    const [ saving, setSaving ] = useState(false);
    const user = useSelector((state: RootState) => state.userBlock.user);
    const canWrite = isMainAdminRole(user !== null ? user.activeRole : null);

    /**
     * Загрузка списка бандлов из каталога.
     */
    const loadBundles = useCallback(async (): Promise<void> => {
        setLoading(true);
        try {
            const page = await bffApi.listAiPlugins();
            setBundles(page.items);
        } catch {
            message.error('Не удалось загрузить каталог бандлов');
            setBundles([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadBundles();
    }, [ loadBundles ]);

    /**
     * Перезагрузить открытый бандл (свежие файлы/версии), сохранив выбранный файл, если он есть.
     *
     * @param id - id бандла.
     * @param keepPath - файл, который нужно оставить открытым.
     */
    const reloadActive = useCallback(async (id: string, keepPath: string | null): Promise<void> => {
        const fresh = await bffApi.getAiPlugin(id);
        setActive(fresh);
        setVersions(await bffApi.listAiPluginVersions(id).catch(() => [] as IAiPluginVersion[]));
        const target = keepPath !== null && fresh.files.some(f => f.path === keepPath)
            ? keepPath
            : (fresh.files.length > 0 ? fresh.files[0].path : null);
        setSelectedPath(target);
        if (target !== null) {
            const file = await bffApi.getAiPluginFile(id, target).catch(() => null);
            setFileContent(file !== null ? (file.content ?? '') : '');
        } else {
            setFileContent('');
        }
    }, []);

    /**
     * Открыть бандл (drawer).
     *
     * @param id - id бандла.
     */
    const openBundle = useCallback((id: string): void => {
        void reloadActive(id, null).catch(() => message.error('Не удалось открыть бандл'));
    }, [ reloadActive ]);

    /**
     * Открыть файл бандла (прочитать текст).
     *
     * @param path - путь файла.
     */
    const selectFile = useCallback((path: string): void => {
        if (active === null) {
            return;
        }
        setSelectedPath(path);
        setFileLoading(true);
        bffApi.getAiPluginFile(active.id, path)
            .then(file => setFileContent(file.content ?? ''))
            .catch(() => message.error('Не удалось открыть файл'))
            .finally(() => setFileLoading(false));
    }, [ active ]);

    /**
     * Откат head бандла к версии.
     *
     * @param version - номер версии.
     */
    const doRollback = useCallback((version: number): void => {
        if (active === null) {
            return;
        }
        setRollingBack(version);
        bffApi.activateAiPluginVersion(active.id, version)
            .then(async () => {
                message.success(`Версия ${version} активирована (head)`);
                await loadBundles();
                await reloadActive(active.id, selectedPath);
            })
            .catch(() => message.error('Не удалось выполнить откат'))
            .finally(() => setRollingBack(null));
    }, [ active, loadBundles, reloadActive, selectedPath ]);

    /**
     * Сохранить отредактированный файл (новая версия бандла).
     */
    const saveEdit = useCallback((): void => {
        if (active === null || selectedPath === null) {
            return;
        }
        setSaving(true);
        const files: IAiPluginFile[] = active.files.map(f => (
            f.path === selectedPath
                ? { path: f.path, size: f.size, digest: f.digest, content: fileContent }
                : { path: f.path, size: f.size, digest: f.digest, content: f.content ?? '' }
        ));
        bffApi.updateAiPlugin(active.id, { files })
            .then(async () => {
                message.success('Сохранено (создана новая версия)');
                await loadBundles();
                await reloadActive(active.id, selectedPath);
            })
            .catch(() => message.error('Не удалось сохранить'))
            .finally(() => setSaving(false));
    }, [ active, selectedPath, fileContent, loadBundles, reloadActive ]);

    const columns = [
        { title: 'Имя', dataIndex: 'name', key: 'name', render: (name: string) => <Text strong>{ name }</Text> },
        { title: 'Тип', dataIndex: 'kind', key: 'kind', width: 100, render: (kind: string) => <Tag color="blue">{ kind }</Tag> },
        { title: 'Версия', dataIndex: 'version', key: 'version', width: 90 },
        { title: 'Файлов', key: 'files', width: 90, render: (_: unknown, record: IAiPlugin) => record.files.length },
        { title: 'Обновлён', dataIndex: 'updatedAt', key: 'updatedAt', width: 170, render: (v: string) => <Text type="secondary">{ new Date(v).toLocaleString() }</Text> },
    ];

    const treeData: ITreeDataNode[] = (active !== null ? active.files : []).map(f => ({ title: f.path, key: f.path }));

    return (
        <Card title={<Title level={4} style={{ margin: 0 }}>MCP-бандлы</Title>} loading={loading}>
            <Text type="secondary">
                Каталог бандлов (MCP/плагины/скиллы) с деревьями файлов. Клик по строке — просмотр/редактирование файлов, версии и откат.
            </Text>
            <Table
                style={{ marginTop: 16 }}
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={bundles}
                pagination={{ pageSize: 20 }}
                onRow={record => ({ onClick: () => openBundle(record.id), style: { cursor: 'pointer' } })}
            />

            <Drawer
                title={active !== null ? `${ active.name } (${ active.kind }, v${ active.version })` : 'Бандл'}
                width={860}
                open={active !== null}
                onClose={() => { setActive(null); setSelectedPath(null); setFileContent(''); }}
            >
                <Spin spinning={fileLoading}>
                    <Space direction="vertical" size={16} style={{ width: '100%' }}>
                        <Space wrap>
                            <Tree
                                style={{ width: 300 }}
                                showLine
                                blockNode
                                treeData={treeData}
                                selectedKeys={selectedPath !== null ? [ selectedPath ] : []}
                                onSelect={keys => {
                                    const k = keys[0];
                                    if (typeof k === 'string') {
                                        selectFile(k);
                                    }
                                }}
                            />
                        </Space>
                        {selectedPath !== null ? (
                            <>
                                <Space align="start" style={{ width: '100%' }}>
                                    <div style={{ flex: 1 }}>
                                        <Input.TextArea
                                            rows={20}
                                            value={fileContent}
                                            onChange={e => setFileContent(e.target.value)}
                                        />
                                    </div>
                                </Space>
                                <Space>
                                    <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!canWrite} onClick={saveEdit}>
                                        Сохранить (новая версия)
                                    </Button>
                                    <Text type="secondary">Файл: { selectedPath }</Text>
                                    {!canWrite && (
                                        <Text type="warning">
                                            Только просмотр: запись в каталог бандлов доступна только «Главному админу».
                                        </Text>
                                    )}
                                </Space>
                            </>
                        ) : (
                            <Empty description="Выберите файл" />
                        )}
                        <Card size="small" title="Версии" extra={<ClockCircleOutlined />}>
                            <List
                                size="small"
                                dataSource={versions}
                                locale={{ emptyText: 'Нет версий' }}
                                renderItem={v => (
                                    <List.Item
                                        actions={[
                                            <Button
                                                key="rb"
                                                size="small"
                                                danger
                                                icon={<RollbackOutlined />}
                                                loading={rollingBack === v.version}
                                                disabled={!canWrite || v.version === (active !== null ? active.version : -1)}
                                                onClick={() => doRollback(v.version)}
                                            >
                                                { v.version === (active !== null ? active.version : -1) ? 'head' : 'откат' }
                                            </Button>,
                                        ]}
                                    >
                                        <List.Item.Meta
                                            title={`v${ v.version }`}
                                            description={`${ v.files.length } файл(ов) · ${ v.author } · ${ v.note } · ${ new Date(v.createdAt).toLocaleString() }`}
                                        />
                                    </List.Item>
                                )}
                            />
                        </Card>
                    </Space>
                </Spin>
            </Drawer>
        </Card>
    );
};

export default McpBundles;
