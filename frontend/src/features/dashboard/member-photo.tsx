'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { useBusiness } from '@/hooks/use-business';
import { apiBlob } from '@/services/api-client';

export function MemberPhoto({ memberId, version, large = false }: { memberId: string; version?: string; large?: boolean }) {
  const { root } = useBusiness();
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState('');
  const photo = useQuery({
    queryKey: ['member-photo', root, memberId, version],
    queryFn: () => apiBlob(`${root}/members/${memberId}/photo`),
    enabled: !!version && visible,
    staleTime: 60 * 1000,
    gcTime: 60 * 1000,
  });

  useEffect(() => {
    const element = ref.current;
    if (!element || !version || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '120px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [version, visible]);
  useEffect(() => {
    if (!photo.data) { setSrc(''); return; }
    const url = URL.createObjectURL(photo.data);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [photo.data]);

  return <span ref={ref} className={`member-avatar ${large ? 'member-avatar-large' : ''}`} aria-hidden="true">
    {src ? <img src={src} alt=""/> : <UserRound size={large ? 40 : 22}/>}
  </span>;
}
