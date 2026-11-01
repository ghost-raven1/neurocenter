import api from '../../core/api/base';
import { systemRoleChatsApi } from '../SystemRoleChat/api';
import type { IServiceDialog } from '../SystemRoleChat/interfaces';
import type { IChatRoleOrigin } from './interfaces';

/** Origin binding stores references only; accepted task transport remains the existing private workflow. */
export function originSystemRoleApi(origin: IChatRoleOrigin): typeof systemRoleChatsApi {
    return {
        ...systemRoleChatsApi,
        list: async () => {
            const value = (await api.get<IServiceDialog | null>('/api/chat-system-roles/origin', { params: origin }))
                .data;
            return value ? [value] : [];
        },
        create: async () => (await api.post<IServiceDialog>('/api/chat-system-roles/origin', origin)).data,
    };
}
