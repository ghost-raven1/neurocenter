import base from '../../core/api/base';
import type { IHelpArticle, IHelpOverview } from './interfaces';
const root = '/api/help';
const timeout = 20000;
const articlePath = (slug: string): string => root + '/' + encodeURIComponent(slug);

/** Articles are read from the managed Markdown directory on every request. */
export const helpApi = {
    list: (): Promise<IHelpOverview> => base.get<IHelpOverview>(root, { timeout }).then((value) => value.data),
    get: (slug: string): Promise<IHelpArticle> =>
        base.get<IHelpArticle>(articlePath(slug), { timeout }).then((value) => value.data),
    save: (slug: string, content: string, expectedRevision: string | null): Promise<IHelpArticle> =>
        base
            .put<IHelpArticle>(articlePath(slug), { content, expectedRevision }, { timeout })
            .then((value) => value.data),
};
