export interface IHelpArticleSummary {
    slug: string;
    title: string;
    summary: string;
    revision: string;
    updatedAt: string;
}
export interface IHelpArticle extends IHelpArticleSummary {
    content: string;
    canEdit: boolean;
}
export interface IHelpOverview {
    items: IHelpArticleSummary[];
    canEdit: boolean;
}
