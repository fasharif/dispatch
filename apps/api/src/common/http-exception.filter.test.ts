import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { InvalidTransitionError } from '@dispatch/shared';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { toErrorBody } from './http-exception.filter.js';
import { RequestValidationError } from './zod.pipe.js';

describe('toErrorBody', () => {
  it('keeps validation details', () => {
    const body = toErrorBody(
      new RequestValidationError([{ path: 'points.0.lat', message: 'Too big' }]),
    );
    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'points.0.lat: Too big',
      details: [{ path: 'points.0.lat', message: 'Too big' }],
    });
  });

  it('passes on HTTP errors with their machine-readable code', () => {
    expect(toErrorBody(new NotFoundException('Delivery not found'))).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Delivery not found',
    });
    expect(
      toErrorBody(new GoneException({ message: 'Expired', code: 'TRACKING_LINK_EXPIRED' })),
    ).toEqual({
      statusCode: 410,
      error: 'Gone',
      message: 'Expired',
      code: 'TRACKING_LINK_EXPIRED',
    });
    expect(toErrorBody(new ConflictException({ message: 'Busy', code: 'DRIVER_BUSY' })).code).toBe(
      'DRIVER_BUSY',
    );
  });

  it('maps state-machine and unique-constraint errors to 409', () => {
    expect(toErrorBody(new InvalidTransitionError('delivered', 'cancelled'))).toMatchObject({
      statusCode: 409,
      code: 'INVALID_TRANSITION',
    });
    const unique = new pg.DatabaseError(
      'duplicate key value violates unique constraint',
      100,
      'error',
    );
    unique.code = '23505';
    expect(toErrorBody(unique)).toMatchObject({
      statusCode: 409,
      message: 'This conflicts with an existing record',
    });
  });

  it('never leaks internal errors', () => {
    const body = toErrorBody(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'));
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Something went wrong. Please try again later.',
    });
  });
});
