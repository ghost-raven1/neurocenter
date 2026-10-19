/** Комментарий к приложению (в витрине). */
export interface IComment {
    author: string;
    text: string;
    at: number;
    /** Вложенные ответы на этот комментарий. */
    replies?: IComment[];
}

const KEYS = { likes: 'store.likes.v1', comments: 'store.comments.v1' };

const readMap = <T,>(key: string): Record<string, T> => {
    try {
        return JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<string, T>;
    } catch {
        return {};
    }
};

const writeMap = <T,>(key: string, value: Record<string, T>): void => {
    window.localStorage.setItem(key, JSON.stringify(value));
};

/** Кол-во лайков приложения (клиентская статистика). */
export const getLikeCount = (id: string): number => (readMap<number>(KEYS.likes)[id] ?? 0);

/** Переключить лайк; возвращает новое кол-во лайков. */
export const toggleLike = (id: string): number => {
    const m = readMap<number>(KEYS.likes);
    const next = (m[id] ?? 0) > 0 ? (m[id] ?? 0) - 1 : (m[id] ?? 0) + 1;
    m[id] = next < 0 ? 0 : next;
    writeMap(KEYS.likes, m);
    return m[id] ?? 0;
};

/** Комментарии приложения. */
export const getComments = (id: string): IComment[] => (readMap<IComment[]>(KEYS.comments)[id] ?? []);

/** Добавить комментарий; возвращает полный список. */
export const addComment = (id: string, author: string, text: string): IComment[] => {
    const m = readMap<IComment[]>(KEYS.comments);
    const arr = m[id] ?? [];
    m[id] = [ ...arr, { author, text, at: Date.now() } ];
    writeMap(KEYS.comments, m);
    return m[id];
};

/** Удалить комментарий по индексу. */
export const deleteComment = (id: string, index: number): IComment[] => {
    const m = readMap<IComment[]>(KEYS.comments);
    const arr = m[id] ?? [];
    m[id] = arr.filter((_, i) => i !== index);
    writeMap(KEYS.comments, m);
    return m[id];
};

/** Ответить на комментарий (вложенный ответ). */
export const replyToComment = (id: string, parentIndex: number, author: string, text: string): IComment[] => {
    const m = readMap<IComment[]>(KEYS.comments);
    const arr = m[id] ?? [];
    const c = arr[parentIndex];
    if (!c) {
        return arr;
    }
    c.replies = [ ...(c.replies ?? []), { author, text, at: Date.now() } ];
    m[id] = [ ...arr ];
    writeMap(KEYS.comments, m);
    return m[id];
};

/** Удалить вложенный ответ. */
export const deleteReply = (id: string, parentIndex: number, replyIndex: number): IComment[] => {
    const m = readMap<IComment[]>(KEYS.comments);
    const arr = m[id] ?? [];
    const c = arr[parentIndex];
    if (!c?.replies) {
        return arr;
    }
    c.replies = c.replies.filter((_, i) => i !== replyIndex);
    m[id] = [ ...arr ];
    writeMap(KEYS.comments, m);
    return m[id];
};
