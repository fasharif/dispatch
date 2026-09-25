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
   * sign-in and enrolment), up to three times.
   */
  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.once<T>(method, path, body, timeoutMs);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, (error.retryAfterSeconds ?? 5) * 1000));
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
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

  createDelivery(input: CreateDeliveryInput): Promise<DeliveryDto> {
    return this.request('POST', '/v1/deliveries', input);
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
