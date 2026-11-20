export function hasBranchAccess<T>(role: string, assigned: T[], branch: T, equals: (left: T, right: T) => boolean = Object.is) {
  return role === 'OWNER' || assigned.some(id => equals(id, branch));
}

export function canAdmin(mfa: boolean, permissions: string[], required: string): boolean {
  return mfa && permissions.includes('platform.admin') && permissions.includes(required);
}

export function canManageBranches(role: string, assigned: string[] = [], branchId?: string) {
  return role === 'OWNER' || (role === 'MANAGER' && branchId !== undefined && hasBranchAccess(role, assigned, branchId));
}
