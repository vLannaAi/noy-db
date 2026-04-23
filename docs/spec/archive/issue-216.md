# Issue #216 — feat(in-ai): @noy-db/in-ai — LLM function-calling adapter with ACL-scoped tool definitions

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · Integrations (@noy-db/in-*)
- **Labels:** type: feature

---

Expose noy-db collections as function-calling tools for LLM agents (OpenAI, Anthropic, local models via ollama). Each declared tool is ACL-scoped — the LLM never gets a DEK, only a pre-authorized function handle. Integrates with the existing plaintextTranslator hook so LLM-mediated operations are auditable. Supports structured outputs back into noy-db via schema validation (Standard Schema v1).
