import React from 'react'
import { render } from 'ink'
import { createInspector } from '@noy-db/in-devtools'
import { createNoydb } from '@noy-db/hub'
import type { NoydbOptions } from '@noy-db/hub'
import { toMeter } from '@noy-db/to-meter'
import { App } from './App.js'
import { loadOptionsFromFile, resolvePassphrase } from './load-options.js'
import { promptMasked } from './prompt-passphrase.js'

function fail(msg: string): never {
  process.stderr.write(`noydb-inspect: ${msg}\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const configPath = argv.find((a) => !a.startsWith('--'))
  if (!configPath) fail('usage: noydb-inspect <config.js|mjs> --vault=<name> [--passphrase=…]')
  const vaultFlag = argv.find((a) => a.startsWith('--vault='))
  if (!vaultFlag) fail('missing --vault=<name>')
  const vaultName = vaultFlag.slice('--vault='.length)

  let passphrase = resolvePassphrase(argv, process.env)
  if (passphrase === undefined) {
    if (!process.stdin.isTTY) fail('no passphrase — pass --passphrase=… or set NOYDB_PASSPHRASE')
    passphrase = await promptMasked('Passphrase: ')
  }

  let baseOptions: NoydbOptions
  try {
    baseOptions = (await loadOptionsFromFile(configPath)) as NoydbOptions
  } catch (err) {
    fail(`failed to load config "${configPath}": ${err instanceof Error ? err.message : String(err)}`)
  }

  let meter
  if (argv.includes('--meter') && baseOptions.store) {
    const metered = toMeter(baseOptions.store)
    baseOptions = { ...baseOptions, store: metered.store }
    meter = metered.meter
  }

  // Passphrase lives in NoydbOptions.secret — openVault(name) picks it up internally.
  const options: NoydbOptions = { ...baseOptions, secret: passphrase }
  const db = await createNoydb(options)

  let vault
  try {
    vault = await db.openVault(vaultName)
  } catch (err) {
    fail(`failed to open vault "${vaultName}": ${err instanceof Error ? err.message : String(err)}`)
  }

  const inspector = createInspector(db, meter ? { meter } : undefined)
  const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }
  const { waitUntilExit } = render(
    <App inspector={inspector} vault={vault} vaultName={vaultName} initial={initial} />,
  )
  await waitUntilExit()
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
