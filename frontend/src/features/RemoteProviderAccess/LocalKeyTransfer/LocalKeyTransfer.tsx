import { useState } from 'react';
import { Alert, Button, Modal, Select, Space, Typography } from 'antd';
import { useBridge } from '../../McpBridge/hooks/useBridge';
import { OPENCODE_PERSONAL_KEY_PROVIDER_URL, OPENCODE_PERSONAL_KEY_VERSION } from './contract';
import type { ILocalKeyTransferProps } from './interfaces';
import { useLocalKeyTransfer } from './hooks/useLocalKeyTransfer';

/** Opening the native window is not consent to transfer; the key never enters this component. */
export function LocalKeyTransfer(input: ILocalKeyTransferProps): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button onClick={() => setOpen(true)}>Использовать ключ OpenCode с компьютера</Button>
            {open && <TransferDialog {...input} onClose={() => setOpen(false)} />}
        </>
    );
}
function TransferDialog(input: ILocalKeyTransferProps & { onClose: () => void }): JSX.Element {
    const bridge = useBridge(),
        value = useLocalKeyTransfer(bridge, input),
        { state, controller } = value;
    const result = state?.result;
    return (
        <Modal open title="Личный ключ OpenCode" footer={null} onCancel={input.onClose}>
            <Space direction="vertical" size={12}>
                <Typography.Paragraph>
                    Поддерживается только обычная команда OpenCode {OPENCODE_PERSONAL_KEY_VERSION} и API-ключ OpenAI.
                    Версия и источник проверяются на компьютере перед открытием и передачей. OAuth и ключи OpenCode 2 не
                    переносятся этим действием.
                </Typography.Paragraph>
                <Typography.Text>Получатель личного доступа: {value.ownerEmail}</Typography.Text>
                <Typography.Text>Модель: {input.view.modelId}</Typography.Text>
                <Typography.Text>API провайдера: {OPENCODE_PERSONAL_KEY_PROVIDER_URL}</Typography.Text>
                <Typography.Paragraph>
                    Точный сервер Нейроцентра, модель и получатель будут показаны в приватном окне на компьютере.
                    Передача произойдёт только после отдельного подтверждения там. Это окно сайта ключ не читает.
                </Typography.Paragraph>
                <label>
                    Компьютер
                    <Select
                        aria-label="Компьютер с ключом OpenCode"
                        placeholder="Выберите компьютер"
                        value={bridge.device?.id}
                        disabled={state?.busy}
                        onChange={bridge.choose}
                        options={bridge.devices.map((device) => ({ value: device.id, label: device.name }))}
                    />
                </label>
                {bridge.errors.devices && (
                    <Alert
                        type="warning"
                        message={bridge.errors.devices}
                        action={<Button onClick={() => void bridge.reload()}>Обновить компьютеры</Button>}
                    />
                )}
                {value.reason && <Alert type="info" message={value.reason} />}
                {state?.journalError && <Alert type="warning" message={state.journalError} />}
                {state?.error && <Alert type="warning" message={state.error} />}
                {result?.status === 'opened' && !state?.receipt && (
                    <Alert type="info" message="Локальное окно открыто. Передача ключа ещё не подтверждена." />
                )}
                {result?.status === 'failed' && (
                    <Alert
                        type="warning"
                        message={
                            result.issue === 'unsupported-version'
                                ? 'Нужен OpenCode 1.14.48. Исходный ключ не изменён.'
                                : 'Локальное окно передачи недоступно. Проверьте компьютер и квитанцию.'
                        }
                    />
                )}
                {state?.receipt && (
                    <Alert
                        type="success"
                        message="Сохранение личного ключа подтверждено сервером. Запрос модели не выполнялся."
                    />
                )}
                {!state?.intent && (
                    <Button
                        type="primary"
                        disabled={!value.canOpen || !!state?.journalError}
                        loading={state?.busy}
                        onClick={() => void controller.open()}
                    >
                        Открыть приватное окно на компьютере
                    </Button>
                )}
                {(state?.journalError || state?.error) && !state?.intent && (
                    <Button onClick={() => void controller.refresh()}>Перечитать журнал</Button>
                )}
                {state?.intent && (
                    <Button loading={state.busy} onClick={() => void controller.refresh()}>
                        Проверить передачу
                    </Button>
                )}
                {state?.canReplay && (
                    <Button
                        disabled={!value.canOpen || state.busy || !!state.journalError}
                        onClick={() => void controller.replay()}
                    >
                        Повторить тот же запрос открытия
                    </Button>
                )}
                {state?.canRestart && (
                    <Button disabled={!value.canOpen || state.busy} onClick={() => void controller.beginAgain()}>
                        Начать новую попытку
                    </Button>
                )}
                <Button onClick={input.onClose}>Закрыть</Button>
            </Space>
        </Modal>
    );
}
