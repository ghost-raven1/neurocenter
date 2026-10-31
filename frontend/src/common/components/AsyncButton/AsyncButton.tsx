import { Button } from 'antd';
import block from 'bem-cn';
import { FC, useCallback, useState } from 'react';
import { IAsyncButtonProps } from './interfaces';

const b = block('async-button');

/**
 * Кнопка с индикацией loading во время выполнения асинхронного обработчика.
 * Повторные клики блокируются, пока onClick отработает.
 *
 * @component
 * @param {() => Promise<void> | void} props.onClick - асинхронный обработчик
 * @param {ReactNode} props.children - содержимое
 * @param {string} [props.type] - тип кнопки
 * @param {boolean} [props.danger] - danger-стиль
 * @param {boolean} [props.disabled] - заблокирована
 */
const AsyncButton: FC<IAsyncButtonProps> = ({ onClick, children, type = 'default', danger, disabled = false }) => {
    const [isProcessing, setIsProcessing] = useState<boolean>(false);

    const handleClick = useCallback(async () => {
        if (disabled) return;

        setIsProcessing(true);

        try {
            await onClick();
        } finally {
            setIsProcessing(false);
        }
    }, [disabled, onClick]);

    return (
        <Button
            className={b().toString()}
            type={type}
            danger={danger}
            disabled={disabled}
            loading={isProcessing}
            onClick={handleClick}
        >
            {children}
        </Button>
    );
};

export default AsyncButton;
