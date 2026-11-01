import base from '../../../../core/api/base';
import type { TRestoreIntent, IRestoreJob, IRestoreStatus } from '../interfaces';
const root = '/api/maintenance/restore';
/** Mutations всегда повторяют exact requestKey; потерянный ответ проверяется отдельным read. */
export const webRestoreApi = {
    status: () => base.get<IRestoreStatus>(root).then((response) => response.data),
    request: (key: string) =>
        base.get<IRestoreJob>(root + '/requests/' + encodeURIComponent(key)).then((response) => response.data),
    submit: (intent: TRestoreIntent) =>
        base
            .post<IRestoreJob>(root + (intent.kind === 'preview' ? '/previews' : ''), intent.input)
            .then((response) => response.data),
    cancel: (id: string) =>
        base
            .post<IRestoreJob>(root + '/jobs/' + encodeURIComponent(id) + '/cancel', {})
            .then((response) => response.data),
    cancelRequest: (key: string) =>
        base
            .post<{ cancelled: true }>(root + '/requests/' + encodeURIComponent(key) + '/cancel', {})
            .then((response) => response.data),
};
