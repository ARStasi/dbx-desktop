---
id: WF-004
title: Define notebook and SQL session behavior
status: open
labels: ["wayfinder:grilling"]
parent: WF-001
assignee: null
blocked_by: ["WF-002"]
---

## Question

Given the verified execution options, what notebook and SQL interaction must the first version deliver to feel like working in Databricks from a desktop?

Resolve cell-by-cell execution versus whole-notebook runs, state retained between cells, initial languages and output types, compute selection and switching, and the acceptable behavior when a requested compute type cannot support a feature. The user must choose any compromise to the desired serverless and shared-compute support; do not silently substitute batch jobs or local Python for remote interactive notebooks.
