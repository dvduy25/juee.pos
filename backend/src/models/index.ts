import { model, Schema } from 'mongoose';
import { ticketIssueModes } from '../services/ticket-rules';

const id = { type: Schema.Types.ObjectId, required: true };
const text = { type: String, required: true };
const ids = { type: [Schema.Types.ObjectId], default: [] };
const money = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };

export const roles = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'INVENTORY', 'ACCOUNTANT', 'COACH'] as const;
export type Role = typeof roles[number];
export const loginRoles = ['OWNER', 'MANAGER'] as const;
export const branchModes = ['RETAIL', 'RESTAURANT', 'HYBRID', 'CAFE', 'GYM', 'POOL', 'HOTEL', 'TICKETS'] as const;
export type BranchMode = typeof branchModes[number];
export const tableBranchModes: readonly BranchMode[] = ['RESTAURANT', 'HYBRID', 'CAFE'];
export const memberBranchModes: readonly BranchMode[] = ['GYM', 'POOL'];
export const serviceCounterModes: readonly BranchMode[] = [...memberBranchModes, 'HOTEL', 'TICKETS'];
export const retailBranchModes: readonly BranchMode[] = ['RETAIL', 'HYBRID', ...serviceCounterModes];
export const memberCredentialMethods = ['CARD', 'FINGERPRINT', 'FACE'] as const;
export const memberCheckInMethods = ['MEMBER_CODE', ...memberCredentialMethods] as const;
export const memberKioskMethods = ['CARD', 'MEMBER_CODE'] as const;
export type AccountTokenKind = 'VERIFY_EMAIL' | 'RESET_PASSWORD';

const users = new Schema({
  email: { ...text, unique: true }, name: text, phone: String, registrationPhone: String, passwordHash: String, googleSubject: String,
  emailVerifiedAt: Date, emailVerificationRequired: Boolean, lastLoginAt: Date, trialStartedAt: Date, tenantWriteToken: String,
  managedByTenantId: { type: Schema.Types.ObjectId, select: false },
  locked: { type: Boolean, default: false },
}, { collection: 'User', timestamps: true });
users.index({ googleSubject: 1 }, { unique: true, partialFilterExpression: { googleSubject: { $type: 'string' } } });
export const registrationPhoneIndex = { unique: true, partialFilterExpression: { registrationPhone: { $type: 'string' } } };
users.index({ registrationPhone: 1 }, registrationPhoneIndex);
export const User = model('User', users);

const accountTokens = new Schema({
  userId: id, kind: { ...text, enum: ['VERIFY_EMAIL', 'RESET_PASSWORD'] },
  digest: { ...text, unique: true }, expiresAt: { type: Date, required: true, expires: 0 },
  issuedAt: Date, attempts: { type: Number, default: 0 },
}, { collection: 'AccountToken' });
accountTokens.index({ userId: 1, kind: 1 }, { unique: true });
export const AccountToken = model('AccountToken', accountTokens);

export const PlatformGrant = model('PlatformGrant', new Schema({
  userId: { ...id, unique: true }, permissions: [String], totpSecret: text,
  lastOtpStep: { type: Number, default: 0 },
}, { collection: 'PlatformGrant' }));

export const UserSession = model('Session', new Schema({
  userId: { ...id, index: true }, refreshHash: { ...text, unique: true },
  expiresAt: { type: Date, required: true, expires: 0 }, mfa: { type: Boolean, default: false },
  surface: { type: String, enum: ['customer', 'admin'] },
  googleAuthenticatedAt: Date,
  staffMode: new Schema({ tenantId: id, branchId: id }, { _id: false }), modeVersion: String, workWriteToken: String,
  selectedBranch: new Schema({ tenantId: id, branchId: id }, { _id: false }),
}, { collection: 'Session', timestamps: true }));

export const Tenant = model('Tenant', new Schema({
  name: text, locked: { type: Boolean, default: false }, branchWriteToken: String,
}, { collection: 'Tenant', timestamps: true }));

export const Branch = model('Branch', new Schema({
  name: text, tenantId: { ...id, index: true }, mode: { ...text, enum: branchModes }, writeToken: String,
  location: new Schema({ latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    radiusMeters: { type: Number, required: true, min: 20, max: 2000, validate: Number.isInteger } }, { _id: false }),
  cancellationPinHash: { type: String, select: false }, // Hidden on branch records from older versions.
  memberCheckInKeyHash: { type: String, select: false },
  memberKioskKeyHash: { type: String, select: false },
  memberCheckInMethods: { type: [{ type: String, enum: memberCheckInMethods }], default: undefined },
  tableDiscounts: { type: [new Schema({ code: text, kind: { ...text, enum: ['PERCENT', 'FIXED'] }, value: money,
    enabled: { type: Boolean, default: true } }, { _id: false })], select: false },
  buffetRates: new Schema({ adultPrice: money, childPrice: money }, { _id: false }),
  bankAccount: { type: new Schema({ bank: String, account: String, holder: String }, { _id: false }) },
  retailTaxBps: { type: Number, min: 0, max: 10000, validate: Number.isInteger },
}, { collection: 'Branch', timestamps: true }));

export const warehouseOperations = ['RECEIPT', 'ISSUE', 'COUNT'] as const;
const stockLot = new Schema({ expiresOn: String, quantity: money }, { _id: false });
const warehouseItems = new Schema({ tenantId: id, branchId: id, code: text, name: text, unit: text,
  barcode: String, categoryId: Schema.Types.ObjectId, size: String, color: String, unitCost: { ...money, required: false },
  expiresOn: String, lots: { type: [stockLot], default: undefined }, priorityExpiry: String,
  onHand: { ...money, default: 0 }, minimum: { ...money, default: 0 }, revision: { ...money, default: 0 },
}, { timestamps: true });
warehouseItems.index({ tenantId: 1, branchId: 1, code: 1 }, { unique: true });
warehouseItems.index({ tenantId: 1, branchId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } });
warehouseItems.index({ tenantId: 1, branchId: 1, name: 1, _id: 1 });
export const WarehouseItem = model('WarehouseItem', warehouseItems);

const countBasis = new Schema({ previousCountId: Schema.Types.ObjectId, previousCountAt: Date,
  previousCountQuantity: { ...money, required: false }, soldQuantity: money }, { _id: false });
const warehouseMovements = new Schema({ tenantId: id, branchId: id, itemId: id, itemCode: text, itemName: text, unit: text,
  operation: { ...text, enum: warehouseOperations }, quantity: money, before: money, after: money, actorId: Schema.Types.ObjectId, note: text,
  referenceId: Schema.Types.ObjectId, expiresOn: String, countBasis, itemRevision: { ...money, required: false }, unitCost: { ...money, required: false },
  correctedQuantity: { ...money, required: false }, correctedAt: Date,
  lotAllocation: { type: [stockLot], default: undefined }, lotsAfter: { type: [stockLot], default: undefined },
  correctedLots: { type: [stockLot], default: undefined },
}, { timestamps: true });
warehouseMovements.index({ tenantId: 1, branchId: 1, createdAt: -1, _id: -1 });
warehouseMovements.index({ tenantId: 1, branchId: 1, itemId: 1, createdAt: -1, _id: -1 });
export const WarehouseMovement = model('WarehouseMovement', warehouseMovements);

const purchaseLines = new Schema({ itemId: id, name: text, code: text, unit: text, quantity: money, unitCost: money,
  subtotal: money, taxBps: money, taxAmount: money, expiresOn: String }, { _id: false });
const purchases = new Schema({ tenantId: id, branchId: id, actorId: id, supplier: text, reference: String,
  lines: { type: [purchaseLines], required: true }, subtotal: money, taxAmount: money, totalAmount: money,
  method: { ...text, enum: ['CASH', 'TRANSFER'] } }, { timestamps: true });
purchases.index({ tenantId: 1, branchId: 1, createdAt: -1, _id: -1 });
export const PurchaseReceipt = model('PurchaseReceipt', purchases);

const promotions = new Schema({ tenantId: id, branchId: id, code: text, name: text,
  kind: { ...text, enum: ['PERCENT', 'FIXED'] }, value: money, minimum: money,
  productIds: { type: [Schema.Types.ObjectId], default: undefined },
  startsAt: { type: Date, required: true }, endsAt: { type: Date, required: true },
  enabled: { type: Boolean, default: true } }, { timestamps: true });
promotions.index({ tenantId: 1, branchId: 1, code: 1 }, { unique: true });
export const RetailPromotion = model('RetailPromotion', promotions);

export const expenseKinds = ['STAFF', 'RENT', 'UTILITIES', 'OTHER'] as const;
const cashEntries = new Schema({ tenantId: id, branchId: id, actorId: id, note: text, category: text,
  expenseKind: { type: String, enum: expenseKinds }, occurredAt: Date,
  direction: { ...text, enum: ['IN', 'OUT'] }, method: { ...text, enum: ['CASH', 'TRANSFER'] }, amount: money },
{ timestamps: true });
cashEntries.index({ tenantId: 1, branchId: 1, createdAt: -1 });
cashEntries.index({ tenantId: 1, branchId: 1, occurredAt: -1 });
export const CashEntry = model('CashEntry', cashEntries);

export const recordedPaymentMethods = ['CASH', 'TRANSFER'] as const;
export const memberPlanKinds = ['MONTH', 'DAY', 'VISITS'] as const;
const memberPlans = new Schema({ tenantId: id, branchId: id, name: text, kind: { ...text, enum: memberPlanKinds },
  units: { type: Number, required: true, min: 1, validate: Number.isInteger }, price: { ...money, default: 0 },
  validityMonths: { type: Number, min: 1, max: 120, validate: (value: number | null) => value === null || Number.isInteger(value) },
  active: { type: Boolean, default: true },
}, { timestamps: true });
memberPlans.index({ tenantId: 1, branchId: 1, name: 1 }, { unique: true });
export const MemberPlan = model('MemberPlan', memberPlans);

const facilityMembers = new Schema({
  tenantId: id, branchId: id, name: text, phone: text, code: String, plan: String, expiresOn: String,
  photo: new Schema({ version: text, contentType: text,
    bytes: { type: Buffer, required: true, select: false } }, { _id: false }),
  enrollment: new Schema({ planId: id, planName: text, kind: { ...text, enum: memberPlanKinds }, startsOn: text,
    chargeId: Schema.Types.ObjectId, paymentId: Schema.Types.ObjectId,
    price: { ...money, required: false }, expiresOn: String, remaining: { type: Number, min: 0, validate: Number.isSafeInteger } }, { _id: false }),
  freeze: new Schema({ startsOn: text, resumesOn: text, reason: text }, { _id: false }),
  active: { type: Boolean, default: true },
}, { timestamps: true });
facilityMembers.index({ tenantId: 1, branchId: 1, phone: 1 }, { unique: true });
facilityMembers.index({ tenantId: 1, branchId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
export const FacilityMember = model('FacilityMember', facilityMembers);

const memberPayments = new Schema({
  tenantId: id, branchId: id, memberId: id, memberName: text, planId: id, planName: text, actorId: id,
  amount: { ...money, min: 1 }, method: { ...text, enum: recordedPaymentMethods }, paidAt: { type: Date, required: true },
}, { timestamps: true });
memberPayments.index({ tenantId: 1, branchId: 1, paidAt: -1, _id: -1 });
memberPayments.index({ tenantId: 1, branchId: 1, memberId: 1, paidAt: -1, _id: -1 });
export const MemberPayment = model('MemberPayment', memberPayments);

const memberCredentials = new Schema({ tenantId: id, branchId: id, memberId: id, code: text,
  method: { ...text, enum: memberCredentialMethods } }, { timestamps: true });
memberCredentials.index({ tenantId: 1, branchId: 1, method: 1, code: 1 }, { unique: true });
memberCredentials.index({ tenantId: 1, branchId: 1, memberId: 1, method: 1 }, { unique: true });
export const MemberCredential = model('MemberCredential', memberCredentials);

const memberVisits = new Schema({ tenantId: id, branchId: id, memberId: id, memberName: text, actorId: Schema.Types.ObjectId,
  method: { type: String, enum: memberCheckInMethods, default: 'MEMBER_CODE' },
  source: { type: String, enum: ['STAFF', 'KIOSK', 'DEVICE'] },
  planName: String, remaining: Number,
  progress: new Schema({ registeredOn: String, firstVisitedOn: text, attendedDays: { ...money, min: 1 },
    expiresOn: String, remainingDays: { ...money, required: false } }, { _id: false }),
}, { timestamps: true });
memberVisits.index({ tenantId: 1, branchId: 1, createdAt: -1 });
memberVisits.index({ tenantId: 1, branchId: 1, memberId: 1, createdAt: -1 });
export const MemberVisit = model('MemberVisit', memberVisits);

const memberClassSeats = new Schema({ memberId: id, memberName: text, status: { ...text, enum: ['BOOKED', 'WAITING'] },
  createdAt: { type: Date, required: true }, attendedAt: Date });
const memberClasses = new Schema({ tenantId: id, branchId: id, name: text, instructor: String,
  instructorId: Schema.Types.ObjectId,
  startsAt: { type: Date, required: true }, endsAt: { type: Date, required: true },
  capacity: { ...money, min: 1, max: 100 }, seats: [memberClassSeats], canceledAt: Date,
}, { timestamps: true });
memberClasses.index({ tenantId: 1, branchId: 1, startsAt: 1, _id: 1 });
memberClasses.index({ tenantId: 1, branchId: 1, 'seats.memberId': 1, startsAt: 1 });
memberClasses.index({ tenantId: 1, instructorId: 1, startsAt: 1 });
export const MemberClass = model('MemberClass', memberClasses);

export const hotelRoomStates = ['READY', 'CLEANING', 'MAINTENANCE'] as const;
export const hotelBookingStates = ['RESERVED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELED', 'NO_SHOW'] as const;
export const hotelBookingTypes = ['NIGHTLY', 'HOURLY', 'PACKAGE'] as const;
const hotelRooms = new Schema({ tenantId: id, branchId: id, code: text, category: text,
  capacity: { ...money, min: 1, max: 100 }, nightlyRate: { ...money, required: false },
  hourlyRate: { ...money, required: false }, hourlyNextRate: { ...money, required: false },
  state: { ...text, enum: hotelRoomStates, default: 'READY' },
  calendarRevision: { type: Number, default: 0, select: false },
}, { timestamps: true });
hotelRooms.index({ tenantId: 1, branchId: 1, code: 1 }, { unique: true });
export const HotelRoom = model('HotelRoom', hotelRooms);

const hotelPackages = new Schema({ tenantId: id, branchId: id, name: text, price: money,
  durationHours: { ...money, min: 1, max: 8760 }, active: { type: Boolean, required: true, default: true },
}, { timestamps: true });
hotelPackages.index({ tenantId: 1, branchId: 1, name: 1 }, { unique: true });
export const HotelPackage = model('HotelPackage', hotelPackages);

const hotelBookings = new Schema({ tenantId: id, branchId: id, roomId: id, roomCode: text, guestName: text,
  phone: String, guestCount: { ...money, min: 1, max: 100 }, startsOn: text, endsOn: text,
  nightlyRate: money, amount: money, note: String, status: { ...text, enum: hotelBookingStates },
  bookingType: { type: String, enum: hotelBookingTypes }, startsAt: Date, endsAt: Date, durationHours: Number,
  hourlyRate: { ...money, required: false }, packagePrice: { ...money, required: false }, packageName: String, packageId: Schema.Types.ObjectId,
  charges: [new Schema({ name: text, quantity: { ...money, min: 1, max: 1000 }, unitPrice: money, createdAt: Date, actorId: id })],
  hourlyNextRate: { ...money, required: false }, billedHours: Number, overdueHours: Number, overdueAmount: Number,
  closedReason: String,
  checkedInAt: Date, checkedOutAt: Date, paidAt: Date, paymentMethod: { type: String, enum: recordedPaymentMethods }, paidBy: Schema.Types.ObjectId,
}, { timestamps: true });
hotelBookings.index({ tenantId: 1, branchId: 1, roomId: 1, status: 1, startsOn: 1, endsOn: 1 });
hotelBookings.index({ tenantId: 1, branchId: 1, roomId: 1, status: 1, startsAt: 1, endsAt: 1 });
hotelBookings.index({ tenantId: 1, branchId: 1, status: 1, updatedAt: -1, _id: -1 });
hotelBookings.index({ tenantId: 1, branchId: 1, paidAt: -1 });
export const HotelBooking = model('HotelBooking', hotelBookings);

const ticketTypes = new Schema({ tenantId: id, branchId: id, name: text, price: money,
  active: { type: Boolean, default: true },
  salesRevision: { type: Number, select: false },
  capacity: { ...money, required: false, min: 1, max: 1000000,
    validate: (value: number | null) => value === null || Number.isSafeInteger(value) },
  saleStartsAt: Date, saleEndsAt: Date, admissionStartsAt: Date, admissionEndsAt: Date,
  earlyPrice: { ...money, required: false, validate: (value: number | null) => value === null || Number.isSafeInteger(value) }, earlyUntil: Date,
}, { timestamps: true });
ticketTypes.index({ tenantId: 1, branchId: 1, name: 1 }, { unique: true });
export const TicketType = model('TicketType', ticketTypes);

const ticketSales = new Schema({ tenantId: id, branchId: id, typeId: id, typeName: text, unitPrice: money,
  quantity: { ...money, min: 1, max: 50 }, amount: money, actorId: id,
  ticketMode: { type: String, enum: ticketIssueModes },
  admissionRevision: { type: Number, select: false },
  buyerName: String, buyerPhone: String,
  paymentMethod: { ...text, enum: recordedPaymentMethods }, paidAt: { type: Date, required: true },
  refundedAt: Date,
}, { timestamps: true });
ticketSales.index({ tenantId: 1, branchId: 1, paidAt: -1, _id: -1 });
ticketSales.index({ tenantId: 1, branchId: 1, typeId: 1 });
export const TicketSale = model('TicketSale', ticketSales);

const ticketRefunds = new Schema({ tenantId: id, branchId: id, saleId: id, actorId: id, typeName: text,
  quantity: { ...money, min: 1, max: 50 }, amount: money, reason: text,
  method: { ...text, enum: recordedPaymentMethods },
}, { timestamps: true });
ticketRefunds.index({ tenantId: 1, branchId: 1, saleId: 1 }, { unique: true });
ticketRefunds.index({ tenantId: 1, branchId: 1, createdAt: -1 });
export const TicketRefund = model('TicketRefund', ticketRefunds);

const admissionTickets = new Schema({ tenantId: id, branchId: id, saleId: id, code: text, typeName: text,
  entryQuantity: { ...money, min: 1, max: 50, default: 1 },
  usedAt: Date, usedBy: Schema.Types.ObjectId, admissionStartsAt: Date, admissionEndsAt: Date,
}, { timestamps: true });
admissionTickets.index({ tenantId: 1, branchId: 1, code: 1 }, { unique: true });
admissionTickets.index({ tenantId: 1, branchId: 1, saleId: 1 });
admissionTickets.index({ tenantId: 1, branchId: 1, usedAt: -1, _id: -1 });
export const AdmissionTicket = model('AdmissionTicket', admissionTickets);

const memberships = new Schema({
  userId: Schema.Types.ObjectId, tenantId: { ...id, index: true }, role: { type: String, enum: roles, required: true },
  branchIds: ids, disabled: { type: Boolean, default: false },
  staffName: String, phone: String, position: String, specialty: String, certifications: String, archivedAt: Date,
  staffAvatarVersion: String,
}, { collection: 'Membership', timestamps: true });
memberships.index({ userId: 1, tenantId: 1 }, {
  name: 'membership_account_tenant', unique: true, partialFilterExpression: { userId: { $type: 'objectId' } },
});
export const Membership = model('Membership', memberships);

const staffIdentity = new Schema({
  tenantId: id, membershipId: id, citizenId: String,
  avatar: new Schema({ version: text, contentType: text, bytes: { type: Buffer, required: true, select: false } }, { _id: false }),
}, { timestamps: true });
staffIdentity.index({ tenantId: 1, membershipId: 1 }, { unique: true });
export const StaffIdentity = model('StaffIdentity', staffIdentity);

const staffDocuments = new Schema({
  tenantId: id, membershipId: id, name: text, digest: text, contentType: text, bytes: { type: Buffer, required: true, select: false },
}, { timestamps: true });
staffDocuments.index({ tenantId: 1, membershipId: 1, digest: 1 }, { unique: true });
export const StaffDocument = model('StaffDocument', staffDocuments);

export const staffShiftKinds = ['FIXED', 'FLEXIBLE'] as const;
export const staffDeviceMethods = ['FINGERPRINT', 'CARD', 'FACE'] as const;
const staffAttendanceMethods = ['MANUAL', ...staffDeviceMethods] as const;
const staffSchedules = new Schema({ tenantId: id, branchId: id, membershipId: id, staffName: text,
  title: text, note: String, startsAt: { type: Date, required: true }, endsAt: { type: Date, required: true },
  canceledAt: Date, leaveAt: Date, leaveReason: String,
  kind: { type: String, enum: staffShiftKinds }, targetMinutes: Number, seriesId: Schema.Types.ObjectId,
}, { timestamps: true });
staffSchedules.index({ tenantId: 1, branchId: 1, startsAt: 1, _id: 1 });
staffSchedules.index({ tenantId: 1, membershipId: 1, startsAt: 1 });
staffSchedules.index({ tenantId: 1, branchId: 1, seriesId: 1, startsAt: 1 });
export const StaffSchedule = model('StaffSchedule', staffSchedules);

const staffAttendances = new Schema({ tenantId: id, branchId: id, membershipId: id, staffName: text,
  scheduleId: Schema.Types.ObjectId, scheduleTitle: String, scheduledStartsAt: Date, scheduledEndsAt: Date,
  scheduledKind: { type: String, enum: staffShiftKinds }, scheduledTargetMinutes: Number,
  checkInMethod: { type: String, enum: staffAttendanceMethods }, checkOutMethod: { type: String, enum: staffAttendanceMethods },
  checkInDeviceId: Schema.Types.ObjectId, checkOutDeviceId: Schema.Types.ObjectId,
  checkedInAt: { type: Date, required: true }, checkedOutAt: Date, closedBy: Schema.Types.ObjectId, closeReason: String,
  payrollPaymentId: Schema.Types.ObjectId,
  status: { ...text, enum: ['OPEN', 'CLOSED'] },
}, { timestamps: true });
staffAttendances.index({ tenantId: 1, membershipId: 1 }, { unique: true, partialFilterExpression: { status: 'OPEN' } });
staffAttendances.index({ tenantId: 1, branchId: 1, checkedInAt: -1, _id: -1 });
staffAttendances.index({ tenantId: 1, branchId: 1, scheduledStartsAt: 1, membershipId: 1 });
staffAttendances.index({ tenantId: 1, membershipId: 1, checkedInAt: -1 });
staffAttendances.index({ tenantId: 1, branchId: 1, scheduleId: 1 });
export const StaffAttendance = model('StaffAttendance', staffAttendances);

const staffDevices = new Schema({ tenantId: id, branchId: id, name: text, keyHash: { ...text, select: false },
  methods: [{ type: String, enum: staffDeviceMethods }], revokedAt: Date,
}, { timestamps: true });
staffDevices.index({ tenantId: 1, branchId: 1, keyHash: 1 }, { unique: true });
export const StaffClockDevice = model('StaffClockDevice', staffDevices);

const staffCredentials = new Schema({ tenantId: id, branchId: id, membershipId: id,
  method: { ...text, enum: staffDeviceMethods }, code: text,
}, { timestamps: true });
staffCredentials.index({ tenantId: 1, branchId: 1, method: 1, code: 1 }, { unique: true });
staffCredentials.index({ tenantId: 1, branchId: 1, membershipId: 1, method: 1 }, { unique: true });
export const StaffClockCredential = model('StaffClockCredential', staffCredentials);

export const staffPayUnits = ['HOUR', 'SHIFT'] as const;
const staffPayTerms = {
  unit: { ...text, enum: staffPayUnits }, rate: money, overtimeRate: money,
  shiftMinutes: { type: Number, min: 1, max: 1440, validate: Number.isInteger },
};
const staffRates = new Schema({ tenantId: id, branchId: id, membershipId: id, effectiveOn: text, ...staffPayTerms }, { timestamps: true });
staffRates.index({ tenantId: 1, branchId: 1, membershipId: 1, effectiveOn: 1 }, { unique: true });
export const StaffPayRate = model('StaffPayRate', staffRates);

const payrollLines = new Schema({ day: text, label: text, attendanceIds: ids, ...staffPayTerms, regularMinutes: money,
  overtimeMinutes: money, baseAmount: money, overtimeAmount: money }, { _id: false });
const staffPayments = new Schema({ tenantId: id, branchId: id, membershipId: id, staffName: text, actorId: id, cashEntryId: id,
  from: text, to: text, paidAt: { type: Date, required: true }, method: { ...text, enum: recordedPaymentMethods },
  amount: money, lines: [payrollLines] }, { timestamps: true });
staffPayments.index({ tenantId: 1, branchId: 1, membershipId: 1, paidAt: -1, _id: -1 });
staffPayments.index({ cashEntryId: 1 });
export const StaffPayPayment = model('StaffPayPayment', staffPayments);

export const Plan = model('Plan', new Schema({
  code: { ...text, unique: true }, name: text, description: { type: String, default: '' },
  published: { type: Boolean, default: true }, catalogRevision: Number,
}, { collection: 'Plan', timestamps: true }));

const versions = new Schema({
  planId: id, version: { type: Number, required: true },
  monthlyVnd: { type: Schema.Types.BigInt, required: true },
  yearlyVnd: Schema.Types.BigInt, maxBranches: Number, maxStaff: Number, maxQrTables: Number, features: [String],
}, { collection: 'PlanVersion', timestamps: true });
versions.index({ planId: 1, version: 1 }, { unique: true });
export const PlanVersion = model('PlanVersion', versions);

const subscriptions = new Schema({
  tenantId: { ...id, unique: true }, planVersionId: id, status: { ...text, enum: ['ACTIVE', 'PENDING', 'SUSPENDED', 'CANCELED'], default: 'ACTIVE' },
  startsAt: { type: Date, required: true, default: Date.now }, expiresAt: Date, branchWriteToken: String,
  trial: Boolean, simulated: Boolean, requestedPlanVersionId: Schema.Types.ObjectId,
  requestedAt: Date, requestId: String,
  rejectedRequest: new Schema({ reason: text, rejectedAt: { type: Date, required: true } }, { _id: false }),
}, { collection: 'Subscription', timestamps: true });
subscriptions.index({ status: 1, expiresAt: 1 });
subscriptions.index({ requestedAt: 1, createdAt: 1, _id: 1 }, { partialFilterExpression: { requestedPlanVersionId: { $type: 'objectId' } } });
export const Subscription = model('Subscription', subscriptions);

export const SaaSInvoice = model('SaaSInvoice', new Schema({
  subscriptionId: id, reference: { ...text, unique: true },
  amountVnd: { type: Schema.Types.BigInt, required: true }, paidAt: { type: Date, index: true },
  paymentCode: String,
}, { collection: 'SaaSInvoice', timestamps: true }));

export const SaaSCheckout = model('SaaSCheckout', new Schema({
  tenantId: id, subscriptionId: id, planVersionId: id,
  requestId: { ...text, unique: true }, reference: { ...text, unique: true }, amount: money,
  bank: text, account: text, holder: text, gateway: text,
  issuedAt: { type: Date, required: true }, expiresAt: { type: Date, required: true },
}));

const platformAudit = new Schema({
  actorId: id, targetId: id, action: text, reason: text, before: Schema.Types.Mixed, after: Schema.Types.Mixed,
}, { collection: 'AdminAuditLog', timestamps: true });
platformAudit.index({ targetId: 1, createdAt: -1 });
platformAudit.index({ createdAt: -1 });
export const AdminAuditLog = model('AdminAuditLog', platformAudit);

const notifications = new Schema({
  actorId: id, title: text, body: text, kind: text, tenantIds: ids, publishedAt: { type: Date, default: Date.now },
}, { collection: 'SystemNotification', timestamps: true });
notifications.index({ tenantIds: 1, publishedAt: -1 });
export const SystemNotification = model('SystemNotification', notifications);

const category = new Schema({ tenantId: id, name: text, slug: text }, { timestamps: true });
category.index({ tenantId: 1, slug: 1 }, { unique: true });
export const Category = model('Category', category);

const productImage = new Schema({
  version: text, contentType: text, bytes: { type: Buffer, required: true },
}, { _id: false });

const product = new Schema({
  tenantId: id, name: text, description: String, images: [String], categoryId: Schema.Types.ObjectId,
  warehouseItemId: Schema.Types.ObjectId, retailBranchId: Schema.Types.ObjectId,
  retailSizeRevision: { type: Number, select: false },
  imageFile: { type: productImage, select: false },
  status: { ...text, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  productType: { ...text, enum: ['RETAIL', 'FOOD', 'BOTH'], default: 'BOTH' },
  buffetExtra: Boolean, recipeRequired: Boolean,
  modifierGroups: [{ name: text, minSelect: Number, maxSelect: Number, options: [{ name: text, additionalPrice: money }] }],
}, { timestamps: true });
product.index({ tenantId: 1, status: 1, categoryId: 1, name: 1 });
product.index({ warehouseItemId: 1 }, { unique: true, partialFilterExpression: { warehouseItemId: { $type: 'objectId' } } });
export const Product = model('Product', product);

const ingredient = new Schema({ itemId: id, quantity: { ...money, min: 1 } }, { _id: false });
const dishRecipe = new Schema({ tenantId: id, branchId: id, productId: id, ingredients: [ingredient] }, { timestamps: true });
dishRecipe.index({ tenantId: 1, branchId: 1, productId: 1 }, { unique: true });
dishRecipe.index({ tenantId: 1, branchId: 1, 'ingredients.itemId': 1 });
export const DishRecipe = model('DishRecipe', dishRecipe);

const variant = new Schema({
  tenantId: id, productId: id, sku: text, barcode: String, attributes: { type: Map, of: String },
  basePrice: money, costPrice: money,
}, { timestamps: true });
variant.index({ tenantId: 1, sku: 1 }, { unique: true });
variant.index({ tenantId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } });
variant.index({ tenantId: 1, productId: 1 });
export const ProductVariant = model('ProductVariant', variant);

const branchKey = { tenantId: id, branchId: id };
const branchPrices = new Schema({ ...branchKey, variantId: id, price: { ...money, required: false }, paused: Boolean }, { timestamps: true });
branchPrices.index({ tenantId: 1, branchId: 1, variantId: 1 }, { unique: true });
export const BranchProductPrice = model('BranchProductPrice', branchPrices);

const unavailableProducts = new Schema({ ...branchKey, productId: id }, { timestamps: true });
unavailableProducts.index({ tenantId: 1, branchId: 1, productId: 1 }, { unique: true });
export const UnavailableProduct = model('UnavailableProduct', unavailableProducts);

const buffetPackages = new Schema({ ...branchKey, name: text, adultPrice: money, childPrice: money, productIds: ids,
  enabled: { type: Boolean, default: true } }, { timestamps: true });
buffetPackages.index({ tenantId: 1, branchId: 1, name: 1 }, { unique: true });
export const BuffetPackage = model('BuffetPackage', buffetPackages);

const orderStockLot = new Schema({ itemId: id, expiresOn: String, quantity: money }, { _id: false });
const orderItem = new Schema({
  productId: id, variantId: id, name: text, sku: text, unitPrice: money, quantity: { type: Number, min: 1, required: true },
  modifiers: [{ _id: false, name: text, additionalPrice: money }], note: String,
  buffetIncluded: Boolean, cancelReason: String,
  warehouseItemId: Schema.Types.ObjectId, unitCost: { ...money, required: false },
  ingredientCost: { ...money, required: false }, ingredientCostIncomplete: Boolean,
  ingredients: { type: [ingredient], default: undefined },
  stockLots: { type: [orderStockLot], default: undefined },
  returnedQuantity: { ...money, required: false },
});
const orders = new Schema({
  ...branchKey, actorId: Schema.Types.ObjectId, customerId: Schema.Types.ObjectId, tableSessionId: Schema.Types.ObjectId,
  guestSessionId: Schema.Types.ObjectId, tableName: String, billId: Schema.Types.ObjectId, cancelReason: String,
  source: { ...text, enum: ['POS', 'QR'] }, status: { ...text, enum: ['PLACED', 'ACCEPTED', 'CANCELED', 'COMPLETED'] },
  items: [orderItem], totalAmount: money, subtotal: money, discountAmount: money, taxAmount: { ...money, default: 0 },
  retail: Boolean, takeaway: Boolean, promotionCode: String, promotionName: String, promotionId: Schema.Types.ObjectId,
}, { timestamps: true });
orders.index({ tenantId: 1, branchId: 1, createdAt: -1 });
orders.index({ tenantId: 1, branchId: 1, tableSessionId: 1, status: 1 });
export const Order = model('Order', orders);

const buffetCount = { type: Number, required: true, min: 0, max: 1000, validate: Number.isInteger };
const buffet = new Schema({ adults: buffetCount, children: buffetCount, adultPrice: money, childPrice: money, packageName: String }, { _id: false });
const bills = new Schema({
  ...branchKey, orderIds: ids, totalAmount: money, paidAmount: money, status: { ...text, enum: ['OPEN', 'PAID', 'VOID', 'REFUNDED'] },
  tableSessionId: Schema.Types.ObjectId, discountCode: String, discountAmount: Number, promotionName: String, buffet,
  taxAmount: Number, subtotal: Number, retail: Boolean, settledAt: Date,
}, { timestamps: true });
bills.index({ tenantId: 1, branchId: 1, createdAt: -1 });
bills.index({ tenantId: 1, branchId: 1, tableSessionId: 1 });
bills.index({ tenantId: 1, branchId: 1, settledAt: 1 });
export const Bill = model('Bill', bills);

const payments = new Schema({
  ...branchKey, billId: id, actorId: Schema.Types.ObjectId, registerId: Schema.Types.ObjectId, shiftId: Schema.Types.ObjectId, method: { ...text, enum: ['CASH', 'TRANSFER'] }, amount: money,
  refundedAmount: { ...money, default: 0 }, provider: String, providerTransactionId: String, paidAt: { type: Date, default: Date.now }, reference: String,
}, { timestamps: true });
payments.index({ tenantId: 1, branchId: 1, paidAt: -1 });
payments.index({ tenantId: 1, branchId: 1, billId: 1, paidAt: -1 });
payments.index({ tenantId: 1, branchId: 1, shiftId: 1, method: 1 });
payments.index({ tenantId: 1, branchId: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } });
payments.index({ provider: 1, providerTransactionId: 1 }, { unique: true,
  partialFilterExpression: { providerTransactionId: { $type: 'string' } } });
export const Payment = model('Payment', payments);

const returnedLine = new Schema({ lineId: id, warehouseItemId: id, quantity: money }, { _id: false });
const refunds = new Schema({ ...branchKey, paymentId: id, actorId: id, amount: money, reason: text,
  salesBeforeTax: { ...money, required: false }, returnLines: { type: [returnedLine], default: undefined } }, { timestamps: true });
refunds.index({ tenantId: 1, branchId: 1, createdAt: -1 });
refunds.index({ tenantId: 1, branchId: 1, paymentId: 1, createdAt: 1 });
export const Refund = model('Refund', refunds);

const idempotency = new Schema({
  ...branchKey, operation: text, key: text, requestHash: text, response: Schema.Types.Mixed,
}, { timestamps: true });
idempotency.index({ tenantId: 1, branchId: 1, operation: 1, key: 1 }, { unique: true });
export const IdempotencyRecord = model('IdempotencyRecord', idempotency);

const areas = new Schema({ ...branchKey, name: text }, { timestamps: true });
areas.index({ tenantId: 1, branchId: 1, name: 1 }, { unique: true });
export const DiningArea = model('DiningArea', areas);

const tables = new Schema({
  ...branchKey, areaId: Schema.Types.ObjectId, name: text, qrToken: { ...text, unique: true }, sessionId: Schema.Types.ObjectId,
  reserved: { type: Boolean, default: false },
  reservation: new Schema({ guestName: text, phone: String, guests: Number, arrivesAt: Date, note: String }, { _id: false }),
}, { timestamps: true });
tables.index({ tenantId: 1, branchId: 1, name: 1 }, { unique: true });
export const DiningTable = model('DiningTable', tables);

const tableSessions = new Schema({
  ...branchKey, tableIds: ids, status: { ...text, enum: ['OPEN', 'CLOSED'] },
  openedBy: id, closedAt: Date, writeToken: String, takeaway: Boolean,
  paymentRequestedAt: Date, checkoutBillId: Schema.Types.ObjectId,
  guestCount: Number, buffet, buffetProductIds: { type: [Schema.Types.ObjectId], default: undefined },
}, { timestamps: true });
tableSessions.index({ tenantId: 1, branchId: 1, status: 1 });
export const TableSession = model('TableSession', tableSessions);

const guestSessions = new Schema({
  ...branchKey, tableSessionId: id, tokenHash: { ...text, unique: true }, expiresAt: { type: Date, expires: 0 },
}, { timestamps: true });
export const GuestSession = model('GuestSession', guestSessions);

const kitchenTickets = new Schema({
  ...branchKey, orderId: id, tableName: String, takeaway: Boolean, orderedAt: Date,
  items: [{ orderItemId: id, name: text, quantity: Number, modifiers: [String], note: String, cancelReason: String, cancelConfirmedAt: Date,
    cookingAt: Date, readyAt: Date, servedAt: Date, servedBy: Schema.Types.ObjectId,
    status: { ...text, enum: ['NEW', 'COOKING', 'READY', 'SERVED', 'CANCELED'], default: 'NEW' } }],
}, { timestamps: true });
kitchenTickets.index({ tenantId: 1, branchId: 1, orderId: 1 }, { unique: true });
export const KitchenTicket = model('KitchenTicket', kitchenTickets);

const events = new Schema({ ...branchKey, type: text, resourceId: id, createdAt: { type: Date, default: Date.now, expires: 86400 } });
events.index({ tenantId: 1, branchId: 1, _id: 1 });
export const OutboxEvent = model('OutboxEvent', events);

const audits = new Schema({ tenantId: id, branchId: Schema.Types.ObjectId, actorId: Schema.Types.ObjectId, action: text, targetId: id, details: Schema.Types.Mixed }, { timestamps: true });
audits.index({ tenantId: 1, branchId: 1, createdAt: -1 });
audits.index({ tenantId: 1, targetId: 1, action: 1 });
export const AuditLog = model('AuditLog', audits);

const customers = new Schema({ tenantId: id, name: text, phone: text }, { timestamps: true });
customers.index({ tenantId: 1, phone: 1 }, { unique: true });
export const Customer = model('Customer', customers);

const registers = new Schema({ ...branchKey, name: text, shiftId: Schema.Types.ObjectId }, { timestamps: true });
registers.index({ tenantId: 1, branchId: 1, name: 1 }, { unique: true });
export const Register = model('Register', registers);
const shifts = new Schema({
  ...branchKey, registerId: id, openedBy: id, closedBy: Schema.Types.ObjectId,
  openingCash: money, closingCash: Number, cashSales: Number, cashDifference: Number, closedAt: Date, status: text,
}, { timestamps: true });
shifts.index({ tenantId: 1, branchId: 1, createdAt: -1 });
export const Shift = model('Shift', shifts);

const intents = new Schema({
  ...branchKey, billId: id, amount: money, bank: String, account: String, reference: { ...text, unique: true },
  status: { ...text, enum: ['PENDING', 'PAID'], default: 'PENDING' }, expiresAt: { type: Date, required: true },
}, { timestamps: true });
intents.index({ tenantId: 1, branchId: 1, billId: 1 });
export const PaymentIntent = model('PaymentIntent', intents);

const incomingTransfers = new Schema({
  provider: text, transactionId: text, account: text, reference: text, amount: money,
  status: { ...text, enum: ['MATCHED', 'REVIEW'] },
  tenantId: Schema.Types.ObjectId, branchId: Schema.Types.ObjectId, intentId: Schema.Types.ObjectId,
  subscriptionId: Schema.Types.ObjectId, checkoutId: Schema.Types.ObjectId, bankReference: String, reviewReason: String,
}, { timestamps: true });
incomingTransfers.index({ provider: 1, transactionId: 1 }, { unique: true });
incomingTransfers.index({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 });
incomingTransfers.index({ subscriptionId: 1, status: 1, createdAt: -1 }, { partialFilterExpression: { subscriptionId: { $type: 'objectId' } } });
export const IncomingTransfer = model('IncomingTransfer', incomingTransfers);

export const inventoryAiProviders = ['openai', 'gemini'] as const;
export type InventoryAiProvider = typeof inventoryAiProviders[number];
export const BusinessAiSettings = model('BusinessAiSettings', new Schema({
  _id: Schema.Types.ObjectId, provider: { type: String, enum: inventoryAiProviders, default: 'openai' },
  encryptedKey: { type: String, select: false },
  encryptedGeminiKey: { type: String, select: false },
}, { timestamps: true }));

const taxDeclarations = new Schema({
  tenantId: id, name: text, taxId: text, startsOn: text, endsOn: text,
  taxableRevenue: money, outputTax: money, inputTax: money, payableTax: money,
  note: String, receipt: String, filedOn: String,
}, { timestamps: true });
taxDeclarations.index({ tenantId: 1, endsOn: -1, createdAt: -1 });
export const TaxDeclaration = model('TaxDeclaration', taxDeclarations);
