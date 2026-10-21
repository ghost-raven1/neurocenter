import {CanActivate,ExecutionContext,Injectable} from '@nestjs/common';
import type {Request} from 'express';
import {requiredRouteFeatures} from '../../../shared/feature-policy.cjs';
import {assertInternal} from '../access/access.controller';
import {requireFeaturesEnabled} from './require-feature-enabled';
/** The native service repeats admission when a trusted caller bypasses the public Gateway. */
@Injectable()
export class FeaturePolicyGuard implements CanActivate{
    async canActivate(context:ExecutionContext):Promise<boolean>{
        const request=context.switchToHttp().getRequest<Request>(),keys=requiredRouteFeatures(request.method,request.path,request.body);
        if(keys.length){assertInternal(request.headers['x-neurocenter-internal']);await requireFeaturesEnabled(keys);}
        return true;
    }
}
