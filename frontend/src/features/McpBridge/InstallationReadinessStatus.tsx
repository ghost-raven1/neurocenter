import { Space, Tag, Typography } from 'antd';
import type { IBridgeInstallation, IBridgeJob } from './api';
import { installationProgress } from './installationProgress';

/** Главный статус сопровождается конкретным ближайшим шагом. */
export function InstallationReadinessStatus({item,jobs}: {item:IBridgeInstallation;jobs:IBridgeJob[]}) {
    const progress = installationProgress(item,jobs);
    return <Space direction="vertical" size={2}>
        <Tag color={progress.state === 'passed' ? 'green' : progress.state === 'modified' || progress.state === 'help' ? 'orange' : 'blue'}>{progress.title}</Tag>
        <Typography.Text type="secondary">{progress.description}</Typography.Text>
    </Space>;
}
