import { Alert, Button, Space, Spin, Typography } from 'antd';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import bffApi from '../../core/api/bff';
import type { ISkillFile } from '../../core/api/interfaces';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { skillGenerationKey } from './skillHistory';
import './SkillVersionViewer.less';

const StoreInstruction = lazy(() => import('./StoreInstruction'));
interface Props { head: ISkillFile; version: number; projectId?: string; onClose: () => void; }
interface State { owner: object; loading: boolean; file?: ISkillFile; error?: string; }

/** Historical payload is read-only and never replaces the card used by edit or install actions. */
export function SkillVersionViewer({ head, version, projectId, onClose }: Props): JSX.Element {
    const { scope, captureOwner } = useAuthRequestOwner(), generation = skillGenerationKey(head.meta);
    const owner = useMemo(() => ({ active: false, generation: 0, request: 0 }), [scope, projectId, head.path, generation, version]);
    const current = useRef(owner); current.current = owner;
    const [state, setState] = useState<State>({ owner, loading: true });
    const read = async (): Promise<void> => {
        const auth = captureOwner(), lifetime = owner.generation, request = ++owner.request;
        const owns = (): boolean => auth() && owner.active && current.current === owner && owner.generation === lifetime && request === owner.request;
        if (!owns()) return;
        setState({ owner, loading: true });
        try {
            const file = await bffApi.getSkill(head.path, version);
            if (!owns()) return;
            if (file.path !== head.path || file.meta.version !== version || skillGenerationKey(file.meta) !== generation) {
                throw new Error('Скилл или его версия изменились. Обновите карточку и выберите версию заново.');
            }
            setState({ owner, loading: false, file });
        } catch (cause) { if (owns()) setState({ owner, loading: false, error: errorMessage(cause, 'Не удалось прочитать выбранную версию скилла.') }); }
    };
    useEffect(() => {
        owner.active = true; owner.generation++; void read();
        return () => { owner.active = false; owner.generation++; owner.request++; };
    }, [owner]);
    const visible: Omit<State, 'owner'> = state.owner === owner ? state : { loading: true };
    return <section className="store-skill-version" aria-label={`Просмотр версии ${version}`}>
        <Space wrap><Typography.Text strong>Версия {version} · Только чтение</Typography.Text><Button size="small" onClick={onClose}>Закрыть версию</Button></Space>
        {visible.loading && <div role="status"><Spin size="small" /> Читаем выбранную версию…</div>}
        {visible.error && <Alert showIcon type="warning" message={visible.error} action={<Button size="small" onClick={() => void read()}>Повторить чтение</Button>} />}
        {visible.file && <>
            <Suspense fallback={<div role="status">Готовим инструкцию версии {version}…</div>}><StoreInstruction body={visible.file.body} resources={visible.file.resources} skillKey={`${head.path}:${generation}:${version}`} /></Suspense>
            <details><summary>Исходник версии {version}</summary><pre className="store-details__source" tabIndex={0}>{visible.file.body}</pre></details>
        </>}
    </section>;
}
