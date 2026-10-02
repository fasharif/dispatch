import { cookies, headers } from 'next/headers';
import { TrackingPage } from '@/components/tracking/TrackingPage';
import { LOCALE_COOKIE, negotiateLocale } from '@/lib/i18n';

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = negotiateLocale(
    (await cookies()).get(LOCALE_COOKIE)?.value,
    (await headers()).get('accept-language'),
  );
  return <TrackingPage token={token} locale={locale} />;
}
