import type { ISkillMutationContext } from './skill-audit';
import type { ISkillFile, ISkillMeta, ISkillResource } from '../skills/skills.model';

export const SKILLS_STORAGE = Symbol('ISkillsStorage');

export interface IStoredEntry {
    name: string;
    isDir: boolean;
}
export interface ISkillChange {path:string;next:ISkillFile|null;}
export interface ISkillSourceReceipt {version:number;sha256:string;bytes:number;resources:Array<{path:string;sha256:string;bytes:number}>;}

/**
 * Абстракция хранилища скиллов. POSIX-том в production, локальная директория в dev.
 * Все пути — относительные от базовой директории хранилища.
 */
export interface ISkillsStorage {
    readonly baseDir: string;
    init(): Promise<void>;
    isEmpty(): Promise<boolean>;
    existsSkill(skillPath: string): Promise<boolean>;
    readSkill(skillPath: string, version?: number): Promise<ISkillFile>;
    sourceReceipt?(skillPath:string,version?:number):Promise<ISkillSourceReceipt>;
    createSkill(skillPath: string, meta: ISkillMeta, body: string, resources?: ISkillResource[], context?: ISkillMutationContext): Promise<boolean>;
    writeSkill(skillPath: string, meta: ISkillMeta, body: string, resources?: ISkillResource[], context?: ISkillMutationContext, expected?: ISkillFile): Promise<void>;
    applySkillChanges(changes:ISkillChange[], context?: ISkillMutationContext):Promise<void>;
    deleteSkill(skillPath: string, context?: ISkillMutationContext): Promise<void>;
    pendingAudit?(skillPath?: string, recursive?: boolean): Promise<boolean>;
    assertDurability?(): void;
    makeDirectory(dirPath: string, context?: ISkillMutationContext): Promise<void>;
    listDir(dirPath: string): Promise<IStoredEntry[]>;
}
