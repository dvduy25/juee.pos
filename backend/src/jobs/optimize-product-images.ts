import mongoose from 'mongoose';
import { connectDatabase } from '../config/db';
import { Product } from '../models';
import { optimizeProductImage } from '../services/product-image';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--apply')) throw new Error('Tham số hợp lệ: --apply');
  const apply = args[0] === '--apply';
  await connectDatabase();

  const stats = { scanned: 0, smaller: 0, beforeBytes: 0, savedBytes: 0, saved: 0, changedDuringRun: 0, unreadable: 0 };
  const cursor = Product.find({ 'imageFile.bytes': { $exists: true } }).select('imageFile').cursor({ batchSize: 1 });
  try {
    for await (const product of cursor) {
      const image = product.imageFile;
      if (!image?.bytes) continue;
      stats.scanned++;
      stats.beforeBytes += image.bytes.length;
      const optimized = await optimizeProductImage({ bytes: image.bytes, contentType: image.contentType }).catch(() => null);
      if (!optimized) {
        stats.unreadable++;
        continue;
      }
      if (optimized.bytes.length >= image.bytes.length) continue;
      stats.smaller++;
      const difference = image.bytes.length - optimized.bytes.length;
      if (!apply) {
        stats.savedBytes += difference;
        continue;
      }

      const result = await Product.updateOne({ _id: product._id, 'imageFile.version': image.version },
        { $set: { 'imageFile.bytes': optimized.bytes, 'imageFile.contentType': optimized.contentType } }, { timestamps: false });
      if (result.modifiedCount) {
        stats.saved++;
        stats.savedBytes += difference;
      } else {
        stats.changedDuringRun++;
      }
    }
  } finally {
    await cursor.close();
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...stats }));
}

void main().catch(error => {
  console.error(error instanceof mongoose.mongo.MongoServerError
    ? `MongoDB image operation failed (code ${error.code}).` : 'Không chạy được công cụ tối ưu ảnh MongoDB.');
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
