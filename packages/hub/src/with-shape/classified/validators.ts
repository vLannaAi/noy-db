/** Pure write-time validators. Exported so userland can validate storage:'never'
 *  fields (e.g. CVC) at capture, before dropping them. @module */

export function luhnCheck(pan: string): boolean {
  const digits = pan.replace(/[\s-]/g, '')
  if (!/^\d{12,19}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}
