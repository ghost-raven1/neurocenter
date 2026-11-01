export interface IDatabaseIdentity {
    cluster: string;
    oid: string;
    marker: string;
    databaseName: string;
    projectId: string;
}
export interface IRetiredDatabaseFacts {
    identity: IDatabaseIdentity;
    retirementId: string;
    bytes: number;
    chunks: number;
    generations: number;
    backupPolicy: 'retained-until-explicit-purge';
    preserves: Array<'backups' | 'lance-snapshots' | 'local-files'>;
}
export interface IPurgeCommand {
    jobId: string;
    digest: string;
    facts: IRetiredDatabaseFacts;
}
export interface IPurgeReceipt {
    jobId: string;
    state: 'succeeded';
    databaseName: string;
    identity: IDatabaseIdentity;
    purgedAt: string;
}
