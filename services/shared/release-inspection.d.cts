import type {ReleaseInspector} from './github-release-source.cjs';
export const inspectGithubReleaseAsset:ReleaseInspector;

import type {RepositorySource,ResolvedRepository} from './repository-source.cjs';
export function inspectGithubRepository(source:Pick<RepositorySource,'type'|'url'|'commit'|'subdirectory'>,entrypoint?:string):Promise<Partial<ResolvedRepository>>;
