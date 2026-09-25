import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  createDriverSchema,
  enrolDeviceSchema,
  locationBatchSchema,
  shiftSchema,
  type CreateDriverInput,
  type DriverDto,
  type DriverHomeDto,
  type EnrolDevice,
  type EnrolDeviceResult,
  type EnrolmentCodeDto,
  type LocationBatch,
  type LocationBatchResult,
  type ShiftInput,
} from '@dispatch/shared';
import { Access, CurrentDevice } from '../auth/auth.decorators.js';
import type { DevicePrincipal } from '../common/request-context.js';
import { strictThrottle } from '../common/throttle.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LocationsService } from '../locations/locations.service.js';
import { DriversService } from './drivers.service.js';

/** Driver management for dispatchers. */
@Controller('v1/drivers')
@Access('dispatcher')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  list(): Promise<DriverDto[]> {
    return this.drivers.list();
  }

  @Post()
  create(
    @Body(new ZodPipe(createDriverSchema)) input: CreateDriverInput,
  ): Promise<{ driver: DriverDto; enrolment: EnrolmentCodeDto }> {
    return this.drivers.create(input);
  }

  @Post(':id/enrolment-codes')
  enrolmentCode(@Param('id', new ParseUUIDPipe()) id: string): Promise<EnrolmentCodeDto> {
    return this.drivers.newEnrolmentCode(id);
  }
}

/** A phone exchanges a one-time enrolment code for its device token. */
@Controller('v1/devices')
export class DevicesController {
  constructor(private readonly drivers: DriversService) {}

  @Post('enrol')
  @Access('public')
  @Throttle(strictThrottle)
  enrol(@Body(new ZodPipe(enrolDeviceSchema)) input: EnrolDevice): Promise<EnrolDeviceResult> {
    return this.drivers.enrol(input);
  }
}

/** Endpoints the driver app calls with its device token. */
@Controller('v1/driver')
@Access('device')
export class DriverAppController {
  constructor(
    private readonly drivers: DriversService,
    private readonly locations: LocationsService,
  ) {}

  @Get('me')
  me(@CurrentDevice() device: DevicePrincipal): Promise<DriverHomeDto> {
    return this.drivers.home(device);
  }

  @Post('shift')
  @HttpCode(HttpStatus.OK)
  shift(
    @CurrentDevice() device: DevicePrincipal,
    @Body(new ZodPipe(shiftSchema)) input: ShiftInput,
  ): Promise<DriverDto> {
    return this.drivers.setShift(device, input);
  }

  /** Batches of fixes; replays are answered "duplicate" and never stored twice. */
  @Post('locations')
  @HttpCode(HttpStatus.OK)
  locationBatch(
    @CurrentDevice() device: DevicePrincipal,
    @Body(new ZodPipe(locationBatchSchema)) batch: LocationBatch,
  ): Promise<LocationBatchResult> {
    return this.locations.ingest(device, batch);
  }
}
