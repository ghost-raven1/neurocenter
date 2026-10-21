import type {RepositorySource} from './repository-source.cjs';
import type {SkillSourceFile} from './skill-source.cjs';
export function readSkillRepository(source:RepositorySource,stage:string):Promise<SkillSourceFile[]>;
