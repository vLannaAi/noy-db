/// <reference types="@cloudflare/workers-types" />
/**
 * Worker entry point — required by wrangler.jsonc but not actually
 * exercised. vitest-pool-workers loads this file as the Worker's
 * `main`, so it must be a valid module that exports a default
 * `fetch` handler. The `cloudflare:test` runner is what invokes the
 * showcase 63 test inside the workerd runtime; this entry point just
 * keeps wrangler happy at boot.
 *
 * If a future "63b — deployed Worker" showcase wants to run the
 * topology workflow remotely, a real `fetch` handler can replace
 * this stub.
 */

export interface WorkerEnv {
  readonly DB: D1Database
  readonly BUCKET: R2Bucket
}

export default {
  async fetch(_req: Request, _env: WorkerEnv): Promise<Response> {
    return new Response('noy-db showcase Worker — stub, see vitest tests', {
      headers: { 'content-type': 'text/plain' },
    })
  },
}
