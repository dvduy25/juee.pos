import type { ReactNode } from 'react';
import { BusinessWorkspace } from '@/features/dashboard/business';

export default function Layout({ children }: { children: ReactNode }) {
  return <BusinessWorkspace>{children}</BusinessWorkspace>;
}
