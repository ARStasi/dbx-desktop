---
id: WF-002
title: Establish notebook execution support across Azure compute
status: closed
labels: ["wayfinder:research"]
parent: WF-001
assignee: research-notebook-execution
blocked_by: []
---

## Question

Which supported public interfaces can provide an in-app notebook session on paid Azure Databricks for serverless and shared compute, and what restrictions would each impose on the product?

Compare Command Execution, Jobs, Databricks Connect, and SSH. Distinguish whole-notebook execution from interactive cells, and distinguish remote Spark operations from arbitrary Python running remotely. Establish support for retained variables between cells, Python and SQL interaction, tables/charts/errors, cancellation, and session lifecycle. Record access-mode, runtime, permission, network, and preview requirements.

Do not infer a public notebook-session API from a feature in the web editor. Mark unsupported or unverified cases explicitly. Include a minimal validation procedure for the company workspace, without accessing it during documentation research.

## Comments

- [Preliminary documentation evidence, 2026-09-20](../comments/WF-002/2026-09-20-preliminary.md). This is not a resolution.
- [Resolution, 2026-09-21](../comments/WF-002/2026-09-21-resolution.md)
