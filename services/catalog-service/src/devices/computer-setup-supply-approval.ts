import type {OpenCodeInstallSupply} from '../../../shared/opencode-cli-install.cjs';

/** The canonical Gateway supply must approve exact bundled bytes before each new local effect. */
export abstract class ComputerSetupSupplyApproval {
    abstract requireOpenCode(supply:OpenCodeInstallSupply,signal?:AbortSignal):Promise<void>;
}
