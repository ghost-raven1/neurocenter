import type { IAiPlugin } from '../catalog/dto';
import { publicationHash } from './publication-validation';

/** Native CAS исключает время чтения и фиксирует редактируемые поля, ID и ordinal версии. */
export function nativeCardHash(card:IAiPlugin):string {
    const {createdAt:_created,updatedAt:_updated,...content}=card;
    return publicationHash(content);
}
