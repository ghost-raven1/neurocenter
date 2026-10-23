export interface HelpArticleSummary {slug: string; title: string; summary: string; revision: string; updatedAt: string}
export interface HelpArticle extends HelpArticleSummary {content: string; canEdit: boolean}
export interface HelpOverview {items: HelpArticleSummary[]; canEdit: boolean}
