import { ISkillSourceReceipt } from 'src/storage/skills-storage.interface';

export interface IInternalImport {
    input?: unknown;
    actor?: unknown;
    requestKey?: unknown;
    expected?: ISkillImportExpected;
    id?: unknown;
    restore?: unknown;
}

export interface ISkillImportExpected {
    id: string;
    version: number;
    hash: string;
}

export interface ILegacySkillExpected extends ISkillImportExpected {
    source: ISkillSourceReceipt;
}
