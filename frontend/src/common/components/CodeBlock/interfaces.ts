import type { CSSProperties } from 'react';

export type TCodeBlockLanguage = 'bash' | 'json' | 'markdown';

export interface ICodeBlockProps {
    /** Текст кода, который отображается. */
    code: string;
    /** Язык/разметка для подсветки. */
    language?: TCodeBlockLanguage;
    /** Цветовая тема: «light» — светлая, «dark» — тёмная. */
    theme?: 'light' | 'dark';
    /** Дополнительные стили блока кода. */
    style?: CSSProperties;
    /** Дополнительный класс блока кода. */
    className?: string;
}
