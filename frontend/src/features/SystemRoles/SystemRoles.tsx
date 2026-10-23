import { Button, Space, Typography } from 'antd';
import { useState } from 'react';
import { SystemRoleModal } from './SystemRoleModal';
import type { SystemRoleId } from './types';
import './SystemRoles.less';
/** Builtin workflows are separate from editable OpenCode templates and from access roles. */
export function SystemRoles({ projectId }: { projectId?: string }): JSX.Element {
    const [selected, setSelected] = useState<SystemRoleId>();
    return <section className="system-roles" aria-label="Системные агенты"><div><Typography.Text strong>Системные агенты</Typography.Text><Typography.Paragraph type="secondary">Диагностика и предложения с проверкой человеком. Активность сохраняется в операциях.</Typography.Paragraph></div>
        <Space wrap><Button onClick={() => setSelected('agent-ai-admin')}>AI-админ</Button><Button onClick={() => setSelected('agent-autoconfigurator')}>Автоконфигуратор</Button><Button onClick={() => setSelected('agent-indexer')}>Индексатор</Button></Space>
        {selected && <SystemRoleModal key={selected + ':' + projectId} id={selected} projectId={projectId} onClose={() => setSelected(undefined)} />}
    </section>;
}
