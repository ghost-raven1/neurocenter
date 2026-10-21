import { Alert, Button, Tooltip } from 'antd';
import type { ButtonProps } from 'antd';
import { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { featureFlagsApi } from './api';
import { createAvailabilityController, emptyAvailability } from './availabilityController';
import type { IFeatureAvailabilityState } from './availabilityController';
import { featureDefinition } from './types';
import type { TFeatureFlagKey } from './types';
import './FeatureFlags.less';

export const FEATURE_FLAGS_CHANGED = 'neurocenter:feature-flags-changed';
interface IAvailabilityContext extends IFeatureAvailabilityState { refresh: () => Promise<void>; }
export const FeatureAvailabilityContext = createContext<IAvailabilityContext>({ ...emptyAvailability(), refresh: async () => undefined });

/** A single reader serves every entrypoint; role changes discard the prior account's state. */
export function FeatureAvailabilityProvider({ children }: { children: ReactNode }): JSX.Element {
    const { scope, captureOwner } = useAuthRequestOwner();
    const [result, setResult] = useState<{ scope: string; state: IFeatureAvailabilityState }>({ scope: '', state: emptyAvailability() });
    const controller = useMemo(() => createAvailabilityController({ read: featureFlagsApi.evaluated, captureOwner,
        onChange: state => setResult({ scope, state }) }), [scope, captureOwner]);
    useLayoutEffect(() => {
        controller.activate();
        if (scope) void controller.refresh();
        const changed = (): void => { if (scope) void controller.refresh(); };
        window.addEventListener(FEATURE_FLAGS_CHANGED, changed);
        return () => { window.removeEventListener(FEATURE_FLAGS_CHANGED, changed); controller.dispose(); };
    }, [controller, scope]);
    useSectionUpdates(['maintenance'], () => { void controller.refresh(); }, !!scope);
    const state = result.scope === scope ? result.state : emptyAvailability();
    return <FeatureAvailabilityContext.Provider value={{ ...state, refresh: controller.refresh }}>{children}</FeatureAvailabilityContext.Provider>;
}

/** Unknown state blocks new work; callers keep their own ACL and recovery controls. */
export function featureAvailability(state: IFeatureAvailabilityState, keys: TFeatureFlagKey[]) {
    const disabled = keys.filter(key => state.data?.flags[key] !== true);
    let reason = '';
    if (disabled.length && !state.data) reason = state.error ? 'Доступность функций не подтверждена. Повторите проверку.' : 'Проверяем доступность функций…';
    else if (disabled.length) reason = disabled.map(key => {
        const blockers = state.data!.blockedBy[key];
        return blockers.length ? `${featureDefinition(key).name}: выключено ${blockers.map(item => `«${featureDefinition(item).name}»`).join(', ')}`
            : `«${featureDefinition(key).name}» выключено главным администратором`;
    }).join('. ');
    return { enabled: disabled.length === 0, reason, loading: state.loading, known: !!state.data };
}

export function useFeatureAvailability(...keys: TFeatureFlagKey[]) {
    const state = useContext(FeatureAvailabilityContext);
    return { ...featureAvailability(state, keys), refresh: state.refresh };
}

/** A visible explanation accompanies disabled actions without removing existing data. */
export function FeatureAvailabilityNotice({ features }: { features: TFeatureFlagKey[] }): JSX.Element | null {
    const value = useFeatureAvailability(...features);
    if (value.enabled) return null;
    return <Alert className="feature-availability-notice" type="info" showIcon message={value.reason}
        action={<Button size="small" loading={value.loading} onClick={() => { void value.refresh(); }}>Проверить</Button>} />;
}

/** Guard the action as well as its appearance; viewing and closing a feature remains possible. */
export function FeatureButton({ features, disabled, onClick, ...props }: ButtonProps & { features: TFeatureFlagKey[] }): JSX.Element {
    const value = useFeatureAvailability(...features);
    const button = <Button {...props} disabled={disabled || !value.enabled} onClick={event => { if (value.enabled && !disabled) onClick?.(event); }} />;
    return value.enabled ? button : <Tooltip title={value.reason}><span className={'feature-action' + (props.block ? ' feature-action_block' : '')} tabIndex={0} aria-label={value.reason}>{button}</span></Tooltip>;
}
