'use client';

export const paymentMethodLabels = { CASH: 'Tiền mặt', TRANSFER: 'Chuyển khoản' } as const;
export type PaymentMethod = keyof typeof paymentMethodLabels;

export function ServicePaymentField({ neutral = false }: { neutral?: boolean }) {
  const { t } = useLanguage();
  return <label>{neutral ? t("Phương thức thanh toán") : t("Phương thức thu")}<select name="paymentMethod" defaultValue="" required>
    <option value="" disabled>{neutral ? t("Chọn phương thức") : t("Chọn phương thức đã nhận tiền")}</option>
    <option value="CASH">{t("Tiền mặt")}</option>
    <option value="TRANSFER">{neutral ? t("Chuyển khoản") : t("Chuyển khoản đã nhận")}</option>
  </select></label>;
}import { useLanguage } from '@/i18n/language';
