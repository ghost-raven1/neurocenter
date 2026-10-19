export const PROJECT_LOCAL_KINDS = ['scan-project-inventory','prepare-adopt-installation','apply-adopt-installation',
    'list-local-variants','prepare-local-restore','apply-local-restore'];
export const PROJECT_LOCAL_READS = ['scan-project-inventory','list-local-variants'];
export const PROJECT_LOCAL_APPLIES = ['apply-adopt-installation','apply-local-restore'];
export const LOCAL_PREPARATIONS = ['prepare-local-change','prepare-adopt-installation','prepare-local-restore'];
export const LOCAL_APPLIES = ['apply-local-change',...PROJECT_LOCAL_APPLIES];
export const localPurpose = (kind: string): 'repair'|'adopt'|'restore-local' => kind.includes('adopt') ? 'adopt' : kind.includes('restore') ? 'restore-local' : 'repair';
export const localCapability = (kind: string): string => kind === 'scan-project-inventory' ? 'project-inventory-v1'
    : kind.includes('adopt') ? 'adopt-installation-v1' : 'local-recovery-v1';
