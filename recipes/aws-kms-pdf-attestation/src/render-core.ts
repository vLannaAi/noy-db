import QRCode from 'qrcode'
import type { Browser } from 'puppeteer-core'
import type { RenderPayload } from './payload.js'

/** Build the invoice HTML with the QR embedded as inline (vector) SVG. */
export async function buildInvoiceHtml(payload: RenderPayload): Promise<string> {
  const qrSvg = await QRCode.toString(payload.qr, { type: 'svg', margin: 1, width: 160 })
  const rows = Object.entries(payload.fields)
    .map(([k, v]) => `<tr><th style="text-align:left;padding:4px 12px 4px 0">${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`)
    .join('')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<style>
  body { font-family: system-ui, sans-serif; margin: 40px; color: #1f2733; }
  h1 { font-size: 20px; } .meta { color: #667; font-size: 12px; }
  table { margin: 20px 0; border-collapse: collapse; }
  .qr { margin-top: 24px; } .qr svg { width: 160px; height: 160px; }
  .doc { color: #889; font-size: 11px; }
</style></head>
<body>
  <h1>Invoice</h1>
  <p class="meta">Issued by the firm · attestation document ${escapeHtml(payload.docId)}</p>
  <table>${rows}</table>
  <div class="qr">${qrSvg}</div>
  <p class="doc">Scan / verify offline — the QR carries a signed per-field commitment.</p>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Render HTML → PDF via headless Chromium. NOT exercised in CI (needs the
 * @sparticuz/chromium binary); isolated so the handler can stub it. The browser
 * is created lazily and reused across warm Lambda invocations.
 */
let browserPromise: Promise<Browser> | null = null
export async function renderPdf(html: string): Promise<Uint8Array> {
  const [{ default: chromium }, puppeteer] = await Promise.all([
    import('@sparticuz/chromium'),
    import('puppeteer-core'),
  ])
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    }) as Promise<Browser>
  }
  const browser = await browserPromise
  const page = await browser.newPage()
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdf = await page.pdf({ format: 'A4', printBackground: true })
    return new Uint8Array(pdf)
  } finally {
    await page.close()
  }
}
