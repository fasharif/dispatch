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
  type DeviceDto,
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

  @Get(':id/devices')
  devices(@Param('id', new ParseUUIDPipe()) id: string): Promise<DeviceDto[]> {
    return this.drivers.devices(id);
  }

  /** Cuts a lost or stolen phone off: its token is refused from the next request on. */
  @Post(':id/devices/:deviceId/revoke')
  @HttpCode(HttpStatus.OK)
  revokeDevice(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
  ): Promise<DeviceDto> {
    return this.drivers.revokeDevice(id, deviceId);
  }

  /** For a driver who has left: revokes every phone and keeps the driver off shift for good. */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(@Param('id', new ParseUUIDPipe()) id: string): Promise<DriverDto> {
    return this.drivers.deactivate(id);
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
