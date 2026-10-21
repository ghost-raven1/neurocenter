import { Descriptions, Modal, Tag, Typography } from 'antd';
import { agentModeLabels } from './model';
import type { ICatalogAgent, IProjectAgent } from './types';

/** Read-only preview always identifies whether the prompt comes from the pinned project or common card. */
export function AgentDetails({ agent, assignment, onClose }: {agent: ICatalogAgent; assignment?: IProjectAgent; onClose: () => void}): JSX.Element {
    const pinned = assignment && !assignment.removed ? assignment : undefined;
    const definition = pinned?.effective ?? agent.definition;
    return <Modal open title={pinned?.card.name ?? agent.name} className="agent-editor" width={780} footer={null} onCancel={onClose}>
        <Typography.Paragraph>{definition.description}</Typography.Paragraph>
        <Descriptions size="small" column={1}><Descriptions.Item label="Имя в OpenCode"><Typography.Text code>@{pinned?.card.slug ?? agent.slug}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="Версия"><Tag>v{pinned?.version ?? agent.version}</Tag>{pinned ? 'Закреплена в проекте' : 'Общий каталог'}</Descriptions.Item>
            <Descriptions.Item label="Вызов">{agentModeLabels[definition.mode]}</Descriptions.Item><Descriptions.Item label="Модель">{definition.model || 'По умолчанию в OpenCode'}</Descriptions.Item></Descriptions>
        <Typography.Title level={5}>{pinned ? 'Промпт проекта' : 'Промпт шаблона'}</Typography.Title>
        <pre className="agent-editor__comparison">{definition.prompt}</pre>
        <Typography.Paragraph type="secondary">Настройки применяются к новому запуску OpenCode. Вызов модели и доступность провайдера здесь не проверяются.</Typography.Paragraph>
    </Modal>;
}
