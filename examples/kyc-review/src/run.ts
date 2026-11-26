// node examples/kyc-review/dist/run.js  — drives the cases like a session.
import { runCase, cases } from './app.js'

async function main() {
  for (const c of cases) {
    const r = await runCase(c)
    console.log(`\n══════════ ${c.name} ══════════`)
    console.log(`  status: ${r.status}  ·  agent steps: ${r.agentSteps}  ·  compliance gate: ${r.gateApproved ? 'approved' : 'skipped (clean)'}`)
    console.log('  ┌─ decision ' + '─'.repeat(40))
    console.log(r.report.split('\n').map((x) => '  │ ' + x).join('\n'))
    console.log('  └' + '─'.repeat(51))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
