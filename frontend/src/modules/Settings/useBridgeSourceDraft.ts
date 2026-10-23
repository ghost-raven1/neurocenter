import {useEffect, useState} from 'react';
import {useBridgeSource} from '../../features/McpBridge/useBridgeSource';

interface ISourceDraft {url: string; revision: number; sourceUrl: string;}

/** Background reads preserve an edited address; a newer server revision needs an explicit choice. */
export function useBridgeSourceDraft() {
    const source = useBridgeSource();
    const [draft, setDraft] = useState<ISourceDraft>();
    const data = source.data;
    useEffect(() => {
        if (data) setDraft(previous => !previous || previous.url === previous.sourceUrl
            ? {url: data.url, revision: data.revision, sourceUrl: data.url} : previous);
    }, [data?.url, data?.revision]);
    const current = draft ?? (data ? {url: data.url, revision: data.revision, sourceUrl: data.url} : undefined);
    const changed = !!current && current.url.trim() !== current.sourceUrl;
    const stale = !!current && !!data && current.revision !== data.revision;
    const blocked = source.loading || source.saving || !data;
    return {...source, url: current?.url ?? '', changed, stale, blocked,
        change: (url: string) => { if (data && !blocked) setDraft({...(current ?? {revision: data.revision, sourceUrl: data.url}), url}); },
        acceptCurrent: () => { if (data && !blocked) setDraft({url: data.url, revision: data.revision, sourceUrl: data.url}); },
        keepDraft: () => { if (data && current && !blocked) setDraft({...current, revision: data.revision, sourceUrl: data.url}); },
        saveDraft: async () => {
            if (!current || !changed || stale || blocked) return;
            if (await source.save(current.url)) setDraft(undefined);
        },
    };
}
