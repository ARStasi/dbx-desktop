---
id: WF-008
title: Validate the chosen paths in the company workspace
status: open
labels: ["wayfinder:task"]
parent: WF-001
assignee: null
blocked_by: ["WF-004"]
---

## Question

Can the notebook, SQL, storage, and volume paths selected for the first version operate under the real company's Azure Databricks configuration and Windows controls?

Run the minimal validation procedures linked from [Establish notebook execution support across Azure compute](../research/notebook-execution.md) and [Verify Azure workspace, SQL, and volume APIs](../research/azure-interfaces.md) from the company-managed Windows environment. Use only an approved test workspace, test compute, nonsensitive fixtures, and ordinary developer permissions. Record exact compute access modes and versions, OAuth policy, VPN/proxy behavior, permissions, preview availability, notebook state and output behavior, cancellation and reconnection, notebook round trips, and volume transfers.

This task records pass, explicitly unsupported, policy denied, network blocked, or inconclusive for each selected combination. It does not expand the product scope or begin implementation.
