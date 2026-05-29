import { config, sample } from './config.js'
import { verifyDocument, type Verdict } from './verify-core.js'

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function renderFields(): void {
  const wrap = byId('fields')
  wrap.innerHTML = ''
  for (const f of config.fieldSchema.fields) {
    const row = document.createElement('label')
    row.className = 'field'
    row.innerHTML = `<span>${f.path}</span>`
    const input = document.createElement('input')
    input.dataset['path'] = f.path
    row.appendChild(input)
    wrap.appendChild(row)
  }
}

function readClaimed(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input[data-path]'))) {
    out[el.dataset['path'] as string] = el.value
  }
  return out
}

const BANNER: Record<Verdict['outcome'], { cls: string; text: string }> = {
  'authentic-valid': { cls: 'ok', text: '✓ AUTHENTIC & VALID' },
  'authentic-revoked': { cls: 'warn', text: '⚠ REVOKED — issued by the firm, since withdrawn' },
  'altered': { cls: 'bad', text: '✗ ALTERED — does not match the signature' },
  'signature-invalid': { cls: 'bad', text: '✗ SIGNATURE INVALID' },
  'unknown-key': { cls: 'warn', text: '⚠ UNRECOGNIZED KEY — update this verifier' },
  'unreadable-qr': { cls: 'warn', text: '⚠ UNREADABLE QR' },
}

function render(v: Verdict): void {
  const out = byId('result')
  const b = BANNER[v.outcome]
  const downgraded = v.outcome === 'authentic-valid' && v.revocationTrusted === false
  const text = downgraded ? '✓ AUTHENTIC & UNALTERED · revocation status could not be confirmed' : b.text
  const cls = downgraded ? 'warn' : b.cls
  const rows = v.perField.map((f) => `<div class="row ${f.match ? 'm' : 'x'}"><span>${f.path}</span><span>${f.match ? '✓ match' : '✗ differs'}</span></div>`).join('')
  const revBadge = v.revocationTrusted === false ? 'revocation status untrusted'
    : v.outcome === 'authentic-revoked' ? 'revoked'
    : v.revocationTrusted === true ? 'not revoked' : '—'
  out.innerHTML = `<div class="banner ${cls}">${text}</div>${rows}<div class="foot"></div>`
  const foot = out.querySelector('.foot')
  if (foot) foot.textContent = `keyId ${v.keyId ?? '—'} · docId ${v.docId ?? '—'} · ${revBadge}`
}

function init(): void {
  renderFields()
  byId('verify').addEventListener('click', () => {
    void verifyDocument((byId<HTMLTextAreaElement>('qr')).value.trim(), readClaimed(), config)
      .then(render)
      .catch((err: unknown) => {
        const out = byId('result')
        out.innerHTML = '<div class="banner bad"></div>'
        const banner = out.querySelector('.banner')
        if (banner) banner.textContent = `✗ COULD NOT VERIFY — ${err instanceof Error ? err.message : String(err)}`
      })
  })
  byId('load-sample').addEventListener('click', () => {
    (byId<HTMLTextAreaElement>('qr')).value = sample.qr
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input[data-path]'))) {
      el.value = String(sample.record[el.dataset['path'] as string] ?? '')
    }
  })
}

init()
