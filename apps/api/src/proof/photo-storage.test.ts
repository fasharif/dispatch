import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/env.js';
import { PhotoStorage, detectImage } from './photo-storage.js';

describe('detectImage', () => {
  it('recognises JPEG, PNG and WebP by their magic bytes', () => {
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.contentType).toBe(
      'image/jpeg',
    );
    expect(
      detectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))?.contentType,
    ).toBe('image/png');
    expect(
      detectImage(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'))?.contentType,
    ).toBe('image/webp');
  });

  it('refuses anything else, whatever the file name says', () => {
    expect(detectImage(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImage(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'latin1'))).toBeNull();
    expect(detectImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('PhotoStorage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-photos-'));
  const storage = new PhotoStorage({ uploads: { dir, maxPhotoBytes: 1_000_000 } } as AppConfig);

  it('saves under a generated name and returns the SHA-256 of the content', async () => {
    const saved = await storage.save(
      '3f1c2b9a-6d4e-4f8a-9b7c-1a2b3c4d5e6f',
      Buffer.from('photo'),
      'jpg',
    );
    expect(saved.path).toMatch(/^3f1c2b9a-6d4e-4f8a-9b7c-1a2b3c4d5e6f\/[0-9a-f-]{36}\.jpg$/);
    expect(saved.sha256).toBe(createHash('sha256').update('photo').digest('hex'));
    expect(readFileSync(join(dir, saved.path), 'utf8')).toBe('photo');
    await storage.remove(saved.path);
  });

  it('never resolves a path outside the uploads directory', () => {
    expect(() => storage.open('../../etc/passwd')).toThrow(/outside uploads/);
  });
});
