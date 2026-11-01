import type { useLocalProviders } from '../hooks/useLocalProviders';
export interface IOpenCodeAccountsStepProps {
    value: ReturnType<typeof useLocalProviders>;
    onContinue: () => void;
}
