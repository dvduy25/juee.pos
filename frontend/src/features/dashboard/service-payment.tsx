export const paymentMethodLabels = { CASH: 'Tiền mặt', TRANSFER: 'Chuyển khoản' } as const;
export type PaymentMethod = keyof typeof paymentMethodLabels;

export function ServicePaymentField({ neutral = false }: { neutral?: boolean }) {
  return <label>{neutral ? 'Phương thức thanh toán' : 'Phương thức thu'}<select name="paymentMethod" defaultValue="" required>
    <option value="" disabled>{neutral ? 'Chọn phương thức' : 'Chọn phương thức đã nhận tiền'}</option>
    <option value="CASH">Tiền mặt</option>
    <option value="TRANSFER">{neutral ? 'Chuyển khoản' : 'Chuyển khoản đã nhận'}</option>
  </select></label>;
}
