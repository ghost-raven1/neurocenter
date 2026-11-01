import type { IToolBuild } from './interfaces';

/** Contract owned by api. */
export interface IBuildPublicationConflict {
    catalogId: string;
    kind: 'mcp' | 'plugin';
    name: string;
    archived: boolean;
}

/** Contract owned by api. */
export interface IToolBuildRequestCancellation {
    requestKey: string;
    state: IToolBuild['state'];
    build: IToolBuild | null;
}
