import {HeartFilled, HeartOutlined, MessageOutlined} from '@ant-design/icons';
import {Alert, Button, Space, Tooltip} from 'antd';
import {useEffect, useRef, useState} from 'react';
import AccessibleDrawer from '../../common/components/AccessibleDrawer';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {discussionsApi} from './api';
import {DiscussionThread} from './DiscussionThread';
import {ambiguousFailure} from './model';
import type {CatalogReaction} from './types';
import './Discussions.less';

function Feedback({catalogId, title}: {catalogId: string; title?: string}): JSX.Element {
    const {captureOwner} = useAuthRequestOwner(), availability = useFeatureAvailability('catalog_reactions');
    const [reaction, setReaction] = useState<CatalogReaction>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
    const lock = useRef(false), sequence = useRef(0), pending = useRef<boolean>(), activated = useRef(false);
    const read = async (): Promise<void> => {
        if (lock.current || pending.current !== undefined) return;
        const owns = captureOwner(), current = ++sequence.current; if (!owns()) return;
        try {const value = await discussionsApi.reaction(catalogId); if (owns() && current === sequence.current) {setReaction(value); setError('');}}
        catch (cause) {if (owns() && current === sequence.current) setError(errorMessage(cause, 'Не удалось загрузить отметки. Повторите проверку.'));}
    };
    useEffect(() => {void read(); return () => {sequence.current++;};}, [catalogId, captureOwner]);
    const toggle = async (): Promise<void> => {
        const owns = captureOwner(), desired = pending.current ?? !reaction?.liked;
        if (!owns() || lock.current || !reaction || desired && !availability.enabled && pending.current === undefined) return;
        lock.current = true; pending.current = desired; sequence.current++; setBusy(true); setError('');
        try {const value = await discussionsApi.setReaction(catalogId, desired); if (owns()) {setReaction(value); pending.current = undefined;}}
        catch (cause) {if (owns()) {
            const ambiguous = ambiguousFailure(cause);
            if (!ambiguous) pending.current = undefined;
            setError(errorMessage(cause, ambiguous ? 'Отметка не подтверждена. Повторите: повторная отметка не добавится.' : 'Отметка не изменена. Проверьте актуальное состояние.'));
        }}
        finally {lock.current = false; if (owns()) setBusy(false);}
    };
    const commentCount = reaction?.commentCount;
    return <div className="catalog-feedback" onClick={event => event.stopPropagation()}>
        <Space size={4} wrap><Tooltip title={reaction?.liked ? 'Убрать из понравившихся' : availability.enabled ? 'Мне нравится' : availability.reason}>
            <span><Button type="text" size="small" icon={reaction?.liked ? <HeartFilled/> : <HeartOutlined/>} className={reaction?.liked ? 'catalog-feedback__liked' : ''} aria-label={reaction?.liked ? 'Убрать из понравившихся' : 'Мне нравится'} aria-pressed={reaction?.liked ?? false} loading={busy} disabled={!reaction || busy || !reaction.liked && !availability.enabled && pending.current === undefined} onClick={() => {void toggle();}}>{reaction ? reaction.count > 0 && <span className="catalog-feedback__count">{reaction.count}</span> : '—'}</Button></span>
        </Tooltip><Button type="text" size="small" icon={<MessageOutlined aria-hidden/>} aria-label={commentCount !== undefined && commentCount > 0 ? 'Комментарии: ' + commentCount : 'Комментарии'} onClick={() => {activated.current = true; setOpen(true);}}>Комментарии{commentCount !== undefined && commentCount > 0 && <span className="catalog-feedback__count">{commentCount}</span>}</Button></Space>
        {error && <Alert type="warning" showIcon message={error} action={<Button size="small" onClick={() => {if (pending.current !== undefined) void toggle(); else void read();}}>Повторить</Button>}/>}
        {activated.current && <AccessibleDrawer open={open} onClose={() => {setOpen(false); void read();}} title={title ? 'Комментарии · ' + title : 'Комментарии к карточке'} width="min(680px, 100vw)" destroyOnClose>
            {open && <DiscussionThread target={{type: 'catalog', id: catalogId}} onChanged={() => {void read();}}/>}
        </AccessibleDrawer>}
    </div>;
}

/** Each card has a stable target; drawer content shares the Help discussion component. */
export function CatalogFeedback(props: {catalogId: string; title?: string}): JSX.Element {
    const {scope} = useAuthRequestOwner();
    return <Feedback key={JSON.stringify([scope, props.catalogId])} {...props}/>;
}
