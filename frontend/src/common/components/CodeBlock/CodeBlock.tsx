import { useEffect, useRef } from 'react';
import type { CSSProperties, FC } from 'react';

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';

import '../../styles/codeblock-light.css';
import '../../styles/codeblock-dark.css';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);

export type TCodeBlockLanguage = 'bash' | 'json' | 'markdown';

type TCodeBlockTheme = 'light' | 'dark';

export interface ICodeBlockProps {
    /** Текст кода, который отображается. */
    code: string;
    /** Язык/разметка для подсветки. */
    language?: TCodeBlockLanguage;
    /** Цветовая тема: «light» — светлая, «dark» — тёмная. */
    theme?: TCodeBlockTheme;
    /** Дополнительные стили блока кода. */
    style?: CSSProperties;
    /** Дополнительный класс блока кода. */
    className?: string;
}

/**
 * Экранирует спецсимволы HTML для безопасной вставки в innerHTML.
 *
 * @param value - исходный текст.
 * @returns { string } экранированный текст.
 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Блок кода в теге `pre` с подсветкой синтаксиса (highlight.js).
 */
const CodeBlock: FC<ICodeBlockProps> = ({ code, language, theme = 'light', style, className }) => {
    const preRef = useRef<HTMLPreElement>(null);

    useEffect(() => {
        const node = preRef.current;

        if (node === null) {
            return;
        }

        const highlighted = language !== undefined && hljs.getLanguage(language) !== undefined
            ? hljs.highlight(code, { language, ignoreIllegals: true })
            : null;

        node.innerHTML = highlighted !== null ? highlighted.value : escapeHtml(code);
    }, [code, language]);

    const themeClass = theme === 'dark' ? 'codeblock-dark' : 'codeblock-light';

    return (
        <pre
            ref={preRef}
            className={`hljs ${themeClass} ${className ?? ''}`}
            style={style}
        />
    );
};

export default CodeBlock;
