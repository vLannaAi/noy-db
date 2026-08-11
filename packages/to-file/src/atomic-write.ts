import { writeFile, unlink, rename } from 'node:fs/promises'

/** Disambiguates concurrent temp files within a single process. */
let tmpCounter = 0

/**
 * Write `content` to `path` without ever exposing a partial file under
 * that name: stage the bytes in a sidecar, then `rename` over the target.
 *
 * `rename(2)` is atomic within a directory on POSIX, and `fs.rename`
 * replaces the target atomically on Windows, so a reader sees either the
 * complete old file or the complete new one — never a truncation. This
 * matters most on the network drives `to-file` advertises: a laptop losing
 * Wi-Fi mid-write to a mounted share would otherwise leave a `{id}.json`
 * that no longer parses, which fails `loadAll()` for the whole vault
 * rather than for the one record.
 *
 * The sidecar carries pid + a process-local counter so concurrent writes
 * (same process, or several machines on one share) never collide. Its name
 * does not end in `.json`, which is what keeps an orphan from a crashed
 * process invisible to `list`, `listPage` and `loadAll` — pinned by a test,
 * since those filters are what make the sidecar safe.
 *
 * Atomicity of *visibility* only. Surviving a power cut additionally needs
 * the file and its directory fsynced, which is deliberately not paid per
 * record here.
 */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`
  try {
    await writeFile(tmp, content)
    await rename(tmp, path)
  } catch (err) {
    // Leave no residue behind on our own failure path.
    await unlink(tmp).catch(() => {})
    throw err
  }
}
