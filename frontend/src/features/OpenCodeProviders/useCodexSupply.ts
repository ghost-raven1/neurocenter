import {useEffect, useRef, useState} from 'react';
import pin from '../../../../services/shared/codex-connector-pin.json';
import api from '../../core/api/base';
import {errorMessage} from '../../common/utils/errorMessage';
import {artifactTargets} from '../McpBridge/runtimeArtifacts';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {packagingApi} from '../../modules/Store/packaging/api';
import type {ToolBuildRequest} from '../../modules/Store/packaging/types';

interface ISupply {state: 'ready' | 'missing' | 'building' | 'conflict'; buildId?: string; targets?: string[];}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
/** A published server supply is distinct from local authentication and configuration readiness. */
export function codexSupply(value: unknown): ISupply {
    const item = value as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || Array.isArray(item) || !['ready', 'missing', 'building', 'conflict'].includes(item.state as string)
        || Object.keys(item).some(key => !['state', 'buildId', 'targets'].includes(key)) || item.buildId !== undefined && !uuid(item.buildId)
        || item.targets !== undefined && (!Array.isArray(item.targets) || !item.targets.length || item.targets.length > 8
            || new Set(item.targets).size !== item.targets.length || item.targets.some(target => typeof target !== 'string' || !artifactTargets.includes(target as typeof artifactTargets[number])))) throw new Error('Сервер не подтвердил состояние поставки Codex. Повторите проверку.');
    return item as unknown as ISupply;
}
const read = async (signal: AbortSignal) => codexSupply((await api.get('/api/tool-builds/connectors/codex', {timeout: 10000, signal})).data);
const input = (requestKey: string): ToolBuildRequest => ({requestKey, kind: 'plugin', name: 'OpenCode Codex Bridge',
    description: 'Локальный auth-only коннектор Codex для OpenCode.', source: {type: 'repository', url: pin.repository, ref: pin.sourceCommit,
        subdirectory: 'packages/bridge', entrypoint: 'src/plugin.ts'}});

/** Build only a confirmed missing immutable connector; uncertainty replays the same request body. */
export function useCodexSupply(enabled: boolean, canBuild: boolean, reason: string) {
    const {scope, captureOwner} = useAuthRequestOwner(), mounted = useRef(true), currentScope = useRef(scope), generation = useRef(0), lock = useRef(false);
    const request = useRef<ToolBuildRequest>(), controller = useRef<AbortController>(), latest = useRef({enabled, canBuild, reason}); latest.current = {enabled, canBuild, reason};
    if (currentScope.current !== scope) {currentScope.current = scope; request.current = undefined; generation.current++; lock.current = false;}
    const [view, setView] = useState<{scope: string; supply?: ISupply; error: string; busy: boolean; unknown: boolean}>({scope, error: '', busy: false, unknown: false});
    const live = view.scope === scope ? view : {scope, error: '', busy: false, unknown: false};
    const reloadRef = useRef<() => Promise<void>>(async () => undefined);
    const reload = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || !mounted.current || !latest.current.enabled || lock.current) return;
        const seq = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
        const current = () => mounted.current && owns() && seq === generation.current && latest.current.enabled && !abort.signal.aborted;
        setView(previous => ({...previous, scope, busy: true, error: ''}));
        try {const supply = await read(abort.signal); if (current()) setView({scope, supply, busy: false, error: '', unknown: !!request.current});}
        catch (cause) {if (current()) setView({scope, busy: false, error: errorMessage(cause, 'Не удалось проверить поставку Codex.'), unknown: !!request.current});}
    };
    reloadRef.current = reload;
    useEffect(() => {
        mounted.current = true; generation.current++; lock.current = false; setView({scope, error: '', busy: false, unknown: !!request.current});
        if (enabled) void reloadRef.current();
        return () => {mounted.current = false; controller.current?.abort();};
    }, [scope, enabled]);
    useEffect(() => {
        if (!enabled || live.supply?.state !== 'building' || live.busy) return;
        const timer = setTimeout(() => {void reloadRef.current();}, 3000); return () => clearTimeout(timer);
    }, [enabled, live.supply?.state, live.busy]);
    const build = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns() || !mounted.current || lock.current || !latest.current.enabled) return;
        if (!latest.current.canBuild) {setView(previous => ({...previous, error: latest.current.reason})); return;}
        lock.current = true; const seq = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
        const current = () => mounted.current && owns() && seq === generation.current && latest.current.enabled && !abort.signal.aborted;
        setView(previous => ({...previous, scope, busy: true, error: ''}));
        try {
            const supply = await read(abort.signal); if (!current()) return;
            if (supply.state !== 'missing') {setView({scope, supply, busy: false, error: '', unknown: !!request.current}); return;}
            if (!latest.current.canBuild) {setView({scope, supply, busy: false, error: latest.current.reason, unknown: !!request.current}); return;}
            request.current ??= input(createBridgeRequestKey());
            const accepted = await packagingApi.create(request.current, abort.signal); if (!current()) return;
            if (!accepted || !uuid(accepted.id) || !['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(accepted.state)) throw new Error('Приём сборки не подтверждён. Повторите исходный запрос.');
            request.current = undefined;
            setView({scope, supply: accepted.state === 'FAILED' ? {state: 'missing'} : {state: 'building', buildId: accepted.id},
                busy: false, error: accepted.state === 'FAILED' ? 'Сборка остановилась. Проверьте операции и повторите подготовку.' : '', unknown: false});
        } catch (cause) {if (current()) setView({scope, busy: false, error: errorMessage(cause, 'Ответ сборки потерян. Повторите исходный запрос.'), unknown: !!request.current});}
        finally {if (current()) lock.current = false;}
    };
    return {...live, build, reload};
}
