import type { IRepositorySource } from './repository-source.cjs';
import type { ISkillSourceFile } from './skill-source.cjs';
export function readSkillRepository(source: IRepositorySource, stage: string): Promise<ISkillSourceFile[]>;
