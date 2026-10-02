import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  CreateDriverInput,
  DeviceDto,
  DriverDto,
  DriverHomeDto,
  DriverStatus,
  EnrolDevice,
  EnrolDeviceResult,
  EnrolmentCodeDto,
  ShiftInput,
} from '@dispatch/shared';
import { newDeviceToken, newEnrolmentCode, sha256Hex } from '../auth/tokens.js';
import type { DevicePrincipal } from '../common/request-context.js';
import { Database, maybeOne, one, type Queryable } from '../db/database.js';
import {
  DELIVERY_SELECT,
  DEVICE_SELECT,
  DRIVER_SELECT,
  toDeliveryDto,
  toDeviceDto,
  toDriverDto,
  type DeliveryRow,
  type DeviceRow,
  type DriverRow,
} from '../deliveries/delivery.mapper.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';

const ENROLMENT_CODE_TTL_MINUTES = 30;

@Injectable()
export class DriversService {
  constructor(
    private readonly db: Database,
    private readonly realtime: RealtimePublisher,
  ) {}

  async list(): Promise<DriverDto[]> {
    const found = await this.db.query<DriverRow>(`${DRIVER_SELECT} ORDER BY d.name, d.id`);
    return found.map(toDriverDto);
  }

  async get(id: string, client: Queryable = this.db.pool): Promise<DriverDto> {
    const row = await maybeOne<DriverRow>(client, `${DRIVER_SELECT} WHERE d.id = $1`, [id]);
    if (!row) throw new NotFoundException('Driver not found');
    return toDriverDto(row);
  }

  /** Creates a driver and a one-time code the driver types into the app to enrol a phone. */
  async create(
    input: CreateDriverInput,
  ): Promise<{ driver: DriverDto; enrolment: EnrolmentCodeDto }> {
    return this.db.tx(async (client) => {
      const { id } = await one<{ id: string }>(
        client,
        'INSERT INTO drivers (name, phone, vehicle) VALUES ($1, $2, $3) RETURNING id',
        [input.name, input.phone ?? null, input.vehicle ?? null],
      );
      const enrolment = await this.issueCode(client, id);
      return { driver: await this.get(id, client), enrolment };
    });
  }

  async newEnrolmentCode(driverId: string): Promise<EnrolmentCodeDto> {
    const driver = await this.get(driverId);
    if (driver.deactivatedAt) throw deactivated(driver.name);
    return this.issueCode(this.db.pool, driverId);
  }

  /** The driver's phones, newest first, revoked ones included. */
  async devices(driverId: string): Promise<DeviceDto[]> {
    await this.get(driverId);
    const found = await this.db.query<DeviceRow>(
      `${DEVICE_SELECT} WHERE driver_id = $1 ORDER BY created_at DESC, id`,
      [driverId],
    );
    return found.map(toDeviceDto);
  }

  /**
   * Revokes one phone, for example a lost or stolen one: its token is refused from the next
   * request on. A driver left without a working phone is taken off shift unless they carry a
   * delivery, so automatic assignment does not pick someone who can no longer answer; a delivery in
   * hand stays with them until the dispatcher reassigns or cancels it. Revoking twice is harmless.
   */
  async revokeDevice(driverId: string, deviceId: string): Promise<DeviceDto> {
    const { device, status } = await this.db.tx(async (client) => {
      const driver = await this.lockDriver(client, driverId);
      const revoked = await maybeOne<DeviceRow>(
        client,
        `UPDATE devices SET revoked_at = COALESCE(revoked_at, now())
          WHERE id = $2 AND driver_id = $1
          RETURNING id, name, created_at, last_seen_at, revoked_at`,
        [driverId, deviceId],
      );
      if (!revoked) throw new NotFoundException('This driver has no such device');
      const remaining = await one<{ active: number }>(
        client,
        'SELECT count(*)::int AS active FROM devices WHERE driver_id = $1 AND revoked_at IS NULL',
        [driverId],
      );
      let next: DriverStatus | null = null;
      if (remaining.active === 0 && driver.status === 'available') {
        next = 'offline';
        await client.query(`UPDATE drivers SET status = 'offline' WHERE id = $1`, [driverId]);
      }
      return { device: toDeviceDto(revoked), status: next };
    });
    if (status) this.realtime.driverStatus({ driverId, status });
    return device;
  }

  /**
   * Deactivates a driver who has left: every phone is revoked, unused enrolment codes stop
   * working, and the driver goes off shift for good. Refused while the driver carries a delivery,
   * which the dispatcher must reassign or cancel first (revoking the phone is always possible).
   */
  async deactivate(driverId: string): Promise<DriverDto> {
    const changed = await this.db.tx(async (client) => {
      const driver = await this.lockDriver(client, driverId);
      if (driver.deactivated_at) return false;
      // After the lock, so an assignment that committed while this request waited is seen.
      const active = await maybeOne<{ order_reference: string }>(
        client,
        `SELECT order_reference FROM deliveries
          WHERE driver_id = $1 AND status IN ('assigned', 'picked_up')`,
        [driverId],
      );
      if (active) {
        throw new ConflictException(
          `${driver.name} carries delivery ${active.order_reference}: reassign or cancel it first`,
        );
      }
      await client.query(
        'UPDATE devices SET revoked_at = now() WHERE driver_id = $1 AND revoked_at IS NULL',
        [driverId],
      );
      await client.query(
        'UPDATE enrolment_codes SET used_at = now() WHERE driver_id = $1 AND used_at IS NULL',
        [driverId],
      );
      await client.query(
        `UPDATE drivers SET status = 'offline', deactivated_at = now() WHERE id = $1`,
        [driverId],
      );
      return true;
    });
    if (changed) this.realtime.driverStatus({ driverId, status: 'offline' });
    return this.get(driverId);
  }

  /**
   * Exchanges an enrolment code for a device token. The code works once and expires after
   * 30 minutes; the token is returned once and stored only as a hash. A driver has one working
   * phone: enrolling a new one revokes the ones enrolled before it.
   */
  async enrol(input: EnrolDevice): Promise<EnrolDeviceResult> {
    return this.db.tx(async (client) => {
      const code = await maybeOne<{ driver_id: string }>(
        client,
        `UPDATE enrolment_codes SET used_at = now()
          WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING driver_id`,
        [sha256Hex(input.code)],
      );
      if (!code) {
        throw new UnauthorizedException(
          'This enrolment code is not valid or has expired. Ask your dispatcher for a new one.',
        );
      }
      const driver = await this.lockDriver(client, code.driver_id);
      if (driver.deactivated_at) throw deactivated(driver.name);
      await client.query(
        'UPDATE devices SET revoked_at = now() WHERE driver_id = $1 AND revoked_at IS NULL',
        [code.driver_id],
      );
      const token = newDeviceToken();
      const device = await one<{ id: string }>(
        client,
        'INSERT INTO devices (driver_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id',
        [code.driver_id, input.deviceName, sha256Hex(token)],
      );
      return {
        deviceId: device.id,
        deviceToken: token,
        driver: await this.get(code.driver_id, client),
      };
    });
  }

  async home(device: DevicePrincipal): Promise<DriverHomeDto> {
    const driver = await this.get(device.driverId);
    const active = driver.activeDeliveryId
      ? await this.db.maybeOne<DeliveryRow>(`${DELIVERY_SELECT} WHERE dl.id = $1`, [
          driver.activeDeliveryId,
        ])
      : null;
    return { driver, activeDelivery: active ? toDeliveryDto(active) : null };
  }

  /** Starts or ends a shift. A driver with a delivery in hand cannot go off shift. */
  async setShift(device: DevicePrincipal, input: ShiftInput): Promise<DriverDto> {
    const status = await this.db.tx(async (client) => {
      const locked = await maybeOne<{ id: string }>(
        client,
        'SELECT id FROM drivers WHERE id = $1 FOR UPDATE',
        [device.driverId],
      );
      if (!locked) throw new NotFoundException('Driver not found');
      // A separate statement after the lock: an assignment that held the lock while this request
      // waited has committed by now, and only a new statement's snapshot sees its delivery.
      const current = await one<{ active: boolean }>(
        client,
        `SELECT EXISTS (SELECT 1 FROM deliveries
                         WHERE driver_id = $1 AND status IN ('assigned', 'picked_up')) AS active`,
        [device.driverId],
      );
      if (!input.onShift && current.active) {
        throw new ConflictException(
          'Finish or hand back your current delivery before ending your shift',
        );
      }
      const next: DriverStatus = !input.onShift ? 'offline' : current.active ? 'busy' : 'available';
      await client.query('UPDATE drivers SET status = $2 WHERE id = $1', [device.driverId, next]);
      return next;
    });
    this.realtime.driverStatus({ driverId: device.driverId, status });
    return this.get(device.driverId);
  }

  private async lockDriver(
    client: Queryable,
    driverId: string,
  ): Promise<{ name: string; status: DriverStatus; deactivated_at: Date | null }> {
    const driver = await maybeOne<{
      name: string;
      status: DriverStatus;
      deactivated_at: Date | null;
    }>(client, 'SELECT name, status, deactivated_at FROM drivers WHERE id = $1 FOR UPDATE', [
      driverId,
    ]);
    if (!driver) throw new NotFoundException('Driver not found');
    return driver;
  }

  private async issueCode(client: Queryable, driverId: string): Promise<EnrolmentCodeDto> {
    const code = newEnrolmentCode();
    const expiresAt = new Date(Date.now() + ENROLMENT_CODE_TTL_MINUTES * 60_000);
    await client.query(
      'INSERT INTO enrolment_codes (code_hash, driver_id, expires_at) VALUES ($1, $2, $3)',
      [sha256Hex(code), driverId, expiresAt],
    );
    return { driverId, code, expiresAt: expiresAt.toISOString() };
  }
}

function deactivated(name: string): ConflictException {
  return new ConflictException(`${name} has been deactivated and cannot enrol a phone`);
}
