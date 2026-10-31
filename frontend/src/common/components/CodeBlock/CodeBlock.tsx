import { useEffect, useRef } from 'react';
import { FC } from 'react';
import { ICodeBlockProps } from './interfaces';

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';

import '../../styles/codeblock-light.css';
import '../../styles/codeblock-dark.css';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);

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
export type { ICodeBlockProps, TCodeBlockLanguage } from './interfaces';
