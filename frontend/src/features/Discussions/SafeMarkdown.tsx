import {Children, isValidElement, type ReactNode} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
const uiRoots = new Set(['start', 'store', 'assets', 'projects', 'operations', 'skills', 'rag', 'versions', 'maintenance', 'audit', 'model-usage', 'access', 'settings', 'help']);
const safeFragment = (value: string): boolean => {
    try {return /^#[\p{L}\p{N}_-]+$/u.test(decodeURIComponent(value));} catch {return false;}
};

/** Internal links navigate existing UI roots; API paths and disguised hosts are excluded. */
function internalUrl(value: string): boolean {
    if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return false;
    const path = value.split(/[?#]/, 1)[0];
    try {
        const segments = path.split('/').slice(1).map(segment => decodeURIComponent(segment));
        return uiRoots.has(segments[0]) && segments.every(segment => /^[\p{L}\p{N}._~-]*$/u.test(segment) && segment !== '.' && segment !== '..');
    } catch {return false;}
}

/** Markdown remains text: HTML and external image requests are never executed. */
export function safeMarkdownUrl(value: string): string {
    if (/^https?:\/\//i.test(value)) {
        try {const url = new URL(value); return url.username || url.password ? '' : url.href;} catch {return '';}
    }
    if (/^mailto:[^\s]+$/i.test(value) || safeFragment(value)) return value;
    const article = /^(?:\.\/)?([a-z0-9][a-z0-9-]{0,79})\.md(#[^\s]*)?$/i.exec(value);
    if (article && (!article[2] || safeFragment(article[2]))) return '/help/' + encodeURIComponent(article[1]) + (article[2] ?? '');
    return internalUrl(value) ? value : '';
}
const text = (children: ReactNode): string => Children.toArray(children).map(child => isValidElement<{children?: ReactNode}>(child) ? text(child.props.children) : String(child)).join('');
export function SafeMarkdown({body}: {body: string}): JSX.Element {
    const counts = new Map<string, number>();
    const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({children}: {children?: ReactNode}) => {
        const slug = text(children).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
        const count = counts.get(slug) ?? 0; counts.set(slug, count + 1);
        return <Tag id={slug + (count ? '-' + count : '')}>{children}</Tag>;
    };
    return <div className="discussion-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl} components={{
        a: ({href, children}) => href ? <a href={href} target={/^https?:/.test(href) ? '_blank' : undefined} rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
        img: ({alt}) => <span className="discussion-markdown__image">Изображение: {alt || 'без подписи'}</span>,
        table: ({children}) => <div className="discussion-markdown__table" tabIndex={0}><table>{children}</table></div>,
        h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
    }}>{body}</Markdown></div>;
}
