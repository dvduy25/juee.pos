import { redirect } from 'next/navigation';

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  redirect(typeof tab === 'string' ? `/dashboard/company?${new URLSearchParams({ tab })}` : '/dashboard/company');
}
