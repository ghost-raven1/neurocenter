import type { IQuota, TProjectState } from './dto';

/** Строка проекта PostgreSQL; используется чтением каталога и транзакцией настроек. */
export interface IProjectRow {
    id: string;
    name: string;
    external_resource_id: string | null;
    fs_root_path: string | null;
    state: TProjectState;
    head_snapshot_id: string | null;
    head_snapshot_date: string | null;
    head_author: string | null;
    head_revision: number | string;
    logical_bytes: number | string;
    retained_bytes: number | string;
    retention: number;
    active_profile_id: string | null;
    active_profile_revision: number;
    active_operations: number;
    quota: IQuota | string | null;
    rag_project_key: string | null;
    created_at: string;
}
