'use client';

import { useLanguage } from '@/i18n/language';
import type { VisitProgress } from '@/types/member-check-in';

function VisitDate({ day }: { day: string }) {
  return <time dateTime={day}>{day.split('-').reverse().join('/')}</time>;
}

export function VisitProgressFields({ progress, remaining }: { progress?: VisitProgress; remaining?: number }) {
  const { t } = useLanguage();
  return <>
    {progress?.registeredOn && <><dt>{t("Ngày đăng ký")}</dt><dd><VisitDate day={progress.registeredOn}/></dd></>}
    {progress && <>
      <dt>{t("Bắt đầu tập")}</dt><dd><VisitDate day={progress.firstVisitedOn}/></dd>
      <dt>{t("Đã đến tập")}</dt><dd><strong>{progress.attendedDays} {t("ngày")}</strong></dd>
    </>}
    {typeof remaining === 'number' && <><dt>{t("Lượt còn sau check-in")}</dt><dd><strong>{remaining} {t("lượt")}</strong></dd></>}
    {typeof progress?.remainingDays === 'number' && <><dt>{t("Thời hạn còn lại")}</dt><dd><strong>{progress.remainingDays} {t("ngày")}</strong> <small>{t("(gồm hôm nay)")}</small></dd></>}
    {progress?.expiresOn && <><dt>{t("Hạn gói lúc check-in")}</dt><dd><VisitDate day={progress.expiresOn}/></dd></>}
  </>;
}
