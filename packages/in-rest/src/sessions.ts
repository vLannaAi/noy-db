import type { Noydb } from '@noy-db/hub'

interface Session {
  db: Noydb
  expiresAt: number
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly ttlMs: number

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000
  }

  create(db: Noydb): string {
    const token = crypto.randomUUID()
    this.sessions.set(token, { db, expiresAt: Date.now() + this.ttlMs })
    return token
  }

  /**
   * Look up a session and refresh its sliding-window TTL. Call from
   * auth-guarded routes that are treated as "activity".
   */
  get(token: string): Noydb | null {
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return null
    }
    session.expiresAt = Date.now() + this.ttlMs
    return session.db
  }

  delete(token: string): void {
    this.sessions.delete(token)
  }

  /**
   * Non-refreshing existence check. Used by polling endpoints like
   * `GET /sessions/current` that should not extend the session merely
   * by being queried.
   */
  peek(token: string): boolean {
    const session = this.sessions.get(token)
    if (!session) return false
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return false
    }
    return true
  }
}
