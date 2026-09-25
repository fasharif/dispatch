import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { LOCALE_COOKIE, MESSAGES, direction, negotiateLocale } from '@/lib/i18n';
import '../globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const locale = negotiateLocale(
    (await cookies()).get(LOCALE_COOKIE)?.value,
    (await headers()).get('accept-language'),
  );
  return {
    title: MESSAGES[locale].title,
    // Tracking links are private: keep them out of search engines.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** The customer's language decides the document's language and direction (Arabic is right to left). */
export default async function TrackingLayout({ children }: { children: ReactNode }) {
  const locale = negotiateLocale(
    (await cookies()).get(LOCALE_COOKIE)?.value,
    (await headers()).get('accept-language'),
  );
  return (
    <html lang={locale} dir={direction(locale)}>
      <body>{children}</body>
    </html>
  );
}
