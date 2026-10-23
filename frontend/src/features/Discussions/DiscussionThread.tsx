import {Alert, Button, Empty, Space, Spin, Typography} from 'antd';
import {ReloadOutlined} from '@ant-design/icons';
import {useRef, useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {discussionKey} from './model';
import {useDiscussion} from './useDiscussion';
import {CommentEntry} from './CommentEntry';
import {CommentComposer} from './CommentComposer';
import type {DiscussionComment, DiscussionTarget} from './types';
import './Discussions.less';

function Thread({target, draftKey}: {target: DiscussionTarget; draftKey: string}): JSX.Element {
    const {page, loading, error, load, saved, removed} = useDiscussion(target);
    const [reply, setReply] = useState<DiscussionComment>(), composer = useRef<HTMLDivElement>(null);
    return <section className="discussion-thread" aria-label="Обсуждение">
        <div className="discussion-thread__heading"><Typography.Title level={4}>Обсуждение {page ? '· ' + page.items.filter(value => !value.deleted).length : ''}</Typography.Title><Button aria-label="Обновить обсуждение" icon={<ReloadOutlined/>} loading={loading} onClick={() => {void load();}}/></div>
        {error && <Alert role="alert" type="error" showIcon message={error} action={<Button size="small" onClick={() => {void load();}}>Повторить</Button>}/>}
        {loading && !page && <Spin tip="Загружаем обсуждение…"/>}
        {page && <>
            {!page.items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Здесь пока нет комментариев. Задайте вопрос или поделитесь опытом."/>}
            <div className="discussion-thread__entries">{page.items.map(comment => <CommentEntry key={comment.id} comment={comment} parent={page.items.find(value => value.id === comment.parentId)} canReply={page.canComment}
                onReply={() => {setReply(comment); requestAnimationFrame(() => {composer.current?.scrollIntoView({block: 'nearest', behavior: 'smooth'}); composer.current?.querySelector('textarea')?.focus();});}}
                onSaved={saved} onRemoved={() => {removed(comment.id); void load();}} onDenied={() => {void load();}}/>)}</div>
            {page.nextCursor && <Space className="discussion-thread__more"><Button loading={loading} onClick={() => {void load(page.nextCursor!);}}>Показать ещё комментарии</Button></Space>}
            <div ref={composer}><CommentComposer target={target} draftKey={draftKey} canComment={page.canComment} canAttach={page.canAttach} attachmentsUnavailableReason={page.attachmentsUnavailableReason} reply={reply} onCancelReply={() => setReply(undefined)} onSaved={saved}/></div>
        </>}
    </section>;
}

/** Actor and target changes remount the read owner before displaying any prior content. */
export function DiscussionThread({target}: {target: DiscussionTarget}): JSX.Element {
    const {scope} = useAuthRequestOwner(), key = discussionKey(scope, target);
    return <Thread key={key} target={target} draftKey={key}/>;
}
