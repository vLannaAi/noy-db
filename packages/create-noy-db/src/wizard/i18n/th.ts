/**
 * Thai (`th`) wizard messages.
 *
 * Editing note: this bundle MUST stay in key-parity with `en.ts`.
 * The key-parity test in `__tests__/i18n.test.ts` fails if any key
 * is missing or extra here, so a forgotten translation surfaces in
 * CI rather than as a runtime crash for a Thai-speaking user.
 *
 * Translation conventions:
 *   - Technical identifiers (`modules`, `noydb:`, `nuxt.config.ts`,
 *     `Nuxt 4`, `Pinia`, adapter names like `browser`/`file`/`memory`)
 *     stay in English. This matches how Thai developers actually
 *     read and write code — translating them would just add a
 *     mental round-trip.
 *   - Product name "noy-db" and the "None Of Your DataBase" tagline
 *     also stay in English; they're brand strings, not prose.
 *   - Validation/error strings are NOT in this file — they stay in
 *     English so bug reports look the same in any locale (see the
 *     docstring on `WizardMessages` in `types.ts` for the rationale).
 */

import type { WizardMessages } from './types.js'

export const th: WizardMessages = {
  wizardIntro:
    'ตัวช่วยสร้างสำหรับ noy-db — None Of Your DataBase\n' +
    'สร้างโปรเจกต์เริ่มต้น Nuxt 4 + Pinia พร้อมที่เก็บข้อมูลแบบเข้ารหัส',

  promptProjectName: 'ชื่อโปรเจกต์',
  promptProjectNamePlaceholder: 'my-noy-db-app',
  promptAdapter: 'อะแดปเตอร์จัดเก็บข้อมูล',
  adapterBrowserLabel:
    'browser — localStorage / IndexedDB (แนะนำสำหรับเว็บแอป)',
  adapterFileLabel:
    'file — ไฟล์ JSON บนดิสก์ (Electron / Tauri / USB)',
  adapterMemoryLabel:
    'memory — ไม่บันทึกข้อมูล (เหมาะสำหรับการทดสอบและตัวอย่าง)',
  promptSampleData: 'เพิ่มข้อมูลตัวอย่างใบแจ้งหนี้หรือไม่?',

  freshNextStepsTitle: 'ขั้นตอนถัดไป',
  freshOutroDone: '✔ เสร็จเรียบร้อย — ขอให้สนุกกับการเข้ารหัส!',

  augmentModeTitle: 'โหมดเสริมโปรเจกต์เดิม',
  augmentDetectedPrefix: 'พบโปรเจกต์ Nuxt 4 ที่มีอยู่แล้ว:',
  augmentDescription:
    'ตัวช่วยจะเพิ่ม @noy-db/in-nuxt เข้าใน modules\n' +
    'และเพิ่มคีย์ noydb: ในไฟล์ config คุณสามารถดู diff\n' +
    'ก่อนที่จะเขียนไฟล์ลงดิสก์ได้',

  augmentProposedChangesTitle: 'รายการเปลี่ยนแปลงที่จะทำ',
  augmentApplyConfirm: 'ยืนยันการเปลี่ยนแปลงเหล่านี้?',

  augmentAlreadyConfiguredTitle: 'ตั้งค่าไว้แล้ว',
  augmentNothingToDo: 'ไม่มีอะไรต้องทำ:',
  augmentAlreadyOutro: '✔ ไฟล์ Nuxt config ของคุณตั้งค่าครบแล้ว',
  augmentAborted: 'ยกเลิก — ไฟล์ config ของคุณไม่ถูกแก้ไข',
  augmentDryRunOutro: '✔ Dry run — ไม่มีไฟล์ใดถูกแก้ไข',
  augmentNextStepTitle: 'ขั้นตอนถัดไป',
  augmentInstallIntro:
    'ติดตั้งแพ็กเกจ @noy-db ที่ config ของคุณต้องใช้:',
  augmentInstallPmHint: '(หรือใช้ npm/yarn/bun ตามความเหมาะสม)',
  augmentDoneOutro: '✔ อัปเดต config เรียบร้อย — ขอให้สนุกกับการเข้ารหัส!',
  augmentUnsupportedPrefix: 'ไม่สามารถแก้ไข config นี้ได้อย่างปลอดภัย:',

  cancelled: 'ยกเลิกแล้ว',
}
