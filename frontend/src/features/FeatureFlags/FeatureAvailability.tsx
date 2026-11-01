import { useFeatureAvailability } from './hooks/useFeatureAvailability';
import { FeatureAvailabilityContext } from './context';
import { FEATURE_FLAGS_CHANGED } from './constants';
export { useFeatureAvailability } from './hooks/useFeatureAvailability';
export { FeatureAvailabilityContext } from './context';
export { featureAvailability } from './utils';
export { FEATURE_FLAGS_CHANGED } from './constants';
import { Alert, Button, Tooltip } from 'antd';
import type { ButtonProps } from 'antd';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSectionUpdates } from '../../core/socket/hooks/useSectionUpdates';
import { useAuthRequestOwner } from '../UserBlock/hooks/useAuthRequestOwner';
import { featureFlagsApi } from './api';
import { createAvailabilityController, emptyAvailability } from './availabilityController';
import type { IFeatureAvailabilityState } from './availabilityController';

import type { TFeatureFlagKey } from './interfaces';
import './FeatureFlags.less';

/** A single reader serves every entrypoint; role changes discard the prior account's state. */
export function FeatureAvailabilityProvider({ children }: { children: ReactNode }): JSX.Element {
    const { scope, captureOwner } = useAuthRequestOwner();
    const [result, setResult] = useState<{ scope: string; state: IFeatureAvailabilityState }>({
        scope: '',
        state: emptyAvailability(),
    });
    const controller = useMemo(
        () =>
            createAvailabilityController({
                read: featureFlagsApi.evaluated,
                captureOwner,
                onChange: (state) => setResult({ scope, state }),
            }),
        [scope, captureOwner],
    );
    useLayoutEffect(() => {
        controller.activate();
        if (scope) void controller.refresh();
        const changed = (): void => {
            if (scope) void controller.refresh();
        };
        window.addEventListener(FEATURE_FLAGS_CHANGED, changed);
        return () => {
            window.removeEventListener(FEATURE_FLAGS_CHANGED, changed);
            controller.dispose();
        };
    }, [controller, scope]);
    useSectionUpdates(
        ['maintenance'],
        () => {
            void controller.refresh();
        },
        !!scope,
    );
    const state = result.scope === scope ? result.state : emptyAvailability();
    return (
        <FeatureAvailabilityContext.Provider value={{ ...state, refresh: controller.refresh }}>
            {children}
        </FeatureAvailabilityContext.Provider>
    );
}

/** A visible explanation accompanies disabled actions without removing existing data. */
export function FeatureAvailabilityNotice({ features }: { features: TFeatureFlagKey[] }): JSX.Element | null {
    const value = useFeatureAvailability(...features);
    if (value.enabled) return null;
    return (
        <Alert
            className="feature-availability-notice"
            type="info"
            showIcon
            message={value.reason}
            action={
                <Button
                    size="small"
                    loading={value.loading}
                    onClick={() => {
                        void value.refresh();
                    }}
                >
                    Проверить
                </Button>
            }
        />
    );
}

/** Guard the action as well as its appearance; viewing and closing a feature remains possible. */
export function FeatureButton({
    features,
    disabled,
    onClick,
    ...props
}: ButtonProps & { features: TFeatureFlagKey[] }): JSX.Element {
    const value = useFeatureAvailability(...features);
    const button = (
        <Button
            {...props}
            disabled={disabled || !value.enabled}
            onClick={(event) => {
                if (value.enabled && !disabled) onClick?.(event);
            }}
        />
    );
    return value.enabled ? (
        button
    ) : (
        <Tooltip title={value.reason}>
            <span
                className={'feature-action' + (props.block ? ' feature-action_block' : '')}
                tabIndex={0}
                aria-label={value.reason}
            >
                {button}
            </span>
        </Tooltip>
    );
}
