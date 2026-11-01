import { Alert, Button, Empty, List, Space, Tag, Typography } from 'antd';
import {
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as OPEN,
} from '@neurocenter/opencode-local-providers';
import { providerIssueExplanation } from '../presentation';
import { LocalProviderHistory } from '../LocalProviderHistory/LocalProviderHistory';
import type { IOpenCodeAccountsStepProps } from './interfaces';

/** Stored account metadata is not effective provider configuration or evidence of a model response. */
export function OpenCodeAccountsStep({ value, onContinue }: IOpenCodeAccountsStepProps): JSX.Element {
    const { state, controller, canRead, canInspect, canOpen, blocker, openingBlocker } = value;
    const inventory = state?.accountInventory;
    const canContinue = canRead && !state?.denied;
    return (
        <section className="local-opencode-providers" aria-label="Учётные записи OpenCode 2">
            <Typography.Title level={4}>Учётные записи OpenCode 2</Typography.Title>
            <Typography.Paragraph>
                Показаны только сохранённые способы входа на выбранном компьютере. Этот список не содержит модели,
                адреса API или итоговую конфигурацию проекта и не подтверждает готовность провайдера.
            </Typography.Paragraph>
            {blocker && <Alert type="info" showIcon message={blocker} />}
            {openingBlocker && <Alert type="info" showIcon message={openingBlocker} />}
            {state?.error && (
                <Alert
                    type="warning"
                    showIcon
                    message={state.error}
                    action={<Button onClick={() => void controller.refresh()}>Проверить квитанцию</Button>}
                />
            )}
            {state?.storageError && (
                <Alert
                    type="warning"
                    showIcon
                    message={state.storageError}
                    action={<Button onClick={() => void controller.refresh()}>Перечитать журнал</Button>}
                />
            )}
            {inventory && (
                <List
                    size="small"
                    dataSource={inventory.accounts}
                    locale={{
                        emptyText: (
                            <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={
                                    inventory.issues.length
                                        ? 'Полный список учётных записей не получен.'
                                        : 'Сохранённые учётные записи не найдены.'
                                }
                            />
                        ),
                    }}
                    renderItem={(account) => (
                        <List.Item>
                            <Space wrap>
                                <Typography.Text strong>{account.integrationId}</Typography.Text>
                                {account.hasApiKey && <Tag>API-ключ сохранён</Tag>}
                                {account.hasOAuth && <Tag>OAuth сохранён</Tag>}
                                {account.hasExternal && <Tag>Внешняя авторизация</Tag>}
                            </Space>
                        </List.Item>
                    )}
                />
            )}
            {!!inventory?.issues.length && (
                <Alert
                    type="warning"
                    showIcon
                    message="Состояние прочитано частично"
                    description={
                        <ul>
                            {inventory.issues.map((issue) => (
                                <li key={issue}>{providerIssueExplanation(issue)}</li>
                            ))}
                        </ul>
                    }
                />
            )}
            {([READ, OPEN] as const).map((kind) => {
                const result = state?.jobs[kind]?.result;
                return result?.status === 'failed' ? (
                    <Alert key={kind} type="warning" showIcon message={providerIssueExplanation(result.issue)} />
                ) : null;
            })}
            {state?.jobs[OPEN]?.result?.status === 'opened' && (
                <Alert
                    type="info"
                    showIcon
                    message="Локальное окно открыто"
                    description="Завершите добавление учётной записи на компьютере и перечитайте список. Открытие окна не подтверждает сохранение."
                />
            )}
            <Typography.Paragraph type="secondary">
                В локальном окне можно добавить учётную запись Anthropic. Существующие записи не удаляются и не
                заменяются. Ключ вводится только на компьютере и не передаётся на сервер Нейроцентра.
            </Typography.Paragraph>
            <Space wrap>
                <Button
                    loading={state?.busy}
                    disabled={!canInspect || state?.denied || !!state?.storageError}
                    onClick={() => void controller.start(READ)}
                >
                    Перечитать учётные записи
                </Button>
                <Button
                    disabled={!canOpen || state?.denied || !!state?.storageError}
                    loading={state?.busy}
                    onClick={() => void controller.start(OPEN)}
                >
                    Добавить учётную запись Anthropic
                </Button>
                <Button
                    type="primary"
                    disabled={!canContinue || state?.busy}
                    onClick={() => {
                        if (canContinue) onContinue();
                    }}
                >
                    Продолжить настройку OpenCode
                </Button>
            </Space>
            <LocalProviderHistory value={value} />
            <Typography.Paragraph type="secondary">
                Модель автоматически не выбирается, запрос модели не выполняется.
            </Typography.Paragraph>
        </section>
    );
}
