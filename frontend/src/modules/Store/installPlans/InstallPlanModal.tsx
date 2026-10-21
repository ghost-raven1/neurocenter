import { FeatureButton } from '../../../features/FeatureFlags/FeatureAvailability';
import { Alert, Button, Collapse, Descriptions, List, Modal, Space, Tag, Typography } from 'antd';
import type { IInstallPlan } from '../../../features/McpBridge/api';
import type { IInstallPlanPackage, IInstallPlanRequirements } from '../../../features/McpBridge/installPlanTypes';
import './InstallPlanModal.less';
import { RuntimeArtifactsDetails } from './RuntimeArtifactsDetails';
import { installPlanConfigPreview } from './installPlanConfigPreview';

interface IProps {
    plan: IInstallPlan | null;
    name?: string;
    projectName?: string;
    canApprove: boolean;
    busy: boolean;
    installOnApprove: boolean;
    installDisabled?: boolean;
    installBlocker?: string;
    onCancel(): void;
    onApprove(): void;
    onRevoke(): void;
    onInstall(): void;
}

/** Точные pins показываются отдельно от прежних требований без версии. */
function PlanRequirements({requirements}: {requirements: IInstallPlanRequirements}) {
    const mcp = requirements.mcp ?? [];
    const plugins = requirements.plugins ?? [];
    const dependencies = requirements.dependencies ?? [];
    return <div><Typography.Title level={5}>Связанные инструменты</Typography.Title>
        {mcp.length > 0 || plugins.length > 0 ? <Space wrap>{mcp.map(item => <Tag key={'mcp:' + item}>MCP: {item}</Tag>)}{plugins.map(item => <Tag key={'plugin:' + item}>Плагин: {item}</Tag>)}</Space> : null}
        {dependencies.map(pin => <div key={`${pin.kind}:${pin.id}`} className="install-plan__file">
            <Typography.Text>{pin.kind === 'mcp' ? 'MCP' : 'Плагин'}: {pin.id} · версия {pin.version}</Typography.Text>
            <Typography.Text code className="install-plan__hash">{pin.manifest}</Typography.Text>
        </div>)}
        {!mcp.length && !plugins.length && !dependencies.length && <Typography.Text type="secondary">Не указаны</Typography.Text>}
    </div>;
}

function PackageContents({files, config, requirements}: Pick<IInstallPlanPackage, 'files' | 'config' | 'requirements'>) {
    const configPreview = installPlanConfigPreview(config);
    return <Space direction="vertical" size="middle" className="install-plan__content">
        <div><Typography.Title level={5}>Файлы ({files.length})</Typography.Title>
            <List size="small" dataSource={files} locale={{ emptyText: 'Локальных файлов нет' }} renderItem={file => <List.Item>
                <div className="install-plan__file"><Typography.Text strong>{file.path}</Typography.Text>
                    <Typography.Text type="secondary">{file.size.toLocaleString('ru-RU')} байт{file.encoding ? ` · ${file.encoding}` : ''}</Typography.Text>
                    <Typography.Text code className="install-plan__hash">{file.sha256}</Typography.Text>
                    {file.encoding === 'base64'
                        ? <Typography.Text type="secondary">Бинарный файл · проверяется по размеру и SHA-256</Typography.Text>
                        : <Collapse ghost><Collapse.Panel header={'Посмотреть содержимое: ' + file.path} key={file.path}>
                            <pre className="install-plan__config">{file.content}</pre>
                        </Collapse.Panel></Collapse>}
                </div>
            </List.Item>} />
        </div>
        <div><Typography.Title level={5}>Подключение</Typography.Title>
            {configPreview ? <pre className="install-plan__config">{JSON.stringify(configPreview, null, 2)}</pre> : <Typography.Text type="secondary">Изменение подключения не требуется</Typography.Text>}
        </div>
        <PlanRequirements requirements={requirements} />
        <RuntimeArtifactsDetails config={config} />
    </Space>;
}

/** Содержимое всего одобряемого комплекта доступно без запуска кода и повторного обзора корня. */
export function InstallPlanDetails({ plan }: { plan: IInstallPlan }) {
    const packages = plan.packages?.length ? plan.packages : undefined;
    return <Space direction="vertical" size="middle" className="install-plan__content">
        <Descriptions size="small" column={1}>
            {!packages && <Descriptions.Item label="Версия">{plan.version}</Descriptions.Item>}
            <Descriptions.Item label={packages ? 'SHA-256 комплекта' : 'SHA-256 манифеста'}><Typography.Text code className="install-plan__hash">{plan.manifest}</Typography.Text></Descriptions.Item>
            {packages && <Descriptions.Item label="Состав">Инструментов: {packages.length} · файлов: {packages.reduce((sum, pkg) => sum + pkg.files.length, 0)}</Descriptions.Item>}
            <Descriptions.Item label="Состояние"><Tag color={plan.status === 'approved' ? 'green' : plan.status === 'revoked' ? 'red' : 'gold'}>{plan.status === 'approved' ? 'Одобрен' : plan.status === 'revoked' ? 'Разрешение отозвано' : 'Ожидает одобрения'}</Tag></Descriptions.Item>
            {plan.approvedBy && <Descriptions.Item label="Кто одобрил">{plan.approvedBy}</Descriptions.Item>}
        </Descriptions>
        {packages ? <>
            <Typography.Title level={5}>Состав комплекта</Typography.Title>
            {packages.map(pkg => <section key={`${pkg.kind}:${pkg.id}`} className="install-plan__content" aria-label={`Пакет ${pkg.name}`}>
                <Typography.Title level={5}>{pkg.name} · {pkg.kind === 'skill' ? 'Скилл' : pkg.kind === 'mcp' ? 'MCP' : 'Плагин'}</Typography.Title>
                <Tag>{pkg.id === plan.assetId && pkg.kind === plan.assetKind ? 'Основной инструмент' : 'Зависимость'}</Tag>
                <Descriptions size="small" column={1}>
                    <Descriptions.Item label="ID"><Typography.Text className="install-plan__hash">{pkg.id}</Typography.Text></Descriptions.Item>
                    <Descriptions.Item label="Версия">{pkg.version}</Descriptions.Item>
                    <Descriptions.Item label="SHA-256 пакета"><Typography.Text code className="install-plan__hash">{pkg.manifest}</Typography.Text></Descriptions.Item>
                </Descriptions>
                <PackageContents {...pkg} />
            </section>)}
        </> : <PackageContents files={plan.files} config={plan.config} requirements={plan.requirements} />}
    </Space>;
}

/** Роль определяет доступные кнопки; сервер повторно проверяет полномочия. */
export function InstallPlanActions({ plan, canApprove, busy, installOnApprove, installDisabled, onCancel, onApprove, onRevoke, onInstall }: Omit<IProps, 'name' | 'projectName'>) {
    const isSet = Boolean(plan?.packages?.length);
    return <Space wrap><Button onClick={onCancel}>{busy ? 'Закрыть' : 'Отмена'}</Button>
        {plan?.status === 'approved' && installOnApprove && <FeatureButton features={['tool_installation']} type="primary" loading={busy} disabled={installDisabled} onClick={onInstall}>{isSet ? 'Установить одобренный комплект' : 'Установить одобренную версию'}</FeatureButton>}
        {canApprove && (plan?.status === 'approved'
            ? <Button danger loading={busy} onClick={onRevoke}>Отозвать разрешение</Button>
            : <FeatureButton features={['tool_installation']} type="primary" loading={busy} disabled={installOnApprove && installDisabled} onClick={onApprove}>{isSet ? installOnApprove ? 'Одобрить и установить комплект' : 'Одобрить комплект' : installOnApprove ? 'Одобрить и установить' : 'Одобрить версию'}</FeatureButton>)}</Space>;
}

function approvalNotice(plan: IInstallPlan, canApprove: boolean): string {
    const isSet = Boolean(plan.packages?.length);
    if (canApprove && plan.status === 'approved') {
        return `${isSet ? 'Этот комплект разрешён' : 'Эта версия разрешена'} для выбранного проекта. Отзыв остановит ожидающие установки; уже установленные файлы останутся на компьютерах.`;
    }
    if (canApprove) {
        return isSet ? 'Вы разрешаете весь показанный комплект: точные версии, файлы и подключения всех инструментов. Решение закрепляет SHA-256 комплекта.' : 'Вы разрешаете установку только этой версии и этого манифеста в выбранном проекте.';
    }
    if (plan.status === 'approved') {
        return isSet ? 'Комплект одобрен администратором. Теперь можно установить все его инструменты на компьютер.' : 'Версия одобрена администратором. Теперь можно установить её на компьютер.';
    }
    return isSet ? 'Для всего комплекта нужно одобрение администратора проекта. Статус обновится после его решения.' : 'Для этой версии нужно одобрение администратора проекта. Передайте ему название инструмента и номер версии; статус обновится после его решения.';
}

export function InstallPlanModal({ plan, name, projectName, canApprove, busy, installOnApprove, installDisabled, installBlocker, onCancel, onApprove, onRevoke, onInstall }: IProps) {
    return <Modal open={!!plan} title="Проверка установки" width={720} onCancel={onCancel} destroyOnClose
        footer={<InstallPlanActions {...{ plan, canApprove, busy, installOnApprove, installDisabled:installDisabled || !!installBlocker, onCancel, onApprove, onRevoke, onInstall }} />}>
        {plan && <Space direction="vertical" size="middle" className="install-plan__content">
            <Typography.Paragraph><Typography.Text strong>{name || plan.assetId}</Typography.Text>{projectName ? ` · проект «${projectName}»` : ''}</Typography.Paragraph>
            <Alert showIcon type={canApprove ? 'info' : 'warning'} message={approvalNotice(plan, canApprove)} />
            {installOnApprove && installBlocker && <Alert type="warning" showIcon message={installBlocker} />}
            <InstallPlanDetails plan={plan} />
            {busy && <Typography.Text type="secondary" role="status">Проверяем разрешение… Закрытие окна не отменяет уже отправленное одобрение или задание. Установка отображается в «Операциях».</Typography.Text>}
        </Space>}
    </Modal>;
}
