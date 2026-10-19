import { DownloadOutlined } from '@ant-design/icons';
import { Button, Card, message, Select, Space, Typography } from 'antd';
import { FC, useCallback, useEffect, useState } from 'react';

import bffApi from '../../core/api/bff';
import type { IProjectSummary } from '../../core/api/interfaces';

import McpPluginsTab from '../Projects/components/McpPluginsTab';

const { Title, Paragraph, Text } = Typography;

/**
 * Экран «MCP и Плагины»: каталог компонентов для выбранного проекта, разделённый
 * на две таблицы — MCP-серверы и Плагины (как на карточке проекта).
 *
 * @component
 * @returns JSX-элемент каталога MCP-серверов и плагинов
 */
const Packages: FC = () => {
    const [ projects, setProjects ] = useState<IProjectSummary[]>([]);
    const [ projectName, setProjectName ] = useState('');
    const [ importing, setImporting ] = useState(false);
    const [ tableKey, setTableKey ] = useState(0);

    useEffect(() => {
        bffApi.listProjects({ page: 1, size: 50 }).then((page) => setProjects(page.items)).catch(() => setProjects([]));
    }, []);

    /**
     * Импортировать локальные MCP/плагины выбранного проекта в каталог.
     *
     * @returns {Promise<void>}
     */
    const handleImport = useCallback(async (): Promise<void> => {
        if (projectName === '') {
            return;
        }

        setImporting(true);

        try {
            const result = await bffApi.importLocalAiPlugins(projectName);
            message.success(`Импорт завершён: добавлено ${result.imported}, обновлено ${result.updated}, пропущено ${result.skipped}`);
            setTableKey((k) => k + 1);
        } catch {
            message.error('Не удалось импортировать локальные MCP/плагины');
        } finally {
            setImporting(false);
        }
    }, [ projectName ]);

    return (
        <Card title={<Title level={4} style={{ margin: 0 }}>MCP и Плагины</Title>}>
            <Paragraph type="secondary">
                Каталог компонентов, разделённый на MCP-серверы и Плагины (как на карточке проекта).
                Выберите проект — таблицы покажут реально установленное и позволят установить/удалить компонент.
            </Paragraph>
            <Space style={{ marginBottom: 16 }} wrap>
                <Text strong>Проект:</Text>
                <Select
                    style={{ minWidth: 280 }}
                    placeholder="Выберите проект (каталог локальных проектов)"
                    value={projectName || undefined}
                    onChange={(v: string) => setProjectName(v)}
                    allowClear
                    options={projects.map((p) => ({ label: p.name, value: p.name }))}
                />
            </Space>
            {projectName ? (
                <Space direction="vertical" style={{ width: '100%' }} size={24}>
                    <Space wrap>
                        <Button icon={<DownloadOutlined />} loading={importing} onClick={() => { void handleImport(); }}>
                            Импорт из локальных
                        </Button>
                        <Text type="secondary">
                            Добавить MCP/плагины проекта ({projectName}) из компьютера в каталог
                        </Text>
                    </Space>
                    <Card key={`mcp-${tableKey}`} title="MCP" size="small">
                        <McpPluginsTab projectName={projectName} filter="mcp" />
                    </Card>
                    <Card key={`plugin-${tableKey}`} title="Плагины" size="small">
                        <McpPluginsTab projectName={projectName} filter="plugin" />
                    </Card>
                </Space>
            ) : (
                <Paragraph type="secondary">Выберите проект, чтобы увидеть таблицы MCP-серверов и плагинов.</Paragraph>
            )}
        </Card>
    );
};

export default Packages;
