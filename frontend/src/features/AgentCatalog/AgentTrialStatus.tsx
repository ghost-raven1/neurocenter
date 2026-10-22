import { Tag, Typography } from 'antd';
import { agentTrialStatus } from './readinessModel';
import type { IAgentReadinessItem } from './readinessTypes';

/** Chat diagnostics and native file delivery remain separate statements. */
export function AgentTrialStatus({ item, checking = false }: { item: IAgentReadinessItem; checking?: boolean }): JSX.Element {
    const trial = item.latestTrial, status = checking ? { label: 'Проверяем актуальность', color: undefined } : agentTrialStatus(trial);
    return <div className="agent-card__trial" role="status" aria-live="polite">
        <Tag color={status.color}>{status.label}</Tag>
        {trial && <Typography.Text type="secondary">Модель: {trial.receipt.modelName}</Typography.Text>}
    </div>;
}
