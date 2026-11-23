import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const maxImageSize = 4 * 1024 * 1024;
export const productImageLimits = { fileSize: maxImageSize + 1, files: 1, fields: 1 };

export function readProductImage(file: { buffer: Buffer } | undefined) {
  if (!file) return undefined;
  const bytes = file.buffer;
  if (bytes.length > maxImageSize) throw new PayloadTooLargeException('Tệp ảnh vượt quá 4 MB.');
  let contentType: string;
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    contentType = 'image/jpeg';
  } else if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    contentType = 'image/png';
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) {
    contentType = 'image/webp';
  } else {
    throw new BadRequestException('Chọn ảnh JPG, PNG hoặc WebP hợp lệ.');
  }
  return { version: randomBytes(16).toString('hex'), contentType, bytes };
}

export function productImagePath(productId: string, version: string) {
  return `/api/v1/product-images/${productId}/${version}`;
}

const maxProductEdge = 1200;

export async function optimizeProductImage<T extends { bytes: Buffer; contentType: string }>(image: T): Promise<T> {
  try {
    const source = sharp(image.bytes, { limitInputPixels: 32_000_000 });
    const { width, height, pages } = await source.metadata();
    const fits = (width ?? 0) <= maxProductEdge && (height ?? 0) <= maxProductEdge;
    if ((pages ?? 1) > 1 || (fits && (image.contentType === 'image/webp' || image.bytes.length <= 16_384))) return image;
    const bytes = await source.rotate()
      .resize({ width: maxProductEdge, height: maxProductEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer();
    return bytes.length < image.bytes.length ? { ...image, bytes, contentType: 'image/webp' } : image;
  } catch {
    throw new BadRequestException('Không đọc được ảnh sản phẩm hoặc ảnh có độ phân giải quá lớn.');
  }
}
