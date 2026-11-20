import { notFound } from 'next/navigation';
import { Admin } from '@/features/admin';
import { sections } from '@/features/sections';

export default async function Page({ params, searchParams }: {
  params: Promise<{ section?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section = [] } = await params;
  const key = section[0] ?? 'dashboard';
  if (section.length > 1 || !sections.some(item => item.key === key)) notFound();
  const query = await searchParams;
  const field = (name: string) => typeof query[name] === 'string' ? query[name] : undefined;
  const id = (name: string) => {
    const value = field(name);
    return value && /^[a-f0-9]{24}$/i.test(value) ? value : undefined;
  };
  const filters = { status: field('status'), q: field('q')?.slice(0, 100), id: id('id'), tenantId: id('tenantId'), subscriptionId: id('subscriptionId') };
  return <Admin key={JSON.stringify([key, filters])} section={key} filters={filters}/>;
}
