import { useLayoutEffect, useMemo } from 'react';
import { useSelector, useStore } from 'react-redux';
import type { RootState } from '../../store';
import { authDataScope } from './authDataScope';
import { createAuthRequestOwner } from './authRequestOwner';

function currentScope(state: RootState): string {
    const { user, policies } = state.userBlock;
    return user ? authDataScope({ user, policies }) : '';
}

/** Проверяет владельца синхронно по store, в том числе до следующего render/effect формы. */
export function useAuthRequestOwner() {
    const store = useStore<RootState>();
    const scope = useSelector(currentScope);
    const owner = useMemo(() => createAuthRequestOwner(scope, () => currentScope(store.getState())), [scope, store]);
    useLayoutEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    return { scope, captureOwner: owner.captureOwner };
}
