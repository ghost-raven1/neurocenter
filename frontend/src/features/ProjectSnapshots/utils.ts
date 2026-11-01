import type { IProjectSnapshot } from './interfaces';

export const snapshotPending = (snapshot: IProjectSnapshot) =>
    snapshot.status === 'UPLOADING' || snapshot.status === 'VERIFYING';
