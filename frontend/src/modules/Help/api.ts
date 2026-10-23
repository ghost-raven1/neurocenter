import base from '../../core/api/base';
import type {HelpArticle, HelpOverview} from './types';
const root = '/api/help';
const timeout = 20000;
const articlePath = (slug: string): string => root + '/' + encodeURIComponent(slug);

/** Articles are read from the managed Markdown directory on every request. */
export const helpApi = {
    list: (): Promise<HelpOverview> => base.get<HelpOverview>(root, {timeout}).then(value => value.data),
    get: (slug: string): Promise<HelpArticle> => base.get<HelpArticle>(articlePath(slug), {timeout}).then(value => value.data),
    save: (slug: string, content: string, expectedRevision: string | null): Promise<HelpArticle> => base.put<HelpArticle>(articlePath(slug), {content, expectedRevision}, {timeout}).then(value => value.data),
};
