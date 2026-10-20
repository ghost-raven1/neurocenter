import type {UploadMetadata} from '../catalog-service/src/source-upload/source-upload.model';
export function inspectUploadArchive(filename:string,options:{name:string;format:'zip'|'tar.gz'|'file'}):Promise<UploadMetadata>;
