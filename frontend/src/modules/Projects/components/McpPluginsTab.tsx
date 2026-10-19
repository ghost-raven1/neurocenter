import { Button, Form, Input, message, Modal, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FC, useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import bffApi from '../../../core/api/bff';
import type { IAiPlugin } from '../../../core/api/interfaces';
import { CodeBlock } from '../../../common/components/CodeBlock';
import { isMainAdminRole, roleLevel } from '../../../features/UserBlock/roles';
import { RootState } from '../../../store';

const { Paragraph, Text } = Typography;

/**
 * Готовый фрагмент `opencode.json` для установки компонента (MCP/плагин) в проект.
 *
 * @param r - сущность каталога (MCP-сервер или плагин).
 * @returns { { title: string; body: string } } заголовок и тело фрагмента.
 */
function opencodeInstallSnippet(r: IAiPlugin): { title: string; body: string } {
    const key = (r.name || 'asset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
    if (r.kind === 'plugin') {
        return {
            title: 'Файл плагина в проекте (опencode подхватывает плагины из .opencode/plugins автоматически)',
            body: `./.opencode/plugins/${key}.js`,
        };
    }
    if (r.config && r.config.url) {
        return {
            title: 'opencode.json — remote MCP',
            body: `{
  "mcp": {
    "${key}": { "type": "remote", "url": "${r.config.url}" }
  }
}`,
        };
    }
    if (r.config && r.config.command) {
        const parts = [ r.config.command, ...[ ...(r.config.args ?? []) ] ].map((a) => `"${a}"`).join(', ');
        return {
            title: 'opencode.json — local MCP (stdio)',
            body: `{
  "mcp": {
    "${key}": { "type": "local", "enabled": true, "command": [${parts}] }
  }
}`,
        };
    }
    const isRemote = /^https?:\/\//.test(r.origin || '');
    if (isRemote) {
        return {
            title: 'opencode.json — remote MCP',
            body: `{
  "mcp": {
    "${key}": { "type": "remote", "url": "${r.origin || ''}" }
  }
}`,
        };
    }
    return {
        title: 'opencode.json — local MCP (npx; уточните пакет в args)',
        body: `{
  "mcp": {
    "${key}": { "type": "local", "enabled": true, "command": ["npx", "-y", "${r.origin || key}"] }
  }
}`,
    };
}

interface IMcpPluginsTabProps {
    /** Имя локального проекта (из каталога `~/projects`), куда ставится компонент. */
    projectName: string;
    /** Фильтр по виду: MCP-серверы ('mcp') или плагины ('plugin'). */
    filter?: 'mcp' | 'plugin';
}

/**
 * Таблица каталога MCP/Плагинов проекта: каталог (`ai_plugins`) ∪ реально установленные на диске,
 * живой бейдж «Установлено», установка/удаление в выбранный проект.
 *
 * @component
 * @param {IMcpPluginsTabProps} props
 * @returns JSX-элемент таблицы
 */
const McpPluginsTab: FC<IMcpPluginsTabProps> = ({ projectName, filter }) => {
    const kind: 'mcp' | 'plugin' = filter === 'plugin' ? 'plugin' : 'mcp';
    const [ items, setItems ] = useState<IAiPlugin[] | null>(null);
    const [ loading, setLoading ] = useState(true);
    const [ installRow, setInstallRow ] = useState<IAiPlugin | null>(null);
    const [ addOpen, setAddOpen ] = useState(false);
    const [ adding, setAdding ] = useState(false);
    const [ installing, setInstalling ] = useState(false);
    const [ local, setLocal ] = useState<{ project: string; path: string; skills: string[]; mcpServers: string[]; plugins: string[] } | null>(null);
    const [ addForm ] = Form.useForm<{ name: string; description?: string; origin?: string }>();

    const user = useSelector((state: RootState) => state.userBlock.user);
    const canPublish = user !== null && isMainAdminRole(user.activeRole);
    const canManageProject = user !== null && roleLevel(user.activeRole) >= 3;

    const load = useCallback(() => {
        setLoading(true);
        bffApi.listAiPlugins()
            .then((res) => setItems(res.items))
            .catch(() => setItems([]))
            .finally(() => setLoading(false));
        bffApi.scanLocalAssets({ q: projectName })
            .then((res) => setLocal(res.projects.find((p) => p.project === projectName) ?? null))
            .catch(() => setLocal(null));
    }, [ projectName ]);

    useEffect(() => {
        load();
    }, [ load ]);

    const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const diskNames: string[] = kind === 'plugin' ? (local?.plugins ?? []) : (local?.mcpServers ?? []);
    const isInstalled = (r: IAiPlugin): boolean => diskNames.some((d) => d === r.name || (d !== '' && norm(d) === norm(r.name)));
    const columns: ColumnsType<IAiPlugin> = [
        { title: 'Имя', dataIndex: 'name' },
        { title: 'Описание', dataIndex: 'description', ellipsis: true },
        { title: 'Установлено', key: 'installed', width: 120, render: (_v: unknown, r: IAiPlugin) => (isInstalled(r) ? <Tag color="green">Установлено</Tag> : <Tag>—</Tag>) },
        {
            title: 'Действие',
            key: 'action',
            width: 260,
            render: (_v: unknown, r: IAiPlugin) => (
                <Space size="small">
                    <Button size="small" type="primary" onClick={() => setInstallRow(r)}>{ isInstalled(r) ? 'Управлять' : 'Установить' }</Button>
                    { canManageProject && !r.id.startsWith('disk-') && (
                        <Button
                            size="small"
                            title="Добавить в проектный каталог (админ проекта)"
                            onClick={() => {
                                bffApi.addProjectAsset(projectName, { assetId: r.id, assetKind: kind })
                                    .then(() => { message.success('Добавлено в проектный каталог'); })
                                    .catch(() => { message.error('Не удалось добавить в проект'); });
                            }}
                        >
                            В проект
                        </Button>
                    ) }
                </Space>
            ),
        },
    ];

    const title = kind === 'plugin' ? 'Плагины' : 'MCP';
    const catalog = (items ?? []).filter((a) => a.kind === kind);
    const nowIso = new Date().toISOString();
    const diskOnly: IAiPlugin[] = diskNames
        .filter((d) => !catalog.some((r) => r.name === d || (norm(d) !== '' && norm(r.name) === norm(d))))
        .map((d) => ({
            id: `disk-${kind}-${norm(d)}`,
            name: d,
            kind,
            description: 'Уже установлено на компьютере',
            version: 1,
            compatibility: null,
            tags: [],
            origin: 'local',
            revision: null,
            config: null,
            files: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        }));
    const data = [...catalog, ...diskOnly];

    const handleAdd = async (): Promise<void> => {
        const values = await addForm.validateFields();
        setAdding(true);
        try {
            await bffApi.createAiPlugin({ name: values.name, kind, description: values.description ?? '', origin: values.origin ?? '' });
            message.success('Добавлено в каталог');
            setAddOpen(false);
            addForm.resetFields();
            load();
        } catch (err) {
            void err;
            message.error('Не удалось добавить');
        } finally {
            setAdding(false);
        }
    };

    return (
        <div>
            <Space style={{ marginBottom: 16 }}>
                <Text><b>{projectName}</b> &mdash; {title}</Text>
                <Button type="link" onClick={load}>Обновить</Button>
                { canPublish && <Button size="small" onClick={() => setAddOpen(true)}>+ Добавить {kind === 'mcp' ? 'MCP' : 'плагин'}</Button> }
            </Space>
            <Table rowKey="id" columns={columns} dataSource={data} loading={loading} size="small" pagination={false} />
            <Paragraph type="secondary" style={{ marginTop: 8 }}>
                Каталог установки ({title}). «Установить на компьютер» выдаст готовый к вставке фрагмент <code>opencode.json</code>.
            </Paragraph>
            <Modal
                open={!!installRow}
                title={installRow ? `Установка «${installRow.name}» на компьютер` : ''}
                footer={null}
                onCancel={() => setInstallRow(null)}
            >
                { installRow && (() => {
                    const snip = opencodeInstallSnippet(installRow);
                    return (
                        <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <ol style={{ margin: 0, paddingLeft: 18 }}>
                                <li>Убедитесь, что установлен и запущен <b>OpenCode</b> (агент/CLI).</li>
                                <li>{kind === 'plugin'
                                    ? 'Расположите плагин по указанному пути проекта (или вставьте путь в конфиг).'
                                    : 'Убедитесь, что подключён плагин <code>neurocenter-asset-sync</code> — он установит компонент в проект автоматически.'}</li>
                                <li>Вставьте <b>готовый фрагмент</b> ниже в <code>opencode.json</code> проекта (или в открытый OpenCode) и перезапустите сессию.</li>
                            </ol>
                            <Text strong>{snip.title}</Text>
                            <CodeBlock code={snip.body} language="json" theme="dark" style={{ background: '#1f1f1f', padding: 12, borderRadius: 6, overflowX: 'auto', fontSize: 12 }} />
                            <Space wrap>
                                <Button onClick={() => { void navigator.clipboard?.writeText(snip.body); message.success('Скопировано в буфер обмена'); }}>
                                    Скопировать
                                </Button>
                                <Button
                                    type="primary"
                                    loading={installing}
                                    onClick={() => {
                                        setInstalling(true);
                                        bffApi.installLocalAsset({ kind, name: installRow.name, projectName, config: (installRow.config ?? undefined) as Record<string, unknown> | undefined, origin: installRow.origin || undefined, action: 'install' })
                                            .then(() => { message.success('Установлено в проект'); load(); })
                                            .catch(() => message.error('Не удалось установить'));
                                        setInstalling(false);
                                    }}
                                >
                                    Установить в проект
                                </Button>
                                <Button
                                    danger
                                    loading={installing}
                                    onClick={() => {
                                        setInstalling(true);
                                        bffApi.installLocalAsset({ kind, name: installRow.name, projectName, action: 'uninstall' })
                                            .then(() => { message.success('Удалено из проекта'); load(); })
                                            .catch(() => message.error('Не удалось удалить'));
                                        setInstalling(false);
                                    }}
                                >
                                    Удалить из проекта
                                </Button>
                            </Space>
                        </Space>
                    );
                })() }
            </Modal>
            <Modal
                open={addOpen}
                title={`Добавить ${kind === 'mcp' ? 'MCP' : 'плагин'} в каталог`}
                footer={null}
                onCancel={() => setAddOpen(false)}
            >
                <Form form={addForm} layout="vertical">
                    <Form.Item name="name" label="Имя" rules={[{ required: true }]}><Input placeholder="например: edouard-claude/snip" /></Form.Item>
                    <Form.Item name="description" label="Описание"><Input.TextArea rows={2} /></Form.Item>
                    <Form.Item name="origin" label="Происхождение / путь (origin)"><Input placeholder="git:https://github.com/… | ./plugins/…" /></Form.Item>
                    <Button type="primary" loading={adding} onClick={handleAdd}>Добавить</Button>
                </Form>
            </Modal>
        </div>
    );
};

export default McpPluginsTab;
