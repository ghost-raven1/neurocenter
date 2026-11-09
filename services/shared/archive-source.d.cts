import type { IRuntimeSource } from './tool-runtime-source.cjs';
/** Internal execution plan references one checked local archive; public import remains asset.json. */
export interface IArchiveSource {
    type: 'archive';
    file: string;
    sha256: string;
    bytes: number;
    format: 'zip' | 'tar.gz' | 'file';
    runtimeSource: IRuntimeSource;
}
export function validateArchiveSource(value: IArchiveSource): IArchiveSource;
