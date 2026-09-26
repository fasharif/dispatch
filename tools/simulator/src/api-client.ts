import type {
  CreateDeliveryInput,
  DeliveryDto,
  DriverHomeDto,
  EnrolDeviceResult,
  EnrolmentCodeDto,
  DriverDto,
  LocationBatch,
  LocationBatchResult,
  LoginResult,
  ProofOfDeliveryInput,
} from '@dispatch/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** The subset of the dispatch API the simulator uses, over fetch. */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  withToken(token: string): ApiClient {
    return new ApiClient(this.baseUrl, token);
  }

  /**
   * Sends a request. A 429 answer is retried after the Retry-After delay (the API rate-limits
   * sign-in and enrolment), up to three times. Reads and sign-in, which change nothing, are also
   * retried after a network error or a timeout.
   */
  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const safeToRepeat = method === 'GET' || path === '/v1/auth/login';
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.once<T>(method, path, body, timeoutMs);
      } catch (error) {
        if (attempt >= 4) throw error;
        if (error instanceof ApiError) {
          if (error.status !== 429) throw error;
          await sleep((error.retryAfterSeconds ?? 5) * 1000);
        } else {
          if (!safeToRepeat) throw error;
          await sleep(1000 * attempt);
        }
      }
    }
  }

  private async once<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Name the request: "The operation was aborted due to timeout" alone says nothing.
      throw new Error(`${method} ${path}: ${(error as Error).message}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // Not JSON: keep the raw text.
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        response.status,
        `${method} ${path}: ${String(response.status)} ${message}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  login(email: string, password: string): Promise<LoginResult> {
    return this.request('POST', '/v1/auth/login', { email, password });
  }

  listDrivers(): Promise<DriverDto[]> {
    return this.request('GET', '/v1/drivers');
  }

  newEnrolmentCode(driverId: string): Promise<EnrolmentCodeDto> {
    return this.request('POST', `/v1/drivers/${driverId}/enrolment-codes`, {});
  }

  createDriver(
    name: string,
    vehicle: string,
  ): Promise<{ driver: DriverDto; enrolment: EnrolmentCodeDto }> {
    return this.request('POST', '/v1/drivers', { name, vehicle });
  }

  enrol(code: string, deviceName: string): Promise<EnrolDeviceResult> {
    return this.request('POST', '/v1/devices/enrol', { code, deviceName });
  }

  setShift(onShift: boolean): Promise<DriverDto> {
    return this.request('POST', '/v1/driver/shift', { onShift });
  }

  me(): Promise<DriverHomeDto> {
    return this.request('GET', '/v1/driver/me');
  }

  sendFixes(batch: LocationBatch): Promise<LocationBatchResult> {
    return this.request('POST', '/v1/driver/locations', batch);
  }

  createDelivery(input: CreateDeliveryInput, timeoutMs?: number): Promise<DeliveryDto> {
    return this.request('POST', '/v1/deliveries', input, timeoutMs);
  }

  /** The newest deliveries, up to `limit` (the API's maximum is 200). */
  listDeliveries(limit = 200): Promise<DeliveryDto[]> {
    return this.request('GET', `/v1/deliveries?limit=${String(limit)}`);
  }

  pickUp(deliveryId: string): Promise<DeliveryDto> {
    return this.request('POST', `/v1/driver/deliveries/${deliveryId}/pickup`, {});
  }

  complete(
    deliveryId: string,
    proof: ProofOfDeliveryInput,
    photo: Uint8Array,
  ): Promise<DeliveryDto> {
    const form = new FormData();
    form.set('proof', JSON.stringify(proof));
    form.set('photo', new Blob([photo], { type: 'image/png' }), 'parcel.png');
    return this.request('POST', `/v1/driver/deliveries/${deliveryId}/complete`, form);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
