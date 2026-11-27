import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import mongoose from 'mongoose';

const runFile = promisify(execFile);

test('encrypted database backup restores BSON and indexes into an empty database', { timeout: 25000 }, async () => {
  const uri = process.env.TEST_DATABASE_URL;
  assert.ok(uri, 'Set TEST_DATABASE_URL to an isolated MongoDB replica set.');
  assert.match(new URL(uri).pathname, /^\/[a-z0-9_-]+_test$/i);
  const client = new mongoose.mongo.MongoClient(uri);
  const { ObjectId, Decimal128, Binary } = mongoose.mongo;
  const base = `backup_${randomBytes(5).toString('hex')}`;
  const source = client.db(`${base}_source_test`);
  const destination = client.db(`${base}_destination_test`);
  const rejected = client.db(`${base}_rejected_test`);
  const folder = await mkdtemp(join(tmpdir(), 'juee-backup-test-'));
  const key = randomBytes(32).toString('base64');
  const run = (args: string[], overrides?: Record<string, string>) => runFile(process.execPath,
    ['scripts/database-backup.mjs', ...args], {
      env: { ...process.env, BACKUP_MONGODB_URI: uri, BACKUP_MONGODB_DB: source.databaseName, BACKUP_DIR: folder,
        BACKUP_RESTORE_URI: uri, BACKUP_RESTORE_DB: destination.databaseName, BACKUP_ENCRYPTION_KEY: key, ...overrides },
    });
  try {
    const document = { _id: new ObjectId(), code: 'sample-private-code', amount: Decimal128.fromString('109.25'),
      createdAt: new Date('2026-11-27T00:00:00Z'), image: new Binary(Buffer.from('sample picture')) };
    const goods = source.collection('goods');
    await goods.insertOne(document);
    await goods.createIndex({ code: 1 }, { unique: true });
    await source.createCollection('empty');
    await run(['backup']);
    const [filename] = await readdir(folder);
    assert.match(filename, /\.juee-backup$/);
    const archive = join(folder, filename);
    const bytes = await readFile(archive);
    assert.ok(!bytes.includes(Buffer.from(document.code)));
    const corrupt = join(folder, 'corrupt.juee-backup');
    bytes[bytes.length - 1] ^= 1;
    await writeFile(corrupt, bytes);
    await assert.rejects(run(['restore', corrupt], { BACKUP_RESTORE_DB: rejected.databaseName }), /Không giải mã được/);
    await assert.rejects(run(['restore', archive], { BACKUP_RESTORE_DB: rejected.databaseName,
      BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64') }), /Không giải mã được/);
    assert.deepEqual(await rejected.listCollections().toArray(), []);
    await assert.rejects(run(['restore', archive], { BACKUP_RESTORE_DB: source.databaseName }), /tên khác/);
    await run(['restore', archive]);
    assert.deepEqual(await destination.collection('goods').findOne({ _id: document._id }), document);
    const indexes = await destination.collection('goods').indexes();
    assert.ok(indexes.some(index => index.name === 'code_1' && index.unique));
    assert.deepEqual((await destination.listCollections().toArray()).map(collection => collection.name).sort(), ['empty', 'goods']);
    await assert.rejects(run(['restore', archive]), /đích phải trống/);
  } finally {
    try {
      await Promise.all([source, destination, rejected].map(db => db.dropDatabase()));
    } finally {
      await client.close();
      await rm(folder, { recursive: true, force: true });
    }
  }
});
