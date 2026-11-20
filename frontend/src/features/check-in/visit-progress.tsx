import type { VisitProgress } from '@/types/member-check-in';

function VisitDate({ day }: { day: string }) {
  return <time dateTime={day}>{day.split('-').reverse().join('/')}</time>;
}

export function VisitProgressFields({ progress, remaining }: { progress?: VisitProgress; remaining?: number }) {
  return <>
    {progress?.registeredOn && <><dt>Ngày đăng ký</dt><dd><VisitDate day={progress.registeredOn}/></dd></>}
    {progress && <>
      <dt>Bắt đầu tập</dt><dd><VisitDate day={progress.firstVisitedOn}/></dd>
      <dt>Đã đến tập</dt><dd><strong>{progress.attendedDays} ngày</strong></dd>
    </>}
    {typeof remaining === 'number' && <><dt>Lượt còn sau check-in</dt><dd><strong>{remaining} lượt</strong></dd></>}
    {typeof progress?.remainingDays === 'number' && <><dt>Thời hạn còn lại</dt><dd><strong>{progress.remainingDays} ngày</strong> <small>(gồm hôm nay)</small></dd></>}
    {progress?.expiresOn && <><dt>Hạn gói lúc check-in</dt><dd><VisitDate day={progress.expiresOn}/></dd></>}
  </>;
}
