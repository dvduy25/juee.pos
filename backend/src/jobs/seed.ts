import mongoose from 'mongoose';
import { hash, verify } from 'argon2';
import { authenticator } from 'otplib';
import { connectDatabase, ensureIndexes, transaction } from '../config/db';
import { AccountToken, Plan, PlatformGrant, User, UserSession } from '../models';
import { syncServicePlans } from '../services/service-plan-catalog';
import { isDuplicate } from '../utils/db';

async function main() {
  await connectDatabase();
  await ensureIndexes();
  await syncServicePlans();
  console.log('Các gói dịch vụ mặc định đã sẵn sàng.');
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!adminEmail) return;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const totpSecret = process.env.BOOTSTRAP_ADMIN_TOTP;
  const currentPassword = process.env.BOOTSTRAP_ADMIN_CURRENT_PASSWORD;
  if (!password || password.length < 16 || !totpSecret || !/^[A-Z2-7]{32,}$/.test(totpSecret)) {
    throw new Error('Bootstrap requires a 16-character password and a 32-character Base32 TOTP secret');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail) || adminEmail.length > 254 || password.length > 128) {
    throw new Error('Invalid bootstrap email or password length.');
  }
  authenticator.generate(totpSecret);
  const passwordHash = await hash(password);
  await transaction(async session => {
    await Plan.findOneAndUpdate({ code: 'FREE' }, { $currentDate: { updatedAt: true } }, { session, timestamps: false });
    if (await PlatformGrant.exists({}).session(session)) throw new Error('Hệ thống đã có quản trị viên nền tảng.');
    const user = await User.findOne({ email: adminEmail }).session(session);
    if (user && !currentPassword) {
      throw new Error('Email đã đăng ký. Chạy lại npm run admin:setup -- <email> --existing để nâng cấp tài khoản.');
    }
    if (!user && currentPassword) throw new Error('Không tìm thấy tài khoản đã đăng ký với email này.');

    const userId = user ? user._id : (await User.insertOne({ email: adminEmail, name: 'Quản trị JUEE', passwordHash }, { session }))._id;
    if (user) {
      if (!currentPassword || !user.passwordHash || !(await verify(user.passwordHash, currentPassword))) {
        throw new Error('Mật khẩu hiện tại không đúng.');
      }
      if (user.locked) throw new Error('Tài khoản đang bị khóa.');
      if (user.emailVerificationRequired && !user.emailVerifiedAt) throw new Error('Hãy xác minh email trước khi nâng cấp tài khoản.');

      await User.updateOne({ _id: userId }, { $set: { passwordHash } }, { session });
      await UserSession.deleteMany({ userId }, { session });
      await AccountToken.deleteMany({ userId, kind: 'RESET_PASSWORD' }, { session });
    }
    await PlatformGrant.insertOne({ userId, totpSecret, permissions: ['platform.admin', 'platform.read', 'platform.write'] }, { session });
  });
}

void main().catch(error => {
  if (error instanceof mongoose.mongo.MongoServerError) {
    if (isDuplicate(error)) {
      const keys = Object.keys(error.keyPattern ?? {}).filter(field => /^[a-zA-Z0-9_.]+$/.test(field));
      console.error(`MongoDB phát hiện dữ liệu trùng (11000)${keys.length ? ` ở trường ${keys.join(', ')}` : ''}.`);
    } else {
      console.error(`MongoDB seed failed (code ${error.code})`);
    }
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
