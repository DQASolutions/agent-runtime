# Dogfood: KYC/AML onboarding review (declarative)

A **declarative app on the DQA FieldOS kernel**. The app is *data*; the kernel
loaders + runner do the work. No domain driver, no imperative install, no
per-step code.

## The app = declarations

```
app/
  ontology.json    # entity + relationship types
  rules.json       # R-KYC-DOC · R-PEP · R-STRUCTURING (+ onFail intent)
  workflow.json    # map → screen → compliance-signoff(gate) → decide
src/
  app.ts           # ~4 lines: FieldApp.load(app) + app.run(case)
  run.ts           # entry point + case data
```

The workflow steps are `uses:`-bound to kernel executors — `ingest`,
`evaluate-rules`, `report` — so the **engine** runs them (via `WorkflowRunner`);
the app never hand-drives `next/done` and never calls `defineType`/`registerRule`
itself (the kernel loaders do).

## Run

```bash
npm run build
node examples/kyc-review/dist/run.js     # two cases
npm test -w @dqa-ai-solutions/example-kyc-review
```

- **Shell Holdings Ltd** (no docs · PEP · 70m inflow) → 5 findings → compliance
  gate → approved; 6 governed writes audited.
- **Acme Trading Co** (docs · not PEP · 5m) → 0 findings →
  `when: screen.flagged == true` false → gate skipped → clean.

## Kernel pieces this exercises (all built in the kernel, none in the app)

- declarative loaders (`@dqa-ai-solutions/ontology-loader`: `loadOntology` / `loadRules`)
- the `WorkflowRunner` + `StepExecutor` registry (`@dqa-ai-solutions/agent-orchestrator`)
- ontology executors `ingest` / `evaluate-rules` / `report`
- the governed write door + audit (`@dqa-ai-solutions/ontology-governance`)
- kinetic ontology: Actions, neutral `evaluateRules → RuleResult`, AGGREGATE
  (`@dqa-ai-solutions/ontology-sdk`)

> A production app would live in its own repo and ship the same files; the
> only code an app may legitimately add is SPI (custom Function/Action bodies,
> connectors/extractors). This dogfood needs none.
