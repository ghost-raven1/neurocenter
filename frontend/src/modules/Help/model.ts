import type {HelpArticleSummary} from './types';
export const validHelpSlug = (value: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value);
export const MAX_HELP_BYTES = 512 * 1024;
export function filterArticles(items: HelpArticleSummary[], query: string): HelpArticleSummary[] {
    const terms = query.toLocaleLowerCase('ru-RU').trim().split(/\s+/).filter(Boolean);
    return items.filter(item => terms.every(term => [item.title, item.summary, item.slug].join(' ').toLocaleLowerCase('ru-RU').includes(term)));
}

/** Download the exact Markdown source without turning the article into generated HTML. */
export function downloadMarkdown(slug: string, content: string): void {
    const url = URL.createObjectURL(new Blob([content], {type: 'text/markdown;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = slug + '.md'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
