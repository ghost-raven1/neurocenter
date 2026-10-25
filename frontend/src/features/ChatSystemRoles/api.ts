import api from '../../core/api/base';
import {systemRoleChatsApi} from '../SystemRoleChat/api';
import type {ServiceDialog} from '../SystemRoleChat/types';
import type {ChatRoleOrigin} from './types';

/** Origin binding stores references only; accepted task transport remains the existing private workflow. */
export function originSystemRoleApi(origin: ChatRoleOrigin): typeof systemRoleChatsApi {
    return {
        ...systemRoleChatsApi,
        list: async () => {
            const value = (await api.get<ServiceDialog | null>('/api/chat-system-roles/origin', {params: origin})).data;
            return value ? [value] : [];
        },
        create: async () => (await api.post<ServiceDialog>('/api/chat-system-roles/origin', origin)).data,
    };
}
