import { ReactNode } from 'react';

export interface IAsyncButtonProps {
    /** Обработчик клика (может возвращать Promise). */
    onClick: () => Promise<void> | void;
    children: ReactNode;
    /** Тип кнопки AntD. */
    type?: 'primary' | 'default' | 'text' | 'link' | 'dashed' | 'ghost';
    danger?: boolean;
    disabled?: boolean;
}