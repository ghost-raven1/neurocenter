import { useContext, useEffect, useState } from 'react';
import { FEATURE_FLAGS_CHANGED, FeatureAvailabilityContext } from '../FeatureFlags/FeatureAvailability';
import { CardDepth } from '../CardDepth/CardDepth';
import { NeuralBackdrop } from './NeuralBackdrop';
const disabled = { cardDepthEnabled: false, neuralBackgroundEnabled: false };

/** One public visual snapshot serves the login page; authenticated flags override it after sign-in. */
export function VisualAppearance(): JSX.Element {
    const availability = useContext(FeatureAvailabilityContext);
    const [publicState, setPublicState] = useState(disabled);
    const known = !!availability.data;
    useEffect(() => {
        if (known) return;
        let generation = 0, controller: AbortController | undefined, disposed = false;
        const read = (): void => {
            const current = ++generation;
            controller?.abort(); controller = new AbortController();
            void fetch('/api/ui/appearance', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
                .then(async response => response.ok ? response.json() as Promise<unknown> : null)
                .then(value => {
                    if (disposed || current !== generation) return;
                    const snapshot = value && typeof value === 'object' ? value as Record<string, unknown> : {};
                    setPublicState(snapshot.available === true ? { cardDepthEnabled: snapshot.cardDepthEnabled === true, neuralBackgroundEnabled: snapshot.neuralBackgroundEnabled === true } : disabled);
                }).catch(() => { if (!disposed && current === generation) setPublicState(disabled); });
        };
        read(); window.addEventListener('focus', read); window.addEventListener(FEATURE_FLAGS_CHANGED, read);
        return () => { disposed = true; controller?.abort(); window.removeEventListener('focus', read); window.removeEventListener(FEATURE_FLAGS_CHANGED, read); };
    }, [known]);
    const cardDepthEnabled = availability.data ? availability.data.flags.card_depth_effect === true : publicState.cardDepthEnabled;
    const neuralBackgroundEnabled = availability.data ? availability.data.flags.neural_background === true : publicState.neuralBackgroundEnabled;
    useEffect(() => {
        document.documentElement.classList.toggle('neural-background-enabled', neuralBackgroundEnabled);
        return () => document.documentElement.classList.remove('neural-background-enabled');
    }, [neuralBackgroundEnabled]);
    return <><CardDepth enabled={cardDepthEnabled}/>{neuralBackgroundEnabled && <NeuralBackdrop/>}</>;
}
