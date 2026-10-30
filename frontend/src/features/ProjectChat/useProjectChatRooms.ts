import {useCallback, useEffect, useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {projectChatApi} from './api';
import {DEFAULT_PROJECT_CHAT_ROOM, type ProjectChatCreateRoom, type ProjectChatRooms, type ProjectChatRoomSummary, type ProjectChatUpdateRoom} from './types';

/** Initial selection is a hint; the current user's fresh authorized room list still decides access. */
export function useProjectChatRooms(projectId: string, initialRoomId = DEFAULT_PROJECT_CHAT_ROOM) {
    const {captureOwner} = useAuthRequestOwner();
    const [data, setData] = useState<ProjectChatRooms>(), [roomId, setRoomId] = useState(initialRoomId), [error, setError] = useState(''), [loading, setLoading] = useState(true);
    const authorityEpoch = useRef(0), selected = useRef(roomId), active = useRef(true), sequence = useRef(0), reading = useRef<AbortController>(), mutations = useRef(new Set<AbortController>());
    selected.current = roomId;
    const invalidateAuthority = (): void => {authorityEpoch.current++; sequence.current++; reading.current?.abort(); mutations.current.forEach(controller => controller.abort());};
    const refresh = useCallback(async (): Promise<void> => {
        const owns = captureOwner(), seq = ++sequence.current, controller = new AbortController(); reading.current?.abort(); reading.current = controller;
        try {
            const result = await projectChatApi.rooms(projectId, controller.signal);
            if (!active.current || !owns() || controller.signal.aborted || seq !== sequence.current) return;
            setData(result); setError('');
            if (!result.rooms.some(room => room.id === selected.current)) {selected.current = DEFAULT_PROJECT_CHAT_ROOM; setRoomId(DEFAULT_PROJECT_CHAT_ROOM);}
        } catch (cause) {
            if (!active.current || !owns() || controller.signal.aborted || seq !== sequence.current) return;
            if (isAxiosError(cause) && [401,403,404].includes(cause.response?.status ?? 0)) {invalidateAuthority(); setData(undefined); selected.current = DEFAULT_PROJECT_CHAT_ROOM; setRoomId(DEFAULT_PROJECT_CHAT_ROOM); setLoading(false);}
            setError(errorMessage(cause, 'Не удалось обновить диалоги. Открытый чат можно проверить отдельно.'));
        } finally {if (active.current && owns() && seq === sequence.current) setLoading(false);}
    }, [projectId, captureOwner]);
    useEffect(() => {
        active.current = true; void refresh(); const timer = setInterval(() => {if (document.visibilityState !== 'hidden') void refresh();}, 4000);
        return () => {active.current = false; sequence.current++; clearInterval(timer); reading.current?.abort(); mutations.current.forEach(controller => controller.abort());};
    }, [refresh]);
    useSectionUpdates(['access','projects','project_chat'], () => {void refresh();});
    const mutate = async (work: (signal: AbortSignal) => Promise<ProjectChatRoomSummary>): Promise<ProjectChatRoomSummary> => {
        const owns = captureOwner(), controller = new AbortController(), epoch = authorityEpoch.current; mutations.current.add(controller);
        try {
            const room = await work(controller.signal);
            if (!owns() || !active.current || controller.signal.aborted || epoch !== authorityEpoch.current) throw new Error('Доступ к диалогам изменился. Подтверждение не применено; обновите список и проверьте действие. Введённые значения сохранены.');
            if (owns() && active.current) {
                sequence.current++; reading.current?.abort(); setData(previous => previous ? {...previous, rooms: [...previous.rooms.filter(value => value.id !== room.id), room]} : previous);
                selected.current = room.id; setRoomId(room.id); void refresh();
            }
            return room;
        } catch (cause) {
            if (owns() && active.current && isAxiosError(cause) && [401,403,404].includes(cause.response?.status ?? 0)) {invalidateAuthority(); setData(undefined); selected.current = DEFAULT_PROJECT_CHAT_ROOM; setRoomId(DEFAULT_PROJECT_CHAT_ROOM);}
            throw cause;
        } finally {mutations.current.delete(controller);}
    };
    const compare = async (id: string): Promise<ProjectChatRoomSummary> => {
        const owns = captureOwner(), controller = new AbortController(), epoch = authorityEpoch.current; mutations.current.add(controller);
        try {
            const result = await projectChatApi.rooms(projectId, controller.signal);
            if (!owns() || !active.current || controller.signal.aborted || epoch !== authorityEpoch.current) throw new Error('Доступ изменился. Сравнение не применено; введённые значения сохранены.');
            const room = result.rooms.find(value => value.id === id);
            if (!room) {invalidateAuthority(); setData(result); selected.current = DEFAULT_PROJECT_CHAT_ROOM; setRoomId(DEFAULT_PROJECT_CHAT_ROOM); throw new Error('Диалог больше недоступен. Введённые значения сохранены.');}
            if (!room.canManage) throw new Error('Для изменения диалога больше нет прав. Введённые значения сохранены.');
            return room;
        } catch (cause) {
            if (owns() && active.current && isAxiosError(cause) && [401,403,404].includes(cause.response?.status ?? 0)) {invalidateAuthority(); setData(undefined); selected.current = DEFAULT_PROJECT_CHAT_ROOM; setRoomId(DEFAULT_PROJECT_CHAT_ROOM);}
            throw cause;
        } finally {mutations.current.delete(controller);}
    };
    return {data, roomId, error, loading, refresh, forget: (_id: string) => {invalidateAuthority(); setData(undefined); selected.current = DEFAULT_PROJECT_CHAT_ROOM; setRoomId(DEFAULT_PROJECT_CHAT_ROOM); void refresh();}, select: (id: string) => {selected.current = id; setRoomId(id);},
        compare,
        create: (input: ProjectChatCreateRoom) => mutate(signal => projectChatApi.createRoom(projectId, input, signal)),
        update: (id: string, input: ProjectChatUpdateRoom) => mutate(signal => projectChatApi.updateRoom(projectId, id, input, signal))};
}
