import type { TReleaseInspector } from './github-release-source.cjs';
export const inspectGithubReleaseAsset: TReleaseInspector;

import type { IRepositorySource, IResolvedRepository } from './repository-source.cjs';
export function inspectGithubRepository(
    source: Pick<IRepositorySource, 'type' | 'url' | 'commit' | 'subdirectory'>,
    entrypoint?: string,
): Promise<Partial<IResolvedRepository>>;
