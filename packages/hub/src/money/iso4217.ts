/**
 * ISO 4217 minor-unit (scale) lookup.
 *
 * Maps a currency code to the number of decimal places its minor unit
 * uses — `EUR` → 2 (cents), `JPY` → 0 (no minor unit), `BHD` → 3 (fils).
 * Only listed codes are "known"; an unlisted code returns `null` so the
 * descriptor layer can demand an explicit `scale` / `scaleOverrides`
 * rather than silently assuming 2. This avoids the classic bug where a
 * 0-decimal currency (JPY) is stored as if it had cents.
 *
 * Coverage is the common ISO-4217 set; exotic or non-listed codes must
 * declare scale explicitly. This table is the single source of truth for
 * default scale resolution — see {@link scaleForCurrency}.
 */
const MINOR_UNITS: Readonly<Record<string, number>> = {
  // 2-decimal majors
  EUR: 2, USD: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2, SGD: 2,
  HKD: 2, CNY: 2, INR: 2, BRL: 2, MXN: 2, ZAR: 2, RUB: 2, TRY: 2,
  PLN: 2, SEK: 2, NOK: 2, DKK: 2, CZK: 2, HUF: 2, RON: 2, ILS: 2,
  THB: 2, PHP: 2, MYR: 2, IDR: 2, AED: 2, SAR: 2, QAR: 2, EGP: 2,
  // 0-decimal
  JPY: 0, KRW: 0, ISK: 0, CLP: 0, VND: 0, XOF: 0, XAF: 0, PYG: 0,
  // 3-decimal
  BHD: 3, KWD: 3, OMR: 3, TND: 3, JOD: 3, IQD: 3, LYD: 3,
}

/**
 * Return the ISO-4217 minor-unit scale for a currency code, or `null`
 * when the code is not in the known set (caller must supply an explicit
 * scale).
 */
export function scaleForCurrency(code: string): number | null {
  const v = MINOR_UNITS[code]
  return v === undefined ? null : v
}
