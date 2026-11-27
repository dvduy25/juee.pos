import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, link, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import mongoose from 'mongoose';

const { MongoClient, BSON } = mongoose.mongo;
const signature = Buffer.from('JUEE-BACKUP-1\n');
const nonceBytes = 12;
const tagBytes = 16;
const dataOffset = signature.length + nonceBytes;
const reserved = new Set(['admin', 'config', 'local']);
const restoreLock = '__juee_restore_lock';

class BackupError extends Error {}

function requireSetting(name) {
  const value = process.env[name];
  if (!value) throw new BackupError(`Thiếu cấu hình ${name}.`);
  return value;
}

function databaseName(name) {
  if (!/^[a-z0-9_-]{1,63}$/i.test(name) || reserved.has(name.toLowerCase())) {
    throw new BackupError('Hãy chỉ định tên cơ sở dữ liệu ứng dụng.');
  }
  return name;
}

function encryptionKey() {
  const value = requireSetting('BACKUP_ENCRYPTION_KEY');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new BackupError('BACKUP_ENCRYPTION_KEY phải là khóa 32 byte ở dạng Base64.');
  }
  return key;
}

const encode = row => BSON.EJSON.stringify(row, { relaxed: false }) + '\n';

async function* snapshot(client, database) {
  const db = client.db(database);
  const collections = (await db.listCollections({ type: 'collection' }).toArray()).filter(item => !item.name.startsWith('system.'));
  if (!collections.length) throw new BackupError('Không có bộ sưu tập nào trong cơ sở dữ liệu nguồn.');
  if (collections.some(item => item.name === restoreLock)) throw new BackupError('Cơ sở dữ liệu nguồn chưa khôi phục xong.');
  const session = client.startSession({ snapshot: true });
  try {
    yield encode({ type: 'archive', database });
    for (const { name, options = {} } of collections) {
      const collection = db.collection(name);
      const indexes = (await collection.indexes()).filter(index => index.name !== '_id_')
        .map(({ ns, v, ...index }) => index);
      yield encode({ type: 'collection', name, options, indexes });
      let count = 0;
      for await (const document of collection.find({}, { session, promoteValues: false })) {
        yield encode({ type: 'document', document });
        count++;
      }
      yield encode({ type: 'collection-end', count });
    }
    yield encode({ type: 'archive-end' });
  } finally {
    await session.endSession();
  }
}

async function backup(key) {
  const uri = process.env.BACKUP_MONGODB_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) throw new BackupError('Thiếu kết nối BACKUP_MONGODB_URI hoặc MONGODB_URI.');
  const uriDatabase = URL.canParse(uri) ? decodeURIComponent(new URL(uri).pathname.slice(1)) : '';
  const database = databaseName(process.env.BACKUP_MONGODB_DB || uriDatabase);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  const destination = resolve(process.env.BACKUP_DIR || '.database-backups');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const filename = `juee-${stamp}-${randomBytes(8).toString('hex')}.juee-backup`;
  const partial = join(destination, `.${filename}.partial`);
  try {
    await client.connect();
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(signature);
    await writeFile(partial, Buffer.concat([signature, nonce]), { flag: 'wx', mode: 0o600 });
    await pipeline(Readable.from(snapshot(client, database)), createGzip(), cipher, createWriteStream(partial, { flags: 'a' }));
    await appendFile(partial, cipher.getAuthTag());
    await link(partial, join(destination, filename));
    console.log(`Đã tạo bản sao mã hóa ${filename}`);
  } finally {
    await rm(partial, { force: true });
    await client.close();
  }
}

async function decrypt(archive, target, key) {
  const file = await open(archive, 'r');
  try {
    const { size } = await file.stat();
    if (size <= dataOffset + tagBytes) throw new BackupError('Tệp sao lưu không hợp lệ.');
    const header = Buffer.alloc(dataOffset);
    const tag = Buffer.alloc(tagBytes);
    await file.read(header, 0, dataOffset, 0);
    await file.read(tag, 0, tagBytes, size - tagBytes);
    if (!header.subarray(0, signature.length).equals(signature)) throw new BackupError('Định dạng tệp sao lưu không hợp lệ.');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(signature.length));
    decipher.setAAD(signature);
    decipher.setAuthTag(tag);
    try {
      await pipeline(file.createReadStream({ start: dataOffset, end: size - tagBytes - 1, autoClose: false }),
        decipher, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    } catch {
      throw new BackupError('Không giải mã được tệp. Hãy kiểm tra khóa và tải lại bản sao.');
    }
  } finally {
    await file.close();
  }
}

async function importArchive(file, db) {
  await pipeline(createReadStream(file), createGunzip(), async input => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let started = false;
    let complete = false;
    let collection;
    let indexes;
    let count = 0;
    let batch = [];
    let batchBytes = 0;
    async function flush() {
      if (batch.length) await collection.insertMany(batch);
      batch = [];
      batchBytes = 0;
    }

    for await (const line of lines) {
      const row = BSON.EJSON.parse(line, { relaxed: false });
      if (complete) throw new BackupError('Tệp sao lưu có dữ liệu sau phần kết thúc.');
      if (!started && row.type === 'archive') {
        if (row.database === db.databaseName) throw new BackupError('Hãy khôi phục vào cơ sở dữ liệu riêng có tên khác dữ liệu nguồn.');
        if ((await db.listCollections({}, { nameOnly: true }).toArray()).length) {
          throw new BackupError('Cơ sở dữ liệu đích phải trống.');
        }
        await db.collection(restoreLock).insertOne({ _id: 'restore' });
        started = true;
      } else if (started && !collection && row.type === 'collection') {
        if (row.name === restoreLock || row.name.startsWith('system.')) throw new BackupError('Không thể khôi phục bộ sưu tập hệ thống.');
        // MongoDB command options require JS numbers. Document values retain their BSON types.
        const metadata = BSON.EJSON.parse(line);
        collection = await db.createCollection(metadata.name, metadata.options);
        indexes = metadata.indexes;
        count = 0;
      } else if (collection && row.type === 'document') {
        batch.push(row.document);
        batchBytes += Buffer.byteLength(line);
        count++;
        if (batch.length >= 200 || batchBytes >= 4 * 1024 * 1024) await flush();
      } else if (collection && row.type === 'collection-end' && Number(row.count) === count) {
        await flush();
        if (indexes.length) await collection.createIndexes(indexes);
        collection = undefined;
      } else if (started && !collection && row.type === 'archive-end') {
        complete = true;
      } else {
        throw new BackupError('Nội dung tệp sao lưu không hợp lệ.');
      }
    }
    if (!complete) throw new BackupError('Tệp sao lưu thiếu phần kết thúc.');
  });
  await db.dropCollection(restoreLock);
}

async function restore(archive, key) {
  if (!archive) throw new BackupError('Hãy chọn đường dẫn tệp .juee-backup.');
  const database = databaseName(requireSetting('BACKUP_RESTORE_DB'));
  const client = new MongoClient(requireSetting('BACKUP_RESTORE_URI'), { serverSelectionTimeoutMS: 8000 });
  const staging = await mkdtemp(join(tmpdir(), 'juee-restore-'));
  const payload = join(staging, 'payload.gz');
  try {
    await decrypt(archive, payload, key);
    await client.connect();
    await importArchive(payload, client.db(database));
    console.log(`Đã khôi phục bản sao vào ${database}.`);
  } finally {
    await client.close();
    await rm(staging, { recursive: true, force: true });
  }
}

try {
  const [command, archive] = process.argv.slice(2);
  if (command === 'backup') await backup(encryptionKey());
  else if (command === 'restore') await restore(archive, encryptionKey());
  else throw new BackupError('Dùng lệnh backup hoặc restore.');
} catch (error) {
  console.error(error instanceof BackupError ? error.message : 'Tác vụ cơ sở dữ liệu thất bại. Kiểm tra kết nối, quyền và dung lượng lưu trữ.');
  process.exitCode = 1;
}
