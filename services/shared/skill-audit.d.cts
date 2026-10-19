/** Сводка версии содержит только идентичность снимка и SHA-256, без текста скилла. */
export interface ISkillAuditSummary {
    generation: string;
    version: number;
    sha256: string;
}

interface ISkillAuditIdentity {
    id: string;
    at: string;
    actor: string;
    resourceId: string;
}

export interface ISkillFileAuditEvent extends ISkillAuditIdentity {
    action: 'skill.create' | 'skill.update' | 'skill.delete';
    source: 'editor' | 'sync' | 'bootstrap';
    before: ISkillAuditSummary | null;
    after: ISkillAuditSummary | null;
}

/** Папка не имеет версии файла: фиксируется только факт её создания через редактор. */
export interface ISkillDirectoryAuditEvent extends ISkillAuditIdentity {
    action: 'skill.directory.create';
    source: 'editor';
    before: null;
    after: { directory: true };
}

export type ISkillAuditEvent = ISkillFileAuditEvent | ISkillDirectoryAuditEvent;

/** Проверяет весь пакет до записи; точный повтор UUID разрешён, разные данные одного UUID отвергаются. */
export function normalizeSkillAuditEvents(raw: unknown): ISkillAuditEvent[];
