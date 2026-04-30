/**
 * Shared fixtures for noy-db showcases.
 *
 * The fixtures are intentionally tiny — they cover the small-team accounting
 * domain that every showcase speaks (Invoice, Client, Payment) without
 * pulling in any dependencies. Each showcase is free to extend or ignore.
 */

export interface Invoice {
  id: string
  clientId: string
  amount: number
  currency: 'THB' | 'USD' | 'EUR'
  status: 'draft' | 'open' | 'paid' | 'overdue'
  issueDate: string      // ISO-8601
  dueDate: string        // ISO-8601
  month: string          // YYYY-MM — denormalised for groupBy demos
  notes?: string
}

export interface Client {
  id: string
  name: string
  country: 'TH' | 'US' | 'EU' | 'SG'
}

export interface Payment {
  id: string
  invoiceId: string
  amount: number
  paidAt: string         // ISO-8601
}

/**
 * A deterministic passphrase every showcase can use. Not secret — these are
 * ephemeral in-memory vaults. Don't copy this value into any real app.
 */
export const SHOWCASE_PASSPHRASE = 'showcase-passphrase-not-a-real-secret'

/** A handful of clients used across showcases. */
export const sampleClients: Client[] = [
  { id: 'cl-01', name: 'Acme Coffee Roasters',    country: 'TH' },
  { id: 'cl-02', name: 'Northern Lights Textiles', country: 'TH' },
  { id: 'cl-03', name: 'River Valley Orchards',    country: 'TH' },
  { id: 'cl-04', name: 'Skyline Design Studio',    country: 'SG' },
  { id: 'cl-05', name: 'Harbour Logistics',        country: 'US' },
]

/**
 * Generate N invoices spanning 12 months, 10 clients, 4 statuses.
 * Deterministic — given the same N, always returns the same list.
 */
export function generateInvoices(count: number, startYear = 2026): Invoice[] {
  const statuses: Invoice['status'][] = ['draft', 'open', 'paid', 'overdue']
  const currencies: Invoice['currency'][] = ['THB', 'USD', 'EUR']
  const out: Invoice[] = []
  for (let i = 0; i < count; i++) {
    const month = 1 + (i % 12)
    const day = 1 + (i % 28)
    const issueDate = `${startYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const dueMonth = month === 12 ? 1 : month + 1
    const dueYear = month === 12 ? startYear + 1 : startYear
    const dueDate = `${dueYear}-${String(dueMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    out.push({
      id: `inv-${String(i + 1).padStart(4, '0')}`,
      clientId: sampleClients[i % sampleClients.length].id,
      amount: 1000 + ((i * 317) % 49000), // 1k–50k spread
      currency: currencies[i % currencies.length],
      status: statuses[i % statuses.length],
      issueDate,
      dueDate,
      month: `${startYear}-${String(month).padStart(2, '0')}`,
    })
  }
  return out
}

/**
 * A small deterministic PDF-like byte buffer for blob tests. Not a real PDF —
 * just bytes prefixed with the PDF magic so MIME detection classifies it.
 */
export function fakePdfBytes(size = 2048): Uint8Array {
  const out = new Uint8Array(size)
  // PDF magic: %PDF-1.4
  const magic = new TextEncoder().encode('%PDF-1.4\n')
  out.set(magic, 0)
  // Fill the rest with a repeating pseudo-pattern so compression has work to do
  for (let i = magic.length; i < size; i++) out[i] = (i * 7) & 0xff
  return out
}

/** Small UTF-8 Thai text snippet for encryption-round-trip tests. */
export const THAI_SAMPLE = 'สวัสดีชาวโลก — NOYDB ปลอดภัย'

/**
 * Sleep helper — some showcases need to advance a clock or yield the event
 * loop. Keep it here so every file doesn't re-declare it.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
