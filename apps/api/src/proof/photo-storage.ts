import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';

export interface DetectedImage {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
}

/**
 * Identifies an image by its first bytes rather than by the file name or the client's
 * Content-Type, both of which the client controls.
 */
export function detectImage(data: Buffer): DetectedImage | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

/**
 * Proof-of-delivery photos on a local or mounted volume (shared by every API instance in the
 * compose stack). Paths are generated here, never taken from the client.
 */
@Injectable()
export class PhotoStorage {
  private readonly root: string;

  constructor(@InjectConfig() config: AppConfig) {
    this.root = resolve(config.uploads.dir);
  }

  async save(
    deliveryId: string,
    data: Buffer,
    extension: string,
  ): Promise<{ path: string; sha256: string }> {
    const path = `${deliveryId}/${randomUUID()}.${extension}`;
    const absolute = this.resolveInside(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, data, { flag: 'wx' });
    return { path, sha256: createHash('sha256').update(data).digest('hex') };
  }

  open(path: string): ReadStream {
    return createReadStream(this.resolveInside(path));
  }

  async remove(path: string): Promise<void> {
    await rm(this.resolveInside(path), { force: true });
  }

  private resolveInside(path: string): string {
    const absolute = resolve(this.root, path);
    if (!absolute.startsWith(this.root + sep))
      throw new Error(`Refusing path outside uploads: ${path}`);
    return absolute;
  }
}
