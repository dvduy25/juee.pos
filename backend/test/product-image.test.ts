import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { optimizeProductImage, readProductImage } from '../src/services/product-image';

test('large product photos are resized and stored as smaller WebP files', async () => {
  const width = 1600;
  const height = 1300;
  const original = await sharp(Buffer.alloc(width * height * 3, 123), { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 }).resize(1300).jpeg({ quality: 100 }).toBuffer();
  const marked = await sharp(original).composite([{ input: Buffer.from(
    '<svg width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'), top: 10, left: 10 }]).png().toBuffer();
  const image = readProductImage({ buffer: marked })!;
  const result = await optimizeProductImage(image);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(result.version, image.version);
  assert.equal(result.contentType, 'image/webp');
  assert.ok(result.bytes.length < image.bytes.length);
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 975);
  assert.equal(await optimizeProductImage(result), result);
});

test('small photos preserve their original bytes', async () => {
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#35a' } }).png().toBuffer();
  const image = readProductImage({ buffer: bytes })!;
  assert.equal(await optimizeProductImage(image), image);
});
