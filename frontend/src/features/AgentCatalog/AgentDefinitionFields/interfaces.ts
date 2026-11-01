import type { FormInstance } from 'antd';
import type { IAgentCreate, IAgentDefinition } from '../interfaces';

/** Component inputs. */
export interface IAgentDefinitionFieldsProps {
    form: FormInstance<IAgentEditorValues>;
    disabled: boolean;
}

export interface IAgentEditorValues extends Omit<IAgentCreate, 'definition'> {
    definition: IAgentDefinition;
}
