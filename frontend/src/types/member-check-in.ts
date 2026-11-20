export const memberCredentialLabels = { CARD: 'Thẻ hội viên', FINGERPRINT: 'Vân tay', FACE: 'Khuôn mặt' } as const;
export const checkInMethodLabels = { MEMBER_CODE: 'Mã hội viên', ...memberCredentialLabels } as const;
export type CheckInMethod = keyof typeof checkInMethodLabels;
export type KioskMethod = Extract<CheckInMethod, 'MEMBER_CODE' | 'CARD'>;
export type CheckInSettings = { methods: CheckInMethod[]; kioskEnabled: boolean };
export type VisitProgress = { registeredOn?: string; firstVisitedOn: string; attendedDays: number; expiresOn?: string; remainingDays?: number };
