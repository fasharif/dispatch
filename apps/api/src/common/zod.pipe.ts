import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Thrown for any request that fails a shared Zod contract; the error filter adds the details. */
export class RequestValidationError extends BadRequestException {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues[0] ? `${issues[0].path || 'body'}: ${issues[0].message}` : 'Validation failed');
  }
}

/** Validates and transforms a body, query or parameter with a schema from @dispatch/shared. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new RequestValidationError(issuesOf(result.error));
    return result.data;
  }
}
