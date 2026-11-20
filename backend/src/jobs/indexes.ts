import mongoose from 'mongoose';
import { connectDatabase, ensureIndexes } from '../config/db';

async function main() {
  await connectDatabase();
  await ensureIndexes();
  console.log('MongoDB indexes are ready.');
}

void main().catch(error => {
  console.error(error instanceof mongoose.mongo.MongoServerError ? `MongoDB index setup failed (code ${error.code})` : error.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
