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

  has(token: string): boolean {
    return this.get(token) !== null
  }
}
