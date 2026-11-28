import 'reflect-metadata';
import { ArgumentsHost, Catch, Controller, Get, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import type { ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AdminAuthController, AuthController } from './controllers/auth';
import { adminWebOrigin, customerWebOrigins, signingSecret } from './middleware/auth';
import { apiRateLimit, authLimitWindow } from './middleware/rate-limits';
import { TenantsController } from './controllers/tenants';
import { PlatformController } from './controllers/platform';
import { publishedPlans } from './services/plans';
import { syncServicePlans } from './services/service-plan-catalog';
import { connectDatabase, ensureRegistrationPhones, verifyProductionIndexes } from './config/db';
import { jsonTransform } from './utils/db';
import { CatalogController, ProductImagesController } from './controllers/catalog';
import { SalesController } from './controllers/sales';
import { GuestController, RestaurantController } from './controllers/restaurant';
import { PaymentWebhookController } from './controllers/payment-webhook';
import { RealtimeController } from './sockets/realtime';
import { OperationsController } from './controllers/operations';
import { MemberKioskController, MembersController } from './controllers/members';
import { WarehouseController } from './controllers/warehouse';
import { FinanceController } from './controllers/finance';
import { InventoryAiController } from './controllers/inventory-ai';
import { TaxDeclarationsController } from './controllers/tax-declarations';
import { HotelController } from './controllers/hotel';
import { TicketsController } from './controllers/tickets';
import { BookingRequestsController, PublicBookingsController } from './controllers/bookings';
import { BookingRequest } from './models';
import { StaffWorkController } from './controllers/staff-work';
import { StaffDeviceController } from './controllers/staff-devices';
import { PayrollController } from './controllers/payroll';
import { accountMailConfigured } from './services/account-email';
import { googleConfig } from './services/google-auth';
import { subscriptionPaymentConfig } from './services/subscription-payments';

@Catch(mongoose.mongo.MongoServerError, mongoose.Error.ValidationError, mongoose.Error.CastError)
class DatabaseErrors implements ExceptionFilter {
  private readonly logger = new Logger('DatabaseErrors');

  catch(error: Error & { code?: number; keyPattern?: Record<string, number> }, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error.code === 11000 || error.code === 112) {
      const message = error.keyPattern?.barcode ? 'Mã vạch đã được dùng cho biến thể khác trong cửa hàng.' :
        error.keyPattern?.sku ? 'SKU đã được dùng cho biến thể khác trong cửa hàng.' :
        'Dữ liệu bị trùng hoặc vừa thay đổi. Hãy tải lại trước khi thử lại.';
      response.status(409).json({ message });
    } else if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
      response.status(400).json({ message: 'Dữ liệu không hợp lệ.' });
    } else {
      this.logger.error(`MongoDB request failed (${error.code})`);
      response.status(500).json({ message: 'Không thể xử lý dữ liệu.' });
    }
  }
}

@Controller('health')
class HealthController {
  @Get()
  async check() {
    try {
      await mongoose.connection.db!.command({ ping: 1 }, { timeoutMS: 3000 });
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}

@Controller('plans')
class PublicPlansController {
  @Get()
  published() { return publishedPlans(); }
}

@Module({ controllers: [HealthController, AuthController, AdminAuthController, TenantsController, PlatformController, PublicPlansController, CatalogController, ProductImagesController, SalesController, RestaurantController, GuestController, OperationsController, StaffWorkController, StaffDeviceController, PayrollController, WarehouseController, FinanceController, InventoryAiController, TaxDeclarationsController, MembersController, MemberKioskController, HotelController, TicketsController, BookingRequestsController, PublicBookingsController, RealtimeController, PaymentWebhookController] })
class AppModule {}

async function main() {
  signingSecret();
  const origin = process.env.WEB_ORIGIN;
  const web = origin && URL.canParse(origin) ? new URL(origin) : null;
  if (!web || web.origin !== origin || !['http:', 'https:'].includes(web.protocol)) throw new Error('Invalid WEB_ORIGIN');
  if (process.env.NODE_ENV === 'production' && web.protocol !== 'https:') throw new Error('WEB_ORIGIN must use HTTPS in production');
  const customerOrigins = customerWebOrigins();
  const customerHostnames = customerOrigins.map(site => {
    const url = URL.canParse(site) ? new URL(site) : null;
    if (!url || url.origin !== site || !['http:', 'https:'].includes(url.protocol) ||
      (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('Invalid SECONDARY_WEB_ORIGIN');
    return url.hostname;
  });
  const adminOrigin = adminWebOrigin();
  if (adminOrigin) {
    const admin = URL.canParse(adminOrigin) ? new URL(adminOrigin) : null;
    if (!admin || admin.origin !== adminOrigin || !['http:', 'https:'].includes(admin.protocol) || customerOrigins.includes(adminOrigin)) {
      throw new Error('ADMIN_WEB_ORIGIN must be a valid origin separate from customer origins');
    }
    if (process.env.NODE_ENV === 'production' && (admin.protocol !== 'https:' || customerHostnames.includes(admin.hostname))) {
      throw new Error('ADMIN_WEB_ORIGIN must use HTTPS on a separate hostname in production');
    }
  }
  if ((process.env.NODE_ENV === 'production' || process.env.SMTP_URL || process.env.MAIL_FROM) && !accountMailConfigured()) {
    throw new Error('Set SMTP_URL and MAIL_FROM to enable account email');
  }
  const smtp = process.env.SMTP_URL;
  if (smtp && (!URL.canParse(smtp) || !['smtp:', 'smtps:'].includes(new URL(smtp).protocol) || !new URL(smtp).hostname)) {
    throw new Error('Invalid SMTP_URL protocol');
  }
  if (process.env.SEPAY_WEBHOOK_API_KEY && process.env.SEPAY_WEBHOOK_API_KEY.length < 32) throw new Error('SEPAY_WEBHOOK_API_KEY must have at least 32 characters');
  const subscriptionPayments = subscriptionPaymentConfig();
  const publicOrigin = process.env.PUBLIC_ORDER_ORIGIN;
  if (publicOrigin && (!/^https?:\/\//.test(publicOrigin) || !URL.canParse(publicOrigin) || new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error('Invalid PUBLIC_ORDER_ORIGIN');
  }
  if (publicOrigin && process.env.NODE_ENV === 'production' && !publicOrigin.startsWith('https://')) {
    throw new Error('PUBLIC_ORDER_ORIGIN must use HTTPS in production');
  }
  const port = Number(process.env.PORT ?? 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const bindHost = process.env.BIND_HOST ?? '127.0.0.1';
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0) throw new Error('Invalid TRUST_PROXY_HOPS');
  await connectDatabase();
  await ensureRegistrationPhones();
  await BookingRequest.createIndexes();
  if (process.env.NODE_ENV === 'production') await verifyProductionIndexes();
  else if (googleConfig()) await verifyProductionIndexes(['User']);
  if (subscriptionPayments) await verifyProductionIndexes(['SaaSCheckout', 'SaaSInvoice', 'IncomingTransfer']);
  await syncServicePlans();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  if (proxyHops) app.set('trust proxy', proxyHops);
  app.useGlobalFilters(new DatabaseErrors());
  app.setGlobalPrefix('api/v1');
  app.set('json replacer', jsonTransform);
  app.enableCors({ origin: adminOrigin ? [...customerOrigins, adminOrigin] : customerOrigins, credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] });
  app.use(helmet());
  app.use('/api/v1', (_request: unknown, response: Response, next: () => void) => {
    response.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  const authWindow = authLimitWindow(process.env.NODE_ENV, bindHost, web);
  app.use('/api/v1', apiRateLimit({ windowMs: 60_000, limit: 300, message: 'API đang nhận quá nhiều yêu cầu.' }));
  app.use(/^\/api\/v1\/tenants\/[^/]+\/branches\/[^/]+\/orders\/[^/]+\/cancel\/?$/i,
    apiRateLimit({ windowMs: 300_000, limit: 8, postOnly: true, skipSuccessfulRequests: true,
      message: 'Bạn đã thử hủy đơn quá nhiều lần.' }));
  app.use('/api/v1/auth/login', apiRateLimit({ windowMs: authWindow, limit: 20, postOnly: true,
    skipSuccessfulRequests: true, message: 'Bạn đã thử đăng nhập quá nhiều lần.' }));
  app.use('/api/v1/auth/google', apiRateLimit({ windowMs: authWindow, limit: 40,
    message: 'Bạn đã thử đăng nhập Google quá nhiều lần.' }));
  app.use('/api/v1/admin-auth/login', apiRateLimit({ windowMs: authWindow, limit: 12, postOnly: true,
    skipSuccessfulRequests: true, message: 'Bạn đã thử đăng nhập quản trị quá nhiều lần.' }));
  app.use('/api/v1/auth/work-mode', apiRateLimit({ windowMs: authWindow, limit: 10, postOnly: true,
    skipSuccessfulRequests: true, message: 'Bạn đã thử mở chế độ Quản lý quá nhiều lần.' }));
  app.use('/api/v1/auth/branch-access', apiRateLimit({ windowMs: authWindow, limit: 10, postOnly: true,
    skipSuccessfulRequests: true, message: 'Bạn đã thử xác nhận chuyển chi nhánh quá nhiều lần.' }));
  app.use('/api/v1/auth/register', apiRateLimit({ windowMs: authWindow, limit: 10, postOnly: true,
    message: 'Bạn đã gửi quá nhiều yêu cầu đăng ký.' }));
  app.use('/api/v1/auth/verify-email', apiRateLimit({ windowMs: authWindow, limit: 15, postOnly: true,
    message: 'Bạn đã thử xác minh email quá nhiều lần.' }));
  for (const route of ['forgot-password', 'resend-verification', 'reset-password', 'change-password', 'set-initial-password']) {
    app.use(`/api/v1/auth/${route}`, apiRateLimit({ windowMs: authWindow, limit: 10, postOnly: true,
      message: 'Bạn đã gửi quá nhiều yêu cầu xác thực tài khoản.' }));
  }
  app.use('/api/v1/guest/sessions', apiRateLimit({ windowMs: 900_000, limit: 20,
    postOnly: true, message: 'Bạn đã thử mở phiên gọi món quá nhiều lần.' }));
  app.use('/api/v1/guest/orders', apiRateLimit({ windowMs: 60_000, limit: 90, message: 'Bạn đã gửi quá nhiều yêu cầu gọi món.' }));
  app.use('/api/v1/bookings', apiRateLimit({ windowMs: 900_000, limit: 30, postOnly: true,
    message: 'Bạn đã gửi quá nhiều yêu cầu đặt trước.' }));
  if (process.env.NODE_ENV !== 'production') {
    const spec = new DocumentBuilder().setTitle('JUEE POS').setVersion('1.0').addBearerAuth().build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, spec));
  }
  app.enableShutdownHooks();
  app.getHttpServer().once('close', () => void mongoose.disconnect());
  await app.listen(port, bindHost);
}

void main().catch(async error => {
  new Logger('Startup').error(error instanceof Error ? error.message : 'API startup failed');
  await mongoose.disconnect();
  process.exitCode = 1;
});
