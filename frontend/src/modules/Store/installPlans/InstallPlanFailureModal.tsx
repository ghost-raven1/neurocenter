import { Alert, Button, Descriptions, Modal, Space, Typography } from 'antd';
import { installPlanFailureExplanation, type IInstallPlanFailure } from './installPlanFailure';
import './InstallPlanModal.less';

interface IProps {
    failure: IInstallPlanFailure | null;
    busy?: boolean;
    onCancel(): void;
    onRetry(): void;
    onOpenPackage?(): void;
    onPackage?(): void;
}

/** Отказ остаётся на экране вместе с точной версией и доступными путями исправления. */
export function InstallPlanFailureModal({ failure, busy, onCancel, onRetry, onOpenPackage, onPackage }: IProps) {
    const issue = failure?.issue;
    const explanation = issue ? installPlanFailureExplanation(issue) : '';
    return <Modal open={!!failure} title="Не удалось подготовить установку" width={720} onCancel={onCancel} destroyOnClose
        footer={<Space wrap>
            <Button onClick={onCancel}>Закрыть</Button>
            {onOpenPackage && <Button disabled={busy} onClick={onOpenPackage}>Открыть карточку</Button>}
            {onPackage && <Button disabled={busy} onClick={onPackage}>Упаковать инструмент</Button>}
            <Button type="primary" loading={busy} onClick={onRetry}>Проверить версию {issue?.root.version}</Button>
        </Space>}>
        {issue && <Space direction="vertical" size="middle" className="install-plan__content">
            <Alert type="warning" showIcon message={issue.dependency ? 'Недоступен комплект зависимости' : 'Недоступен комплект инструмента'}
                description={explanation !== issue.reason ? explanation : undefined} />
            <Descriptions column={1} size="small">
                <Descriptions.Item label={issue.dependency ? 'Зависимость' : 'Инструмент'}>{issue.package.name}</Descriptions.Item>
                <Descriptions.Item label="Версия">{issue.package.version}</Descriptions.Item>
                <Descriptions.Item label="ID"><Typography.Text className="install-plan__hash">{issue.package.id}</Typography.Text></Descriptions.Item>
                <Descriptions.Item label="Причина">{issue.reason}</Descriptions.Item>
            </Descriptions>
            {issue.dependency && <div>
                <Typography.Text strong>Путь зависимости</Typography.Text>
                <ol>{issue.path.map(item => <li key={`${item.kind}:${item.id}`}>{item.name} · версия {item.version}</li>)}</ol>
                <Typography.Paragraph>После публикации готового инструмента администратору нужно заново закрепить его точную версию в зависимостях «{issue.root.name}».</Typography.Paragraph>
            </div>}
            {onPackage && <Typography.Paragraph type="secondary">«Упаковать инструмент» открывает мастер и создаёт отдельно опубликованный инструмент. Текущая версия и зависимости автоматически не заменяются.</Typography.Paragraph>}
            {!onPackage && <Typography.Paragraph type="secondary">Передайте администратору название, версию и причину отказа. Администратор должен опубликовать готовую версию.{!issue.dependency && ' Затем откройте карточку и выберите подготовленную версию.'}</Typography.Paragraph>}
        </Space>}
    </Modal>;
}
