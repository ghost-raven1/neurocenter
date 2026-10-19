import { IUserInfo } from '../../core/interfaces';

/**
 * Состояние фичи UserBlock (auth + ABAC).
 */
export interface IUserBlockState {
    isAuth: boolean;
    processing: boolean;
    error: string;
    user: IUserInfo | null;
    policies: Record<string, string[]>;
    /** Только ответ текущего запроса может менять сессию и права. */
    request: { id: string; kind: 'init' | 'switchRole' | 'logout' } | null;
}
