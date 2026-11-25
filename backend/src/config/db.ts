import mongoose, { type ClientSession } from 'mongoose';
import { User, registrationPhoneIndex } from '../models';
import { isDuplicate } from '../utils/db';
import { accountPhone } from '../validators/common';

export async function connectDatabase() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error('Set MONGODB_URI to a MongoDB replica set or Atlas cluster.');
  try {
    await mongoose.connect(uri, { bufferCommands: false, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('A MongoDB replica set is required.');
  } catch (error) {
    await mongoose.disconnect();
    if (error instanceof Error && error.message === 'A MongoDB replica set is required.') throw error;
    throw new Error('Cannot connect to MongoDB. Check MONGODB_URI and replica set availability.');
  }
}

export async function ensureIndexes() {
  for (const item of Object.values(mongoose.models)) {
    const collection = mongoose.connection.db!.collection(item.collection.name);
    const existing = await collection.listIndexes().toArray().catch(error => {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 26) return [];
      throw error;
    });
    for (const [keys, options] of item.schema.indexes()) {
      const equivalent = existing.some(index =>
        JSON.stringify(index.key) === JSON.stringify(keys)
        && Boolean(index.unique) === Boolean(options.unique)
        && Boolean(index.sparse) === Boolean(options.sparse)
        && index.expireAfterSeconds === options.expireAfterSeconds
        && JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression));
      if (!equivalent) {
        const fields = Object.entries(keys).map(([key, direction]) => {
          if (direction !== 1 && direction !== -1) throw new Error(`Unsupported index direction for ${key}.`);
          return [key, direction] as [string, 1 | -1];
        });
        await collection.createIndex(fields, { ...options, unique: Boolean(options.unique) });
      }
    }
    if (item.modelName === 'Membership') {
      // Retire the old unique index only after its replacement exists.
      for (const index of existing) {
        if (index.unique && !index.sparse && !index.partialFilterExpression &&
            JSON.stringify(index.key) === JSON.stringify({ userId: 1, tenantId: 1 })) {
          await collection.dropIndex(index.name).catch(error => {
            if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 27) throw error;
          });
        }
      }
    }
  }
}

export async function ensureRegistrationPhones() {
  await User.collection.createIndex({ registrationPhone: 1 }, registrationPhoneIndex);
  const legacy = User.find({ phone: { $type: 'string' }, registrationPhone: { $exists: false } }).select('phone').lean().cursor();
  for await (const user of legacy) {
    const phone = accountPhone.safeParse(user.phone);
    if (!phone.success) continue;
    try {
      await User.updateOne({ _id: user._id, registrationPhone: { $exists: false } }, { $set: { registrationPhone: phone.data } }, { timestamps: false });
    } catch (cause) {
      // A different legacy account may already reserve this number.
      if (!isDuplicate(cause)) throw cause;
    }
  }
}

export async function verifyProductionIndexes(requiredModels = ['User', 'Session', 'AccountToken', 'PlatformGrant', 'Membership', 'GuestSession', 'Subscription', 'SaaSInvoice',
  'IdempotencyRecord', 'Payment', 'IncomingTransfer', 'AdmissionTicket']) {
  const missing: string[] = [];
  for (const name of requiredModels) {
    const item = mongoose.model(name);
    const existing = await item.collection.listIndexes().toArray().catch(error => {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 26) return [];
      throw error;
    });
    for (const [keys, options] of item.schema.indexes()) {
      if (!options.unique && options.expireAfterSeconds === undefined) continue;
      if (!existing.some(index => JSON.stringify(index.key) === JSON.stringify(keys) &&
          Boolean(index.unique) === Boolean(options.unique) && Boolean(index.sparse) === Boolean(options.sparse) &&
          index.expireAfterSeconds === options.expireAfterSeconds &&
          JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression))) {
        missing.push(`${name}(${Object.keys(keys).join(',')})`);
      }
    }
  }
  if (missing.length) throw new Error(`Missing required indexes. Run db:indexes or db:seed. ${missing.join(' ')}`);
}

export function transaction<T>(work: (session: ClientSession) => Promise<T>) {
  return mongoose.connection.transaction(work);
}

