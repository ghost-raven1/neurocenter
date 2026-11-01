import type { IOpenCodeInstallSupply } from '../../../shared/opencode-cli-install.cjs';

/** The canonical Gateway supply must approve exact bundled bytes before each new local effect. */
export abstract class ComputerSetupSupplyApproval {
    abstract requireOpenCode(supply: IOpenCodeInstallSupply, signal?: AbortSignal): Promise<void>;
}
