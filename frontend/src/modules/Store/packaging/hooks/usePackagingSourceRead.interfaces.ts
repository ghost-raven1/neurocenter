import type { IPackagingFilesResult } from '../sourceFiles';
export interface IPackagingSourceReadOptions {
    context: object;
    source: string;
    enabled: boolean;
    blocked: boolean;
    captureCurrent: () => () => boolean;
    onReading: (reading: boolean) => void;
    onStart: () => void;
    onRead: (result: IPackagingFilesResult, archiveName: string, current: () => boolean) => Promise<void> | void;
}
