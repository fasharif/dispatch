import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  assignDeliverySchema,
  createDeliverySchema,
  deliveryListQuerySchema,
  proofOfDeliverySchema,
  reasonInputSchema,
  trackingLinkInputSchema,
  type AssignDeliveryInput,
  type CandidateDto,
  type CreateDeliveryInput,
  type DeliveryDetailDto,
  type DeliveryDto,
  type DeliveryListQuery,
  type ProofOfDeliveryInput,
  type ReasonInput,
  type TrackingLinkDto,
} from '@dispatch/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Access, CurrentDevice, CurrentDispatcher } from '../auth/auth.decorators.js';
import type { DevicePrincipal, DispatcherPrincipal } from '../common/request-context.js';
import { RequestValidationError, ZodPipe, issuesOf } from '../common/zod.pipe.js';
import { ProofService, type UploadedPhoto } from '../proof/proof.service.js';
import { TrackingService } from '../tracking/tracking.service.js';
import { DeliveriesService } from './deliveries.service.js';

const uuid = new ParseUUIDPipe();
const candidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

/** Parses the JSON "proof" field of the multipart proof-of-delivery request. */
class ProofFieldPipe {
  transform(value: unknown): ProofOfDeliveryInput {
    let parsed: unknown;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      throw new RequestValidationError([
        { path: 'proof', message: 'The proof field must be JSON' },
      ]);
    }
    const result = proofOfDeliverySchema.safeParse(parsed);
    if (!result.success) {
      throw new RequestValidationError(
        issuesOf(result.error).map((issue) => ({ ...issue, path: `proof.${issue.path}` })),
      );
    }
    return result.data;
  }
}

@Controller('v1/deliveries')
@Access('dispatcher')
export class DeliveriesController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly tracking: TrackingService,
    private readonly proof: ProofService,
  ) {}

  @Get()
  list(
    @Query(new ZodPipe(deliveryListQuerySchema)) query: DeliveryListQuery,
  ): Promise<DeliveryDto[]> {
    return this.deliveries.list(query);
  }

  @Post()
  create(
    @Body(new ZodPipe(createDeliverySchema)) input: CreateDeliveryInput,
    @CurrentDispatcher() dispatcher: DispatcherPrincipal,
  ): Promise<DeliveryDto> {
    return this.deliveries.create(input, dispatcher);
  }

  @Get(':id')
  get(@Param('id', uuid) id: string): Promise<DeliveryDetailDto> {
    return this.deliveries.detail(id);
  }

  @Get(':id/candidates')
  candidates(
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(candidatesQuerySchema)) query: { limit: number },
  ): Promise<CandidateDto[]> {
    return this.deliveries.candidates(id, query.limit);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(assignDeliverySchema)) input: AssignDeliveryInput,
    @CurrentDispatcher() dispatcher: DispatcherPrincipal,
  ): Promise<DeliveryDto> {
    return this.deliveries.assign(id, input, dispatcher);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(reasonInputSchema)) input: ReasonInput,
    @CurrentDispatcher() dispatcher: DispatcherPrincipal,
  ): Promise<DeliveryDto> {
    return this.deliveries.cancel(id, input.reason, dispatcher);
  }

  @Post(':id/tracking-link')
  async trackingLink(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(trackingLinkInputSchema)) input: { ttlHours?: number },
  ): Promise<TrackingLinkDto> {
    await this.deliveries.get(id);
    return this.tracking.linkFor(id, input.ttlHours);
  }

  @Get(':id/proof/photo')
  async photo(@Param('id', uuid) id: string, @Res() res: Response): Promise<void> {
    const photo = await this.proof.photo(id);
    res.setHeader('content-type', photo.contentType);
    res.setHeader('content-length', String(photo.bytes));
    res.setHeader('cache-control', 'private, max-age=300');
    res.setHeader('x-content-type-options', 'nosniff');
    photo.stream.on('error', () => res.destroy());
    photo.stream.pipe(res);
  }
}

/** The driver's side of a delivery: pickup, completion with proof, or failure. */
@Controller('v1/driver/deliveries')
@Access('device')
export class DriverDeliveriesController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly proof: ProofService,
  ) {}

  @Post(':id/pickup')
  @HttpCode(HttpStatus.OK)
  pickUp(
    @Param('id', uuid) id: string,
    @CurrentDevice() device: DevicePrincipal,
  ): Promise<DeliveryDto> {
    return this.deliveries.pickUp(id, device);
  }

  /** multipart/form-data: `proof` (JSON, see proofOfDeliverySchema) and `photo` (image file). */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  // 25 MB is the transport ceiling; the configured MAX_PHOTO_BYTES is enforced in the service.
  @UseInterceptors(
    FileInterceptor('photo', { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 4 } }),
  )
  complete(
    @Param('id', uuid) id: string,
    @CurrentDevice() device: DevicePrincipal,
    @Body('proof', new ProofFieldPipe()) proof: ProofOfDeliveryInput,
    @UploadedFile() photo: UploadedPhoto | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<DeliveryDto> {
    const key = idempotencyKey && /^[\w-]{8,100}$/.test(idempotencyKey) ? idempotencyKey : null;
    return this.proof.complete(id, device, proof, photo, key);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  fail(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(reasonInputSchema)) input: ReasonInput,
    @CurrentDevice() device: DevicePrincipal,
  ): Promise<DeliveryDto> {
    return this.deliveries.fail(id, input.reason, device);
  }
}
