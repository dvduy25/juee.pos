import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { canAdmin, hasBranchAccess, canManageBranches } from '../src/middleware/policy.ts';
import { adminWebOrigin, authenticateToken, sessionIssuer } from '../src/middleware/auth';
import { allows } from '../src/middleware/business-access';
import { loginRoles } from '../src/models';

test('platform access requires an explicit grant, requested permission and MFA', () => {
  assert.equal(canAdmin(true, ['OWNER'], 'platform.read'), false);
  assert.equal(canAdmin(false, ['platform.admin', 'platform.read'], 'platform.read'), false);
  assert.equal(canAdmin(true, ['platform.admin', 'platform.read'], 'platform.write'), false);
  assert.equal(canAdmin(true, ['platform.admin', 'platform.read'], 'platform.read'), true);
});

test('admin and customer tokens are rejected by the opposite session surface', async () => {
  const previous = process.env.JWT_SECRET;
  const secret = randomBytes(32).toString('hex');
  process.env.JWT_SECRET = secret;
  try {
    const subject = randomBytes(12).toString('hex');
    const customer = jwt.sign({}, secret, { issuer: sessionIssuer('customer'), subject });
    const admin = jwt.sign({}, secret, { issuer: sessionIssuer('admin'), subject });
    await assert.rejects(authenticateToken(customer, { surface: 'admin' }), { name: 'UnauthorizedException' });
    await assert.rejects(authenticateToken(admin), { name: 'UnauthorizedException' });
    assert.equal(adminWebOrigin({ NODE_ENV: 'production' }), undefined);
    assert.equal(adminWebOrigin({ NODE_ENV: 'development' }), 'http://127.0.0.1:3002');
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test('branch staff are restricted to assigned branches', () => {
  assert.equal(hasBranchAccess('CASHIER', ['branch-a'], 'branch-a'), true);
  assert.equal(hasBranchAccess('CASHIER', ['branch-a'], 'branch-b'), false);
  assert.equal(hasBranchAccess('CASHIER', [], 'branch-a'), false);
  assert.equal(hasBranchAccess('OWNER', [], 'branch-a'), true);
});

test('only owners can create branches and managers can edit only assigned branches', () => {
  assert.equal(canManageBranches('OWNER'), true);
  assert.equal(canManageBranches('OWNER', [], 'branch-a'), true);
  assert.equal(canManageBranches('MANAGER', ['branch-a']), false);
  assert.equal(canManageBranches('MANAGER', ['branch-a'], 'branch-a'), true);
  assert.equal(canManageBranches('MANAGER', ['branch-a'], 'branch-b'), false);
  assert.equal(canManageBranches('CASHIER', ['branch-a'], 'branch-a'), false);
});

test('owners and managers administer assigned branches without granting administrative rights to counter mode', () => {
  for (const permission of ['member-plans.manage', 'member-check-in.manage', 'hotel.manage', 'tables.configure',
    'buffet.manage', 'finance.manage', 'company.report', 'company.revenue', 'staff.profiles'] as const) {
    assert.equal(allows('OWNER', permission), true);
    assert.equal(allows('MANAGER', permission), true);
    assert.equal(allows('CASHIER', permission), false);
  }
  assert.equal(allows('MANAGER', 'members.write'), true);
  assert.equal(allows('CASHIER', 'members.read'), true);
});

test('reception can register members while profile changes require management rights', () => {
  for (const role of ['OWNER', 'MANAGER', 'CASHIER'] as const) assert.equal(allows(role, 'members.create'), true);
  for (const role of ['WAITER', 'KITCHEN', 'INVENTORY', 'ACCOUNTANT'] as const) assert.equal(allows(role, 'members.create'), false);
  assert.equal(allows('CASHIER', 'members.write'), false);
});

test('only management roles sign in and restricted counter mode can record the manager’s own attendance', () => {
  assert.deepEqual(loginRoles, ['OWNER', 'MANAGER']);
  assert.equal(allows('OWNER', 'staff.manage'), true);
  assert.equal(allows('MANAGER', 'staff.manage'), false);
  assert.equal(allows('MANAGER', 'staff.schedule'), true);
  assert.equal(allows('CASHIER', 'staff.clock'), true);
  assert.equal(allows('CASHIER', 'staff.schedule'), false);
  for (const role of ['WAITER', 'KITCHEN', 'INVENTORY', 'ACCOUNTANT', 'COACH'] as const) {
    assert.equal(allows(role, 'staff.clock'), false);
    assert.equal(allows(role, 'staff.schedule'), false);
  }
  assert.equal(allows('COACH', 'member-classes.read'), false);
  assert.equal(allows('COACH', 'member-classes.attendance'), false);
  assert.equal(allows('COACH', 'members.read'), false);
  assert.equal(allows('COACH', 'payments.collect'), false);
});
