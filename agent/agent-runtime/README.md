# @dqa-ai-solutions/agent-runtime

The agent tier of the DQA runtime: a run follows a plan, and each step is done by a skill or an
executor. The host (`FieldApp`, `FieldSession`, the governed command-set), the orchestrator, the
step executors, the always-on tier and document ingestion. Ships the `dqa-fos` CLI. Stands on
`@dqa-ai-solutions/ontology-runtime` (and the core it re-exports); never on app-runtime or ui-runtime.

```bash
npm i @dqa-ai-solutions/core-runtime @dqa-ai-solutions/ontology-runtime @dqa-ai-solutions/agent-runtime
```

ES modules only.
