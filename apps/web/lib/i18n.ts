import type { DeliveryStatus } from '@dispatch/shared';

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_COOKIE = 'dispatch-lang';

/** BCP 47 tags for Intl; Arabic uses the UAE variant. */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-AE', ar: 'ar-AE' };

/** Deliveries are made in Dubai, so times are shown in Gulf Standard Time. */
export const TIME_ZONE = 'Asia/Dubai';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function direction(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Picks the language from the saved choice, then the browser's Accept-Language header
 * (first supported language wins), then English.
 */
export function negotiateLocale(saved: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(saved)) return saved;
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { lang: tag.toLowerCase().split('-')[0] ?? '', q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((entry) => entry.lang && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const entry of ranked) if (isLocale(entry.lang)) return entry.lang;
  return 'en';
}

const en = {
  title: 'Delivery tracking',
  order: 'Order',
  loading: 'Loading…',
  status: {
    pending: 'Being prepared',
    assigned: 'A driver has been assigned',
    picked_up: 'On the way to you',
    delivered: 'Delivered',
    failed: 'Delivery was not possible',
    cancelled: 'Delivery cancelled',
  } satisfies Record<DeliveryStatus, string>,
  steps: { assigned: 'Assigned', picked_up: 'On the way', delivered: 'Delivered' },
  driver: 'Your driver',
  arriving: 'Arriving in about {duration}',
  around: 'around {time}',
  deliveredAt: 'Delivered at {time}',
  sourceOsrm: 'Estimated from the road network',
  sourceStraight: 'Rough estimate from the straight-line distance',
  positionLater: "The driver's position appears here once your parcel is on its way.",
  updated: 'Updated {time}',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  expired: 'This tracking link has expired. Ask the sender for a new one.',
  invalid: 'This tracking link is not valid.',
  failedToLoad: 'The delivery could not be loaded. Please try again shortly.',
  switchTo: 'العربية',
  footer: 'dispatch is a portfolio project, not the official service of any company.',
  mapLabel: 'Map showing the delivery address and the driver',
} as const;

type Messages = {
  [K in keyof typeof en]: (typeof en)[K] extends string
    ? string
    : { [P in keyof (typeof en)[K]]: string };
};

const ar: Messages = {
  title: 'تتبع التوصيل',
  order: 'الطلب',
  loading: 'جارٍ التحميل…',
  status: {
    pending: 'قيد التجهيز',
    assigned: 'تم تعيين سائق',
    picked_up: 'في الطريق إليك',
    delivered: 'تم التوصيل',
    failed: 'تعذّر التوصيل',
    cancelled: 'أُلغي التوصيل',
  },
  steps: { assigned: 'تم التعيين', picked_up: 'في الطريق', delivered: 'تم التوصيل' },
  driver: 'سائقك',
  arriving: 'الوصول خلال {duration} تقريبًا',
  around: 'حوالي الساعة {time}',
  deliveredAt: 'تم التوصيل الساعة {time}',
  sourceOsrm: 'تقدير حسب شبكة الطرق',
  sourceStraight: 'تقدير تقريبي حسب المسافة المستقيمة',
  positionLater: 'يظهر موقع السائق هنا عندما تكون شحنتك في الطريق.',
  updated: 'آخر تحديث {time}',
  live: 'مباشر',
  reconnecting: 'جارٍ إعادة الاتصال…',
  expired: 'انتهت صلاحية رابط التتبع. اطلب رابطًا جديدًا من المرسل.',
  invalid: 'رابط التتبع هذا غير صالح.',
  failedToLoad: 'تعذّر تحميل بيانات التوصيل. يُرجى المحاولة بعد قليل.',
  switchTo: 'English',
  footer: 'dispatch مشروع ضمن معرض أعمال، وليس خدمة رسمية لأي شركة.',
  mapLabel: 'خريطة تعرض عنوان التوصيل وموقع السائق',
};

export const MESSAGES: Record<Locale, Messages> = { en, ar };

/** Replaces {name} placeholders. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** "12 minutes" / "١٢ دقيقة", with the plural rules of the language. Rounds up to whole minutes. */
export function formatDuration(seconds: number, locale: Locale): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 90) {
    return new Intl.NumberFormat(INTL_LOCALE[locale], {
      style: 'unit',
      unit: 'minute',
      unitDisplay: 'long',
    }).format(minutes);
  }
  const hours = Math.round((minutes / 60) * 10) / 10;
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'unit',
    unit: 'hour',
    unitDisplay: 'long',
    maximumFractionDigits: 1,
  }).format(hours);
}

/** Clock time in Dubai, e.g. "2:35 pm" / "٢:٣٥ م". */
export function formatTime(iso: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  }).format(new Date(iso));
}
