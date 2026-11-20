import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db';
import { HotelBooking, HotelPackage, HotelRoom, AuditLog, Branch, IdempotencyRecord, Membership, Subscription, Tenant, User, UserSession } from '../src/models';
import { hotelNoon } from '../src/services/hotel-stays';
import { facilityToday, shiftDays } from '../src/services/membership-plans';

test('hotel API receives open hourly stays and settles overtime on nightly and package stays', { timeout: 30000 }, async () => {
  const rawUri = process.env.TEST_DATABASE_URL;
  assert.ok(rawUri, 'Set TEST_DATABASE_URL to a MongoDB replica set with a database name ending in _test.');
  const uri = new URL(rawUri);
  assert.match(uri.pathname, /^\/[a-z0-9_-]+_test$/i);
  uri.pathname = uri.pathname.replace(/_test$/i, '_hotel_test');
  const port = process.env.HOTEL_TEST_API_PORT ?? String(Number(process.env.TEST_API_PORT ?? 14000) + 1);
  const origin = 'http://localhost:3000';
  const env = { ...process.env, NODE_ENV: 'test', PORT: port, BIND_HOST: '127.0.0.1', WEB_ORIGIN: origin, PUBLIC_ORDER_ORIGIN: '',
    MONGODB_URI: uri.href, JWT_SECRET: randomBytes(32).toString('hex'), SMTP_URL: '', MAIL_FROM: '', BOOTSTRAP_ADMIN_EMAIL: '' };
  process.env.MONGODB_URI = uri.href;
  const seeded = spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/seed.ts'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(seeded.status, 0, seeded.stderr);
  await connectDatabase();
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env, stdio: 'ignore' });
  const exited = once(server, 'exit');

  const request = (route: string, method = 'GET', body?: unknown, token?: string, extra?: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...extra },
    });
  let userId: string | undefined;
  let tenantId: string | undefined;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 25 && !healthy; attempt++) {
      healthy = (await request('/health').catch(() => undefined))?.ok ?? false;
      if (!healthy) await setTimeout(200);
    }
    assert.ok(healthy);
    const credentials = { email: `hotel-${randomUUID()}@example.com`, password: 'hotel-test-password-1' };
    const created = await request('/auth/register', 'POST', { ...credentials, name: 'Lễ tân kiểm thử' });
    assert.equal(created.status, 201);
    userId = (await created.json()).id;
    const login = await request('/auth/login', 'POST', credentials);
    assert.equal(login.status, 201);
    const { accessToken: owner } = await login.json();
    const tenant = await request('/tenants', 'POST', { name: 'Khách sạn kiểm thử', subscription: 'TRIAL',
      branch: { name: 'Cơ sở kiểm thử', mode: 'HOTEL', location: { latitude: 21, longitude: 105, radiusMeters: 100 } } }, owner);
    assert.equal(tenant.status, 201);
    const site = await tenant.json();
    tenantId = site.id;
    const root = `/tenants/${tenantId}/branches/${site.branches[0].id}`;
    const bookingsUrl = `${root}/hotel-bookings`;
    const roomsUrl = `${root}/hotel-rooms`;
    const packagesUrl = `${root}/hotel-packages`;
    const startsOn = facilityToday();
    const endsOn = shiftDays(startsOn, 1);
    const nextEnd = shiftDays(endsOn, 1);
    const stay = { startsOn, endsOn, guestName: 'Khách qua đêm', guestCount: 1, expectedNightlyRate: 350000 };
    const roomInput = { category: 'Phòng đôi', capacity: 2, nightlyRate: 350000 };
    const hotelBundle = { price: 125000, durationHours: 2 };
    const bookTimed = (body: unknown) => request(bookingsUrl, 'POST', body, owner, { 'Idempotency-Key': randomUUID() });
    const reserve = bookTimed;

    const openRates = { ...roomInput, code: 'P103', hourlyRate: 100000, hourlyNextRate: 50000 };
    const openRoomResponse = await request(roomsUrl, 'POST', openRates, owner);
    assert.equal(openRoomResponse.status, 201);
    const openRoom = await openRoomResponse.json();
    const liveStay = { roomId: openRoom.id, bookingType: 'HOURLY', guestName: 'Khách nhận ngay', guestCount: 1, expectedHourlyRate: 100000,
      expectedHourlyNextRate: 50000 };
    const liveResponse = await bookTimed(liveStay);
    assert.equal(liveResponse.status, 201);
    const live = await liveResponse.json();
    assert.equal(live.status, 'CHECKED_IN');
    assert.ok(live.checkedInAt);
    assert.equal(live.endsAt, null);
    assert.equal((await bookTimed(liveStay)).status, 409);
    await HotelBooking.updateOne({ _id: live.id }, { $set: { checkedInAt: new Date(Date.now() - 130 * 60000) } });
    const liveUrl = `${bookingsUrl}/${live.id}`;
    const liveQuote = await (await request(liveUrl, 'GET', undefined, owner)).json();
    assert.equal(liveQuote.billedHours, 3);
    assert.equal(liveQuote.amount, 200000);
    const settle = (url: string, expectedAmount: number, key = randomUUID()) =>
      request(`${url}/depart`, 'POST', { paymentMethod: 'CASH', expectedAmount }, owner, { 'Idempotency-Key': key });
    assert.equal((await settle(liveUrl, 150000)).status, 409);
    const livePaid = await settle(liveUrl, 200000);
    assert.equal(livePaid.status, 201);
    assert.equal((await livePaid.json()).billedHours, 3);
    assert.equal((await request(`${roomsUrl}/${openRoom.id}/ready`, 'POST', undefined, owner)).status, 201);

    const livePlanResponse = await request(packagesUrl, 'POST', { ...hotelBundle, name: 'Gói có phụ thu' }, owner);
    assert.equal(livePlanResponse.status, 201);
    const livePlan = await livePlanResponse.json();
    const packageResponse = await bookTimed({ bookingType: 'PACKAGE', expectedPackageHours: 2, expectedPackagePrice: 125000, guestName: 'Khách theo gói', guestCount: 1, roomId: openRoom.id, packageId: livePlan.id,
      startsAt: new Date().toISOString(), expectedHourlyNextRate: 50000 });
    assert.equal(packageResponse.status, 201, await packageResponse.clone().text());
    const latePackage = await packageResponse.json();
    const lateUrl = `${bookingsUrl}/${latePackage.id}`;
    assert.equal((await request(`${lateUrl}/arrive`, 'POST', undefined, owner)).status, 201);
    const simulatedEnd = new Date(Date.now() - 70 * 60000);
    await HotelBooking.updateOne({ _id: latePackage.id }, { $set: { endsAt: simulatedEnd, endsOn: facilityToday(+simulatedEnd) } });
    assert.equal((await request(`${roomsUrl}/${openRoom.id}`, 'PATCH', { ...openRates, hourlyNextRate: 80000, state: 'READY' }, owner)).status, 200);
    const lateQuote = await (await request(lateUrl, 'GET', undefined, owner)).json();
    assert.equal(lateQuote.overdue, true);
    assert.equal(lateQuote.overdueHours, 2);
    assert.equal(lateQuote.overdueAmount, 100000);
    assert.equal(lateQuote.amount, 225000);
    const lateRooms = await (await request(roomsUrl, 'GET', undefined, owner)).json();
    assert.equal(lateRooms.find((item: { id: string }) => item.id === openRoom.id)?.occupiedBy?.overdue, true);
    const lateBookings = await (await request(`${bookingsUrl}?status=DEPARTURES`, 'GET', undefined, owner)).json();
    assert.ok(lateBookings.some((item: { id: string }) => item.id === latePackage.id));
    assert.equal((await reserve({ ...stay, roomId: openRoom.id, startsOn: endsOn, endsOn: nextEnd })).status, 409);
    const latePaid = await settle(lateUrl, 225000);
    assert.equal(latePaid.status, 201);
    assert.equal((await latePaid.json()).overdueAmount, 100000);
    assert.equal((await request(`${roomsUrl}/${openRoom.id}/ready`, 'POST', undefined, owner)).status, 201);

    const nightResponse = await reserve({ ...stay, roomId: openRoom.id });
    assert.equal(nightResponse.status, 201);
    const night = await nightResponse.json();
    const nightUrl = `${bookingsUrl}/${night.id}`;
    assert.equal((await request(`${nightUrl}/arrive`, 'POST', undefined, owner)).status, 201);
    const nightQuote = await (await request(nightUrl, 'GET', undefined, owner)).json();
    assert.equal(nightQuote.dueAt, hotelNoon(endsOn).toISOString());
    const pastDay = shiftDays(startsOn, -1);
    await HotelBooking.updateOne({ _id: night.id }, { $set: { startsOn: shiftDays(pastDay, -1), endsOn: pastDay } });
    const lateNight = await (await request(nightUrl, 'GET', undefined, owner)).json();
    assert.equal(lateNight.overdue, true);
    assert.equal(lateNight.overdueAmount, lateNight.overdueHours * 80000);
    assert.equal((await settle(nightUrl, lateNight.amount)).status, 201);
    const storedNight = await (await request(nightUrl, 'GET', undefined, owner)).json();
    assert.equal(storedNight.amount, lateNight.amount);
    assert.equal(storedNight.overdue, false);

    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const futureDay = facilityToday(Date.parse(future));
    const futureCheckout = shiftDays(futureDay, 1);
    const arrivalCases = [
      { bookingType: 'HOURLY', expectedHourlyRate: 100000 },
      { bookingType: 'PACKAGE', packageId: livePlan.id, expectedPackagePrice: 125000, expectedPackageHours: 2 },
      { bookingType: 'NIGHTLY', expectedNightlyRate: 350000 },
    ];
    for (const [index, terms] of arrivalCases.entries()) {
      const settings = { ...openRates, code: `P20${index}` };
      const response = await request(roomsUrl, 'POST', settings, owner);
      assert.equal(response.status, 201);
      const room = await response.json();
      const guest = { roomId: room.id, guestName: `Khách ${terms.bookingType}`, guestCount: 1 };
      const advance = { ...guest, ...terms, arrivalMode: 'ADVANCE', startsAt: future,
        ...(terms.bookingType === 'HOURLY' && { durationHours: 2 }),
        ...(terms.bookingType === 'NIGHTLY' && { endsOn: futureCheckout }) };
      const heldResponse = await reserve(advance);
      assert.equal(heldResponse.status, 201, await heldResponse.clone().text());
      const held = await heldResponse.json();
      assert.equal(held.status, 'RESERVED');
      assert.equal(held.startsAt, future);
      assert.equal((await request(`${bookingsUrl}/${held.id}/arrive`, 'POST', undefined, owner)).status, 409);
      assert.equal((await reserve(advance)).status, 409);
      assert.equal((await request(`${bookingsUrl}/${held.id}/cancel`, 'POST', {}, owner)).status, 201);

      const walkIn = { ...guest, ...terms, arrivalMode: 'NOW', ...(terms.bookingType === 'NIGHTLY' && { nights: 1 }) };
      assert.equal((await reserve({ ...walkIn, startsAt: future })).status, 400);
      assert.equal((await request(`${roomsUrl}/${room.id}`, 'PATCH', { ...settings, state: 'CLEANING' }, owner)).status, 200);
      const availability = terms.bookingType === 'HOURLY' ? 'openHourly=true' :
        `checkInNow=true&${terms.bookingType === 'NIGHTLY' ? 'nights=1' : 'durationHours=2'}`;
      const unavailableRooms = await (await request(`${roomsUrl}?${availability}`, 'GET', undefined, owner)).json();
      assert.equal(unavailableRooms.find((item: { id: string }) => item.id === room.id)?.available, false);
      assert.equal((await reserve(walkIn)).status, 409);
      assert.equal((await request(`${roomsUrl}/${room.id}/ready`, 'POST', undefined, owner)).status, 201);

      const attempts = await Promise.all([reserve(walkIn), reserve(walkIn)]);
      assert.deepEqual(attempts.map(item => item.status).sort(), [201, 409]);
      const checkedIn = await attempts.find(item => item.ok)!.json();
      assert.equal(checkedIn.status, 'CHECKED_IN');
      assert.equal(checkedIn.startsAt, checkedIn.checkedInAt);
      assert.equal(checkedIn.startsOn, facilityToday(Date.parse(checkedIn.checkedInAt)));
      if (terms.bookingType === 'NIGHTLY') assert.equal(checkedIn.endsAt, hotelNoon(shiftDays(checkedIn.startsOn, 1)).toISOString());
      if (terms.bookingType === 'PACKAGE') assert.equal(Date.parse(checkedIn.endsAt) - Date.parse(checkedIn.startsAt), 2 * 60 * 60_000);
      if (terms.bookingType === 'HOURLY') assert.equal(checkedIn.endsAt, null);
    }

  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
    try {
      if (tenantId) {
        const scope = { tenantId: new mongoose.Types.ObjectId(tenantId) };
        await Promise.all([HotelBooking, HotelPackage, HotelRoom, AuditLog, Branch, IdempotencyRecord, Membership, Subscription]
          .map(model => model.collection.deleteMany(scope)));
        await Tenant.deleteOne({ _id: tenantId });
      }
      if (userId) {
        await UserSession.deleteMany({ userId });
        await User.deleteOne({ _id: userId });
      }
    } finally {
      await mongoose.disconnect();
    }
  }
});
