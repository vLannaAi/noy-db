/**
 * Lightweight MIME type detection from magic bytes (file signatures).
 *
 * Designed for the blob store's auto-detection feature (v0.12 design doc,
 * "MIME type auto-detection" section). Operates on the first 16 bytes of
 * plaintext — no filesystem access, no filename guessing.
 *
 * ## Detection strategies
 *
 * 1. **Prefix match** — magic bytes at offset 0 (most formats).
 * 2. **Offset match** — magic bytes at a fixed offset > 0 (ISOBMFF: offset 4).
 * 3. **Compound match** — two separate byte sequences at different offsets
 *    (RIFF-based: bytes 0-3 + bytes 8-11).
 *
 * ## Formats excluded (require offset > 16 bytes)
 *
 * - TAR (`ustar` at offset 257)
 * - ISO 9660 (`CD001` at offset 32769)
 *
 * @module
 */

// ─── Types ───────────────────────────────────────────────────────────────

interface MagicRule {
  /** IANA MIME type (or widely-used x- type). */
  readonly mime: string
  /** Human-readable format name for diagnostics. */
  readonly format: string
  /** Magic bytes to match, as a Uint8Array. */
  readonly bytes: Uint8Array
  /** Byte offset where the magic starts. Default 0. */
  readonly offset?: number
  /**
   * For compound checks (RIFF, FORM): a second byte sequence that must
   * also match at `secondaryOffset`.
   */
  readonly secondaryBytes?: Uint8Array
  /** Offset of the secondary match. */
  readonly secondaryOffset?: number
  /** If true, the format is already compressed — skip gzip in blob.put(). */
  readonly preCompressed?: true
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Convert a hex string like `'FF D8 FF'` to Uint8Array. */
function hex(s: string): Uint8Array {
  return new Uint8Array(s.split(' ').map((b) => parseInt(b, 16)))
}

// ─── Magic rules ─────────────────────────────────────────────────────────
//
// Ordered by detection priority: more specific (longer) signatures first
// within the same offset group, so that e.g. RAR v5 (8 bytes) is tested
// before RAR v4 (7 bytes).
//
// Sources verified against:
//   - Gary Kessler's File Signatures Table
//   - Wikipedia "List of file signatures"
//   - IANA MIME type registry
//   - Individual format specifications (PNG RFC 2083, PDF ISO 32000, etc.)
//
// Each entry includes the original CSV row number for traceability.

const MAGIC_RULES: readonly MagicRule[] = [
  // ── Images ───────────────────────────────────────────────────────────

  // #2  PNG — full 8-byte signature (RFC 2083)
  { mime: 'image/png', format: 'PNG', bytes: hex('89 50 4E 47 0D 0A 1A 0A'), preCompressed: true },

  // #1  JPEG — FF D8 FF (third byte is start of APP marker, always FF)
  { mime: 'image/jpeg', format: 'JPEG', bytes: hex('FF D8 FF'), preCompressed: true },

  // #7  WebP — RIFF compound: bytes 0-3 = RIFF, bytes 8-11 = WEBP
  {
    mime: 'image/webp',
    format: 'WebP',
    bytes: hex('52 49 46 46'),
    secondaryBytes: hex('57 45 42 50'),
    secondaryOffset: 8,
    preCompressed: true,
  },

  // #5  TIFF (little-endian) — II + version 42
  { mime: 'image/tiff', format: 'TIFF', bytes: hex('49 49 2A 00') },

  // #6  TIFF (big-endian) — MM + version 42
  { mime: 'image/tiff', format: 'TIFF', bytes: hex('4D 4D 00 2A') },

  // #3  GIF — GIF8 (covers GIF87a and GIF89a)
  { mime: 'image/gif', format: 'GIF', bytes: hex('47 49 46 38'), preCompressed: true },

  // #4  BMP — BM
  { mime: 'image/bmp', format: 'BMP', bytes: hex('42 4D') },

  // #10 PSD — 8BPS
  { mime: 'image/vnd.adobe.photoshop', format: 'PSD', bytes: hex('38 42 50 53') },

  // #8  ICO — 00 00 01 00 (note: 00 00 02 00 is CUR cursor format)
  { mime: 'image/x-icon', format: 'ICO', bytes: hex('00 00 01 00') },

  // #9  HEIC — ISOBMFF: ftyp at offset 4, brand "heic" at offset 8
  {
    mime: 'image/heic',
    format: 'HEIC',
    bytes: hex('66 74 79 70'),
    offset: 4,
    secondaryBytes: hex('68 65 69 63'),
    secondaryOffset: 8,
    preCompressed: true,
  },

  // ── Documents ────────────────────────────────────────────────────────

  // #11 PDF — %PDF
  { mime: 'application/pdf', format: 'PDF', bytes: hex('25 50 44 46') },

  // #43 RTF — {\rtf
  { mime: 'application/rtf', format: 'RTF', bytes: hex('7B 5C 72 74 66') },

  // ── Archives & compression ───────────────────────────────────────────

  // #14 RAR v5 — 8-byte signature (test before RAR v4)
  { mime: 'application/vnd.rar', format: 'RAR v5', bytes: hex('52 61 72 21 1A 07 01 00'), preCompressed: true },

  // #13 RAR v4 — 7-byte signature
  { mime: 'application/vnd.rar', format: 'RAR v4', bytes: hex('52 61 72 21 1A 07 00'), preCompressed: true },

  // #15 7-Zip — 6-byte signature
  { mime: 'application/x-7z-compressed', format: '7Z', bytes: hex('37 7A BC AF 27 1C'), preCompressed: true },

  // #19 XZ — 6-byte stream header
  { mime: 'application/x-xz', format: 'XZ', bytes: hex('FD 37 7A 58 5A 00'), preCompressed: true },

  // #12 ZIP — PK\x03\x04 (local file header)
  { mime: 'application/zip', format: 'ZIP', bytes: hex('50 4B 03 04'), preCompressed: true },

  // #16 GZIP — 1F 8B
  { mime: 'application/gzip', format: 'GZIP', bytes: hex('1F 8B'), preCompressed: true },

  // #17 BZIP2 — BZh
  { mime: 'application/x-bzip2', format: 'BZIP2', bytes: hex('42 5A 68'), preCompressed: true },

  // #20 LZIP — LZIP
  { mime: 'application/x-lzip', format: 'LZIP', bytes: hex('4C 5A 49 50'), preCompressed: true },

  // ── Audio ────────────────────────────────────────────────────────────

  // #24 WAV — RIFF compound: bytes 0-3 = RIFF, bytes 8-11 = WAVE
  {
    mime: 'audio/wav',
    format: 'WAV',
    bytes: hex('52 49 46 46'),
    secondaryBytes: hex('57 41 56 45'),
    secondaryOffset: 8,
  },

  // #27 AIFF — FORM compound: bytes 0-3 = FORM, bytes 8-11 = AIFF
  {
    mime: 'audio/aiff',
    format: 'AIFF',
    bytes: hex('46 4F 52 4D'),
    secondaryBytes: hex('41 49 46 46'),
    secondaryOffset: 8,
  },

  // #23 FLAC — fLaC
  { mime: 'audio/flac', format: 'FLAC', bytes: hex('66 4C 61 43') },

  // #25 OGG — OggS (container — may hold Vorbis, Opus, Theora, etc.)
  { mime: 'application/ogg', format: 'OGG', bytes: hex('4F 67 67 53') },

  // #26 MIDI — MThd
  { mime: 'audio/midi', format: 'MIDI', bytes: hex('4D 54 68 64') },

  // #22 MP3 (ID3-tagged) — ID3
  { mime: 'audio/mpeg', format: 'MP3', bytes: hex('49 44 33'), preCompressed: true },

  // ── Video ────────────────────────────────────────────────────────────

  // #30 AVI — RIFF compound: bytes 0-3 = RIFF, bytes 8-11 = AVI\x20
  {
    mime: 'video/x-msvideo',
    format: 'AVI',
    bytes: hex('52 49 46 46'),
    secondaryBytes: hex('41 56 49 20'),
    secondaryOffset: 8,
    preCompressed: true,
  },

  // #32 WMV/ASF — 8-byte ASF header GUID prefix
  { mime: 'video/x-ms-wmv', format: 'WMV', bytes: hex('30 26 B2 75 8E 66 CF 11'), preCompressed: true },

  // #29 MKV/WebM — EBML header (Matroska container)
  { mime: 'video/x-matroska', format: 'MKV', bytes: hex('1A 45 DF A3'), preCompressed: true },

  // #33 FLV — FLV
  { mime: 'video/x-flv', format: 'FLV', bytes: hex('46 4C 56'), preCompressed: true },

  // #31 MOV — ISOBMFF: ftyp at offset 4, brand "qt  " at offset 8
  {
    mime: 'video/quicktime',
    format: 'MOV',
    bytes: hex('66 74 79 70'),
    offset: 4,
    secondaryBytes: hex('71 74 20 20'),
    secondaryOffset: 8,
    preCompressed: true,
  },

  // #28 MP4 — ISOBMFF: ftyp at offset 4 (brands vary: isom, mp41, mp42, etc.)
  //     Tested AFTER MOV and HEIC so their specific brands match first.
  { mime: 'video/mp4', format: 'MP4', bytes: hex('66 74 79 70'), offset: 4, preCompressed: true },

  // ── Executables & binaries ───────────────────────────────────────────

  // #39 SQLite — "SQLite 3" (first 8 bytes of the 16-byte header)
  { mime: 'application/vnd.sqlite3', format: 'SQLite', bytes: hex('53 51 4C 69 74 65 20 33') },

  // #48 WASM — \0asm
  { mime: 'application/wasm', format: 'WASM', bytes: hex('00 61 73 6D') },

  // #35 ELF — \x7FELF
  { mime: 'application/x-elf', format: 'ELF', bytes: hex('7F 45 4C 46') },

  // #34 PE (EXE/DLL) — MZ
  { mime: 'application/vnd.microsoft.portable-executable', format: 'PE', bytes: hex('4D 5A') },

  // #36 Mach-O — all four single-arch variants
  { mime: 'application/x-mach-binary', format: 'Mach-O 64 LE', bytes: hex('CF FA ED FE') },
  { mime: 'application/x-mach-binary', format: 'Mach-O 64 BE', bytes: hex('FE ED FA CF') },
  { mime: 'application/x-mach-binary', format: 'Mach-O 32 LE', bytes: hex('CE FA ED FE') },
  { mime: 'application/x-mach-binary', format: 'Mach-O 32 BE', bytes: hex('FE ED FA CE') },

  // #37 Java Class — CA FE BA BE
  //     Note: collides with Mach-O Universal Binary. Disambiguated by checking
  //     bytes 4-7: Java class version is >= 0x002D (45), while fat binary
  //     arch count is a small number (typically 0x00000002).
  //     We place Java after Mach-O single-arch entries so the more common
  //     Mach-O variants match first. The CA FE BA BE collision between Java
  //     and Mach-O fat binary is resolved by the caller if needed.
  { mime: 'application/java-vm', format: 'Java Class', bytes: hex('CA FE BA BE') },

  // #38 DEX — dex\n (Android Dalvik Executable)
  { mime: 'application/vnd.android.dex', format: 'DEX', bytes: hex('64 65 78 0A') },

  // ── Package formats ──────────────────────────────────────────────────

  // #45 DEB — !<arch> (ar archive; DEB-specific member follows)
  { mime: 'application/vnd.debian.binary-package', format: 'DEB', bytes: hex('21 3C 61 72 63 68 3E') },

  // #46 RPM — ED AB EE DB
  { mime: 'application/x-rpm', format: 'RPM', bytes: hex('ED AB EE DB') },

  // #44 CAB — MSCF
  { mime: 'application/vnd.ms-cab-compressed', format: 'CAB', bytes: hex('4D 53 43 46'), preCompressed: true },

  // ── Capture & Flash ──────────────────────────────────────────────────

  // #40 PCAP (little-endian) — D4 C3 B2 A1
  { mime: 'application/vnd.tcpdump.pcap', format: 'PCAP', bytes: hex('D4 C3 B2 A1') },

  // #40 PCAP (big-endian) — A1 B2 C3 D4
  { mime: 'application/vnd.tcpdump.pcap', format: 'PCAP BE', bytes: hex('A1 B2 C3 D4') },

  // #41 PCAPNG — Section Header Block
  { mime: 'application/x-pcapng', format: 'PCAPNG', bytes: hex('0A 0D 0D 0A') },

  // #42 SWF — all three variants (uncompressed, zlib, LZMA)
  { mime: 'application/x-shockwave-flash', format: 'SWF', bytes: hex('46 57 53') },
  { mime: 'application/x-shockwave-flash', format: 'SWF zlib', bytes: hex('43 57 53'), preCompressed: true },
  { mime: 'application/x-shockwave-flash', format: 'SWF LZMA', bytes: hex('5A 57 53'), preCompressed: true },

  // ── Data formats ─────────────────────────────────────────────────────

  // #49 Parquet — PAR1 (no registered IANA MIME; using Apache's informal type)
  { mime: 'application/vnd.apache.parquet', format: 'Parquet', bytes: hex('50 41 52 31') },

  // #50 Avro Object Container — Obj\x01
  { mime: 'application/avro', format: 'Avro', bytes: hex('4F 62 6A 01') },

  // #47 NES ROM — NES\x1A (iNES header)
  { mime: 'application/x-nintendo-nes-rom', format: 'NES ROM', bytes: hex('4E 45 53 1A') },
] as const

// ─── MP3 sync word ───────────────────────────────────────────────────────
//
// MP3 files without an ID3 tag start with a frame sync word where the top
// 11 bits are set: 0xFFE0 mask. The ID3 signature (49 44 33) is handled
// as a normal rule above. The sync-word check is a fallback tested in
// `detectMimeType` after all rules.

function isMp3SyncWord(byte0: number, byte1: number): boolean {
  return byte0 === 0xff && (byte1 & 0xe0) === 0xe0
}

// ─── Detection ───────────────────────────────────────────────────────────

/**
 * Detect MIME type from the first bytes of a file.
 *
 * @param header - The first 16 bytes (or more) of the plaintext. Passing
 *   fewer than 16 bytes may miss compound and offset-based matches.
 * @returns Detected MIME type, or `'application/octet-stream'` if unknown.
 */
export function detectMimeType(header: Uint8Array): string {
  const result = detectMagic(header)
  return result?.mime ?? 'application/octet-stream'
}

/**
 * Detect MIME type and whether the format is already compressed.
 *
 * Used by `BlobSet.put()` to decide whether to skip gzip compression.
 *
 * @param header - The first 16 bytes (or more) of the plaintext.
 * @returns `{ mime, preCompressed }` or `null` if no match.
 */
export function detectMagic(
  header: Uint8Array,
): { mime: string; format: string; preCompressed: boolean } | null {
  for (const rule of MAGIC_RULES) {
    if (matchRule(header, rule)) {
      return {
        mime: rule.mime,
        format: rule.format,
        preCompressed: rule.preCompressed ?? false,
      }
    }
  }

  // Fallback: MP3 sync word (no ID3 tag)
  if (header.length >= 2 && isMp3SyncWord(header[0]!, header[1]!)) {
    return { mime: 'audio/mpeg', format: 'MP3', preCompressed: true }
  }

  return null
}

/**
 * Check whether a format is already compressed (should skip gzip).
 *
 * @param mimeType - A MIME type string.
 * @returns `true` if the format is known to be pre-compressed.
 */
export function isPreCompressed(mimeType: string): boolean {
  return PRE_COMPRESSED_MIMES.has(mimeType)
}

// ─── Internal matching ───────────────────────────────────────────────────

function matchRule(header: Uint8Array, rule: MagicRule): boolean {
  const offset = rule.offset ?? 0
  const end = offset + rule.bytes.length

  // Not enough data for the primary match
  if (header.length < end) return false

  // Primary byte sequence
  for (let i = 0; i < rule.bytes.length; i++) {
    if (header[offset + i] !== rule.bytes[i]) return false
  }

  // Secondary byte sequence (compound check)
  if (rule.secondaryBytes && rule.secondaryOffset !== undefined) {
    const sEnd = rule.secondaryOffset + rule.secondaryBytes.length
    if (header.length < sEnd) return false
    for (let i = 0; i < rule.secondaryBytes.length; i++) {
      if (header[rule.secondaryOffset + i] !== rule.secondaryBytes[i]) return false
    }
  }

  return true
}

// ─── Pre-compressed MIME set ─────────────────────────────────────────────
//
// Built from the rules above. Used by `isPreCompressed()` for callers who
// already know the MIME type (e.g. from a Content-Type header) and want to
// skip the magic-byte detection step.

const PRE_COMPRESSED_MIMES = new Set<string>(
  MAGIC_RULES.filter((r) => r.preCompressed).map((r) => r.mime),
)
