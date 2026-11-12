---
id: WF-006
title: Choose remote-save and connection-loss behavior
status: open
labels: ["wayfinder:grilling"]
parent: WF-001
assignee: null
blocked_by: ["WF-002", "WF-003"]
---

## Question

How should users distinguish edits still in the desktop app from content saved to Databricks, and what should they see and be allowed to do after a connection is lost?

The user has already ruled out full offline operation and accepts a disconnected view of previously visible content. Resolve preservation of unsaved edits, save acknowledgement, remote changes made elsewhere, and reconciliation after reconnect. Determine how an ongoing remote run is represented when its status cannot be fetched; losing the connection must not be represented as confirmed cancellation or completion.
