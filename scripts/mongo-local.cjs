const { spawn } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { mongo: { MongoClient } } = require('mongoose');

const project = resolve(__dirname, '..');
const dataDir = resolve(project, '.mongo-data');
const logPath = resolve(dataDir, 'mongod.log');
const uri = process.env.MONGODB_URI ?? process.env.DATABASE_URL ?? '';
let port;
let replicaSet;

function findMongo() {
  if (process.env.MONGOD_BIN) return process.env.MONGOD_BIN;
  const localBinary = resolve(homedir(), '.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6');
  if (process.platform === 'darwin' && process.arch === 'arm64' && existsSync(localBinary)) return localBinary;
  return 'mongod';
}

async function check(verifyDataDir = false) {
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/admin?directConnection=true`, { serverSelectionTimeoutMS: 700 });
  try {
    await client.connect();
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    if (verifyDataDir) {
      const options = await admin.command({ getCmdLineOpts: 1 });
      const existingDir = options.parsed?.storage?.dbPath;
      if (!existingDir || resolve(existingDir) !== dataDir) throw new Error(`Cổng ${port} đang được một phiên MongoDB khác sử dụng.`);
    }
    if (hello.setName && hello.setName !== replicaSet) throw new Error('Tên replica set không khớp MONGODB_URI.');
    return hello;
  } catch (error) {
    if (error.name !== 'MongoServerSelectionError') throw error;
    if (error.reason?.servers && [...error.reason.servers.values()].some(server => server.error?.cause?.code === 'EPERM')) {
      throw new Error('Môi trường thực thi chặn kết nối local (EPERM). Hãy chạy npm run db:local trong Terminal trên Mac.');
    }
    return null;
  } finally {
    await client.close();
  }
}

async function initiate() {
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/admin?directConnection=true`, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.db('admin').command({ replSetInitiate: { _id: replicaSet, members: [{ _id: 0, host: `localhost:${port}` }] } });
  } catch (error) {
    if (error.codeName !== 'AlreadyInitialized') throw error;
  } finally {
    await client.close();
  }
}

async function main() {
  const url = URL.canParse(uri) ? new URL(uri) : null;
  replicaSet = url?.searchParams.get('replicaSet');
  port = Number(url?.port);
  if (!url || url.protocol !== 'mongodb:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || !replicaSet || !/^[a-zA-Z0-9_-]+$/.test(replicaSet)) {
    throw new Error('MONGODB_URI cần trỏ đến 127.0.0.1, có cổng và tên replica set để khởi động MongoDB cục bộ.');
  }
  let child;
  let ready = false;
  let launchError;
  try {
    let state = await check(true);
    if (!state) {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      child = spawn(findMongo(), ['--dbpath', dataDir, '--logpath', logPath, '--logappend', '--port', String(port),
        '--bind_ip', '127.0.0.1', '--nounixsocket', '--replSet', replicaSet], { detached: true, stdio: 'ignore' });
      child.once('error', error => { launchError = error; });
      for (let attempt = 0; attempt < 20 && !state && !launchError && child.exitCode === null; attempt++) {
        state = await check(true);
        if (!state) await delay(200);
      }
      if (!state) {
        if (launchError?.code === 'ENOENT') throw new Error('Không tìm thấy mongod. Đặt MONGOD_BIN thành đường dẫn tới mongod trên máy.');
        throw new Error(`MongoDB chưa khởi động. Xem log tại ${logPath}.`);
      }
    }
    if (!state.setName) {
      if (!state.isreplicaset) throw new Error('MongoDB đang chạy ở chế độ standalone.');
      await initiate();
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await check();
      if (current?.isWritablePrimary && current.setName === replicaSet) {
        ready = true;
        child?.unref();
        console.log(`MongoDB ${replicaSet} đã sẵn sàng tại 127.0.0.1:${port}.`);
        return;
      }
      await delay(300);
    }
    throw new Error(`Replica set chưa có primary. Xem log tại ${logPath}.`);
  } finally {
    if (child && !ready && !launchError && child.exitCode === null) child.kill();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
