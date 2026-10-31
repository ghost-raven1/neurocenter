import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelTokenQuotasService } from './model-token-quotas.service';
import type { ModelTokenQuotaInput, ModelTokenQuotaReceipt, ModelTokenQuotaView } from './model-token-quotas.types';

/** Exact model/user identity never comes from display labels or the model's generated content. */
@Controller('api/models')
export class ModelTokenQuotasController {
    constructor(private readonly quotas: ModelTokenQuotasService) {}
    /** MainAdmin reads a fresh balance for the canonical model and normalized platform email, including when enforcement is OFF.
     * Decimal-string counters preserve precision. Unknown usage stays separate from known charges; the last answer may exceed the budget.
     */
    @Get(':id/token-quotas/:email') read(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('email') email: string,
    ): Promise<ModelTokenQuotaView> {
        return this.quotas.read(req, id, email);
    }
    /** MainAdmin saves a policy with revision CAS and an immutable request receipt, including when enforcement is OFF.
     * Only the five declared fields are accepted. A changed intent under the same writer/requestKey or stale revision returns 409.
     * Exact accepted replay survives a deleted model or target user. A 503 leaves the result unconfirmed: read the receipt or explicitly replay the same intent.
     * Finite enforcement is supported for managed server text only; unsupported model surfaces return 409.
     */
    @Put(':id/token-quotas/:email') save(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('email') email: string,
        @Body() body: ModelTokenQuotaInput,
    ): Promise<ModelTokenQuotaReceipt> {
        return this.quotas.save(req, id, email, body);
    }
    /** MainAdmin reads its own exact accepted receipt when enforcement is OFF or its model/user was deleted.
     * A missing or differently scoped receipt returns 404; absence does not prove that an earlier attempt cannot still commit.
     */
    @Get(':id/token-quotas/:email/requests/:requestKey') receipt(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('email') email: string,
        @Param('requestKey') key: string,
    ): Promise<ModelTokenQuotaReceipt> {
        return this.quotas.receipt(req, id, email, key);
    }
}
