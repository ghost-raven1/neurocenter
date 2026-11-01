import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { useState } from 'react';
import { useAuthRequestOwner } from '../UserBlock/hooks/useAuthRequestOwner';
import { RequestFormModal } from './RequestFormModal';
import { RequestDetails } from './RequestDetails';
import type { ICatalogRequest, TRequestAssetType, IRequestProject } from './interfaces';

interface IProps {
    projects: IRequestProject[];
    projectId?: string;
    assetType?: TRequestAssetType;
    buttonType?: 'default' | 'primary';
    onSaved?: (value: ICatalogRequest) => void;
}
export function CatalogRequestButton({ onSaved, buttonType = 'default', ...props }: IProps): JSX.Element {
    const { scope } = useAuthRequestOwner();
    const [open, setOpen] = useState(false),
        [mounted, setMounted] = useState(false),
        [created, setCreated] = useState<string | null>(null);
    return (
        <>
            <FeatureButton
                features={['catalog_requests']}
                type={buttonType}
                onClick={() => {
                    setMounted(true);
                    setOpen(true);
                }}
            >
                Подать заявку
            </FeatureButton>
            {mounted && (
                <RequestFormModal
                    key={scope}
                    {...props}
                    open={open}
                    onClose={() => setOpen(false)}
                    onSaved={(value) => {
                        setOpen(false);
                        if (onSaved) onSaved(value);
                        else setCreated(value.id);
                    }}
                />
            )}
            {created && (
                <RequestDetails
                    key={scope + ':' + created}
                    id={created}
                    projects={props.projects}
                    onClose={() => setCreated(null)}
                    onChanged={() => undefined}
                />
            )}
        </>
    );
}
