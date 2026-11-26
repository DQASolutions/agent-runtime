// HTTP transport — a thin adapter over the SAME `Kernel.emitEvent` the CLI
// calls. This is the service-skeleton: the always-on face that lets the outside
// world POST data without a session running (os-runtime-design.md §2, DoD E/F).
// Nothing kernel-specific lives here — it only translates HTTP → IngressInput.

import http from 'node:http'
import type { Kernel, IngressInput } from '../ports/transport.js'

export interface EventServerOpts {
  /** Optional read-snapshot exposed at `GET /state` (observability / verification). */
  snapshot?: () => Promise<unknown>
}

/** An HTTP server exposing `POST /events` (ingress) + `GET /health` [+ `GET /state`]. */
export function createEventServer(kernel: Kernel, opts: EventServerOpts = {}): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.method === 'GET' && req.url === '/state' && opts.snapshot) {
      void (async () => {
        const snap = await opts.snapshot!()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(snap))
      })()
      return
    }
    if (req.method === 'POST' && req.url === '/events') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        void (async () => {
          try {
            const input = JSON.parse(body) as IngressInput
            const { intentId } = await kernel.emitEvent(input)
            res.writeHead(202, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ intentId }))
          } catch (err) {
            res.writeHead(400, { 'content-type': 'text/plain' })
            res.end(String(err))
          }
        })()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
}
