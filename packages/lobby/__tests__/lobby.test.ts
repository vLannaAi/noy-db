import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { Lobby, createLobby } from '../src/index.js'
import { generateULID } from '@noy-db/hub/kernel'

describe('Lobby', () => {
  it('wraps the Noydb instance whose vaults it orchestrates', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'correct-horse-battery-staple',
    })
    const lobby = createLobby(db)
    expect(lobby).toBeInstanceOf(Lobby)
    expect(lobby.noydb).toBe(db)
  })
})

describe('kernel boundary', () => {
  it('Lobby can consume the @noy-db/hub/kernel surface', () => {
    const id = generateULID()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
