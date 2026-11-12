# Local decision tracker

Start with [Define the first Azure Databricks desktop experience](issues/001-map.md).

This folder is the portable planning record. Copy the whole project folder to the Windows machine to continue. No application has been implemented and no Databricks account has been accessed.

## Wayfinding operations

This repository has no configured external issue tracker. Each file under `issues/` is a local issue; its `id` is its stable identity. Front matter stores its title, status, labels, parent, assignee, and blocking relationships. Always refer to issues by linked title in human-facing text.

- Map: the issue labeled `wayfinder:map`.
- Children: issues whose `parent` equals the map's id.
- Claim: set `assignee` to the developer driving the work before beginning. Open issues with a non-null assignee are claimed.
- Blocking: this tracker has no native dependency UI. The `blocked_by` field is the dependency convention. An issue is unblocked only when every listed issue is closed.
- Frontier query: read the child issue headers in id order and select `status: open`, `assignee: null`, and no open blockers. `rg -n '^(id|title|status|parent|assignee|blocked_by):' .wayfinder/issues` displays the fields without loading the issue bodies.
- Resolution: write a dated resolution comment under `comments/<issue-id>/`, link it from the issue, set the issue to closed, and add a linked one-line gist to the map's Decisions so far. Do not put the answer into the question.
- New issues: allocate the next unused id, create issues first, then add their blocking references in a second pass.
- Scope exclusions: close the issue and link it only from the map's Out of scope section.

## Current workflow limitations

Wayfinder, grilling, domain-modeling, research, and unslop are installed. This local tracker follows the supplied wayfinder format.

There is no Git repository in this directory, so research branches have not been created. Supporting evidence is stored under `research/` and linked from issue comments. Once a Git repository is established, use the research branch workflow required by wayfinder for subsequent research.

The map remains open. Charting does not authorize implementation or resolve human decisions on the user's behalf.
