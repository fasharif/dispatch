import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ErrorCode, InvalidTransitionError, type ApiErrorBody } from '@dispatch/shared';
import type { Response } from 'express';
import pg from 'pg';
import type { AppRequest } from './request-context.js';
import { RequestValidationError } from './zod.pipe.js';

/**
 * One error envelope for every failure: validation, domain rules, database constraints and
 * crashes. Internal details never reach the client; they are logged with the request id.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<AppRequest>();
    const response = http.getResponse<Response>();
    const body = toErrorBody(exception);
    body.requestId = request.requestId;
    if (body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} -> ${String(body.statusCode)} [${request.requestId ?? '-'}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    if (!response.headersSent) response.status(body.statusCode).json(body);
  }
}

export function toErrorBody(exception: unknown): ApiErrorBody {
  if (exception instanceof RequestValidationError) {
    return {
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: exception.message,
      details: exception.issues,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const raw = typeof payload === 'string' ? payload : (payload as { message?: unknown }).message;
    const first: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    const code = typeof payload === 'object' ? (payload as { code?: unknown }).code : undefined;
    const details =
      typeof payload === 'object' ? (payload as { details?: unknown }).details : undefined;
    return {
      statusCode: status,
      error: statusName(status),
      message: typeof first === 'string' ? first : exception.message,
      ...(typeof code === 'string' && { code }),
      ...(Array.isArray(details) && { details: details as ApiErrorBody['details'] }),
    };
  }
  if (exception instanceof InvalidTransitionError) {
    return {
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: exception.message,
      code: ErrorCode.INVALID_TRANSITION,
    };
  }
  if (exception instanceof pg.DatabaseError && exception.code === '23505') {
    return {
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'This conflicts with an existing record',
    };
  }
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    error: 'Internal Server Error',
    message: 'Something went wrong. Please try again later.',
  };
}

function statusName(status: number): string {
  const name = (HttpStatus as unknown as Record<number, string | undefined>)[status];
  return name
    ? name
        .toLowerCase()
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
    : 'Error';
}
