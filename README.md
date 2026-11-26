# @dqa-ai-solutions/agent-runtime

The agent tier of the DQA runtime: a run follows a plan, and each step is done by a skill or an
executor. The host (`FieldApp`, `FieldSession`, the governed command-set), the orchestrator, the
step executors, the always-on tier and document ingestion. Ships the `dqa-fos` CLI. Stands on
`@dqa-ai-solutions/ontology-runtime` (and the core it re-exports); never on app-runtime or ui-runtime.

```bash
npm i @dqa-ai-solutions/core-runtime @dqa-ai-solutions/ontology-runtime @dqa-ai-solutions/agent-runtime
```

ES modules only.

## This repository

The source of `@dqa-ai-solutions/agent-runtime`. One package is published; the others are its parts and are bundled into it.

| Folder | | |
|---|---|---|
| `agent/agent-host` | inside | Agent host: FieldApp.load(pack).run(case), FieldSession, CommandSet, capability grants, trace ledger and the dqa-fos CLI. |
| `agent/agent-orchestrator` | inside | DQA workflow orchestrator: next-step decision and batching, event-sourced state, schema, gates, structured step outputs. |
| `agent/agent-os` | inside | DQA FieldOS OS-runtime: the always-on, non-LLM tier — work queue (single async front door), trigger/reaction engine, scheduler, driver port |
| `agent/agent-runtime` | **published** | The agent tier in one package: host, orchestrator, step executors, always-on tier, document ingestion |
| `agent/agent-steps` | inside | Agent-plan step executors over the ontology (read-sources · ingest · evaluate-rules · report · check), ingest payload validation, per-step skills and app executor loading. |
| `agent/ingest-documents` | inside | DQA document ingestion engine: PDF/DOCX/PPTX/XLSX/image → API-spreadable dqa-context.json. |

Examples, each installing only published names: `examples/fuel-review`, `examples/kyc-review`.

Companion repositories: [core-runtime](https://github.com/DQASolutions/core-runtime) · [ontology-runtime](https://github.com/DQASolutions/ontology-runtime) · [app-runtime](https://github.com/DQASolutions/app-runtime) · [ui-runtime](https://github.com/DQASolutions/ui-runtime).

## Build from source

```sh
npm install
npm run build
npm test
npm run lint
```

This repository builds against the published `@dqa-ai-solutions/core-runtime`, `@dqa-ai-solutions/ontology-runtime`, installed from the registry as dev dependencies.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
