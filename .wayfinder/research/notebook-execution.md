# Azure notebook execution options

Documentation research completed 2026-09-21 for [Establish notebook execution support across Azure compute](../issues/002-notebook-execution.md). Current primary documentation and first-party SDK references only. No company account, compute, credentials, or remote files were accessed.

## Finding

No reviewed interface establishes a uniform, fully remote, interactive notebook session across Azure serverless and standard/shared compute for this custom desktop app. SQL warehouse execution has a direct public API. Notebook execution needs different integration paths and targeted company-workspace validation before the product can promise support.

This is a documentation finding, not evidence that every unverified combination is impossible. The research question is answered by the support boundaries below; selecting the product's supported combinations remains a separate decision.

- **Confirmed** means explicitly documented, not tested in the company workspace.
- **Unsupported** means explicitly excluded, or the interface does not provide the requested execution model.
- **Live-unverified** means a relevant guarantee or custom-client integration still needs demonstration.
- **Retained state** means values survive successive cells in one live session. It does not imply survival across kernel/compute/app restart or a long disconnection.

## Execution matrix

| Interface | Standard/shared compute | Serverless notebook compute | SQL warehouse | Execution model |
| --- | --- | --- | --- | --- |
| Command Execution | Access-mode compatibility unverified; classic all-purpose clusters documented | Unsupported | Outside interface target | Remote commands in a reusable context. [API](https://databricks-sdk-py.readthedocs.io/en/stable/workspace/compute/command_execution.html) |
| Jobs | Remote notebook tasks on suitable classic compute; company configuration untested | Remote notebook tasks documented | SQL-only notebook tasks on pro/serverless warehouses | A task/run, not a cell-session API. [Jobs schema](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/api/latest/jobs), [compute guidance](https://learn.microsoft.com/en-us/azure/databricks/jobs/privileges) |
| Databricks Connect | Documented Shared/Assigned modes and supported versions | Documented compatible versions | Use SQL interfaces instead | Client-side general Python; remote Spark plans/UDFs. [Requirements](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-connect/requirements), [execution model](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-connect/) |
| SSH plus remote Jupyter | Shared clusters unsupported | Remote IDE workflow documented; custom client unverified | Outside interface target | Remote interpreter/kernel; dedicated classic is another target. [Azure SSH](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/ssh-tunnel) |
| SQL Statement Execution | Outside warehouse target | Outside warehouse target | Confirmed | SQL submission, status/results, cancellation. [Azure SQL API](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/sql-execution-tutorial) |

Do not confuse standard access mode, legacy No Isolation Shared, a cluster used by several people, and a job cluster reused by tasks. Task reuse does not identify access mode. Record the actual `data_security_mode` and runtime. [Standard compute overview](https://learn.microsoft.com/en-us/azure/databricks/compute/standard-overview)

## Command Execution

The official SDK documents Python, Scala, SQL, and R commands on running classic all-purpose clusters. It exposes context creation/destruction, command execution, status/results, and cancellation, with context and command IDs. This supports individual command submission. Serverless is explicitly excluded. The reference lacks a complete access-mode/runtime/permission matrix and idle/reconnection guarantee. No operation-specific Beta requirement is stated; the SDK site's general Beta title is not a support guarantee. [Command Execution reference](https://databricks-sdk-py.readthedocs.io/en/stable/workspace/compute/command_execution.html)

Live-unverified: assignments surviving successive requests, state after cancellation, context isolation/expiry, minimum permissions, and the company's exact standard/shared configuration. Reusable contexts make retained variables plausible, but the cited contract does not establish every lifetime guarantee.

The result model includes text, table, image/images, and errors. This does not establish arbitrary MIME bundles, widgets, streaming stdout, interactive charts, or complete Databricks `display()` fidelity. Validate actual payloads and limits before choosing renderers. [SDK result model](https://databricks-sdk-py.readthedocs.io/en/stable/dbdataclasses/compute.html#databricks.sdk.service.compute.ResultType)

Python and SQL are accepted languages. Cross-language variable sharing and `%sql` behavior in a Python context remain unverified. Test `spark.sql` and a temporary view inside the same Python context first. Do not assume independent SQL/Python contexts share a session.

## Jobs

The Jobs schema supports remote notebook tasks, existing classic clusters, and serverless environments. A notebook task can use a pro/serverless SQL warehouse, but non-SQL cells then fail. It can execute supported general notebook Python remotely, with sequential state within that run. Another task submission does not establish interpreter continuity. The schema provides no interactive cell-context handle. [Azure Jobs schema](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/api/latest/jobs)

The API/CLI supports submitting, monitoring, cancelling, exporting runs, and retrieving output. Cancellation is asynchronous. `get-run-output` returns notebook exit values through `dbutils.notebook.exit()` and at most the first 5 MB. Exporting a run is distinct from receiving live cell output. App tables/charts would require a tested output/artifact convention. Run records expire after 60 days. [Azure Jobs commands](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/cli/reference/jobs-commands)

Jobs can provide "Run notebook." They do not satisfy "run this cell, change a value, run the next cell in the same interpreter." Reusing compute across tasks does not change this finding.

## Databricks Connect

General Python executes on the client. DataFrame operations become remote Spark plans, with collected results materialized locally; supported UDFs run remotely. A local kernel can retain Python variables and call remote Spark, but that differs from all Python running in Databricks. [Execution model](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-connect/)

The official IDE integration demonstrates cells, `%sql` through `spark.sql`, Jupyter display, and tables converted to pandas. `%sh` and `%pip` run locally. These helpers belong to the IDE integration and do not automatically accompany the Connect library. This corrects an overly broad interpretation of the generic limitations: some notebook utilities can be supplied by integration code, including a documented SDK extra for widgets. [Azure IDE notebook integration](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/vscode-ext/notebooks)

Connect itself excludes `dataframe.display()`, RDDs, SparkContext, and several notebook utilities. A custom app must provide rendering and supported helpers. A successful query does not establish Databricks chart/UI fidelity. [Connect limitations](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-connect/python/limitations)

Remote-query cancellation uses tags and `interruptTag()` for Connect 14.0+. Query reattachment can survive client interruptions of up to five minutes. Serverless Connect 16.4+ offers best-effort Spark-session recovery after idle timeout, expiring after two days idle. That long-lived recovery is unsupported on standard/dedicated compute and does not restore a terminated local Python process. Stop Cell must address local Python and remote operations separately. [Interruptions and recovery](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-connect/queries)

## SSH and a remote kernel

Azure SSH is Beta. It documents remote Jupyter, selected globals, and `%sql`. Classic requires dedicated single-user compute, DBR 17.0+, Unity Catalog, and a policy permitting jobs. CLI 1.5.0+ is required. Troubleshooting specifies `CAN MANAGE` on the cluster. Windows IDEs need native Windows setup rather than WSL-side SSH configuration. [Azure SSH guide](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/ssh-tunnel)

`ssh connect` manages the SSH server/proxy and defaults to serverless; `--cluster` selects dedicated compute. `ssh setup` writes standard SSH configuration for classic targets. Named serverless connections can be reused; server shutdown defaults to ten minutes after the last disconnect. These are CLI entry points, not a notebook-session SDK. Custom-client kernel launch/discovery, interrupt/restart, reconnect, and output transport remain live-unverified. [Azure SSH commands](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/cli/reference/ssh-commands)

Jupyter's public protocol defines execution in a user namespace, stdout/stderr, MIME display data, errors, control messages, and heartbeat. A retained remote kernel could provide stateful cells and rich output. This is a candidate design, not proof that Azure exposes an authenticated Jupyter endpoint or supports our required forwarding. A prototype must establish transport/lifecycle using supported entry points. [Jupyter messaging specification](https://jupyter-client.readthedocs.io/en/stable/messaging.html)

`/Workspace` and `/Volumes` files survive restart; `/home`, `/root`, and other compute-local paths are ephemeral. Persistent notebook storage does not preserve interpreter memory. [Azure SSH guide](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/ssh-tunnel)

## SQL editor and Python/SQL boundaries

Statement Execution targets a warehouse and returns IDs, status, schema/results, and cancellation. It supports polling and chunked data; inline results are limited to 25 MiB. Charts can be built by the app from returned data. Warehouse execution supplies no Python namespace. [Azure SQL tutorial](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/sql-execution-tutorial)

The web notebook supports warehouse SQL sessions and temporary state. That does not establish a public Python notebook-session API. Web serverless snapshot/restore likewise does not establish recovery for Command Execution or a custom SSH client. [Azure notebook compute behavior](https://learn.microsoft.com/en-us/azure/databricks/notebooks/notebook-compute)

Proposed semantics to validate: execute SQL within the same Spark session for Python-to-SQL temporary-view interaction; treat warehouse queries as a separate execution target. Crossing targets should never imply shared variables or temporary views.

## Requirements affecting the product

| Area | Documented constraint or validation boundary |
| --- | --- |
| Compute identity | Confirm access mode and runtime, not the informal "shared" name. Standard isolates users and has runtime-specific restrictions. [Overview](https://learn.microsoft.com/en-us/azure/databricks/compute/standard-overview) |
| Classic permissions | `CAN ATTACH TO` permits notebook attachment; start/restart requires `CAN RESTART`; driver logs generally require `CAN MANAGE`. These general ACLs do not establish Command Execution's minimum permission. [Compute ACLs](https://learn.microsoft.com/azure/databricks/security/auth-authz/access-control/) |
| Jobs permissions | `CAN MANAGE RUN` triggers/cancels existing jobs. Execution uses Run as identity and its data/compute/notebook grants. Submitted runs have distinct ACL behavior. Display actual execution identity. [Jobs privileges](https://learn.microsoft.com/en-us/azure/databricks/jobs/privileges) |
| Connect compatibility | Unity Catalog, compatible Python/Connect/runtime versions, and supported access mode are required. Serverless uses environment-version compatibility. Several early serverless combinations are now unsupported; do not use the historical minimum as the product minimum. OAuth U2M uses prior CLI login. [Current requirements](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-connect/requirements) |
| Connect network | gRPC over HTTP/2; proxies/custom TLS roots may need configuration. REST success does not verify this path. [Network configuration](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/databricks-connect/advanced) |
| SSH network | HTTPS/WebSockets, not inbound port 22. Corporate proxies must allow upgrades; downloads and marketplaces can need allowlisting. [SSH guide](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/ssh-tunnel) |
| REST network/auth | Authenticated per-workspace Azure endpoint and company-approved network access. Login alone does not establish resource permissions. [Azure SQL API setup](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/sql-execution-tutorial) |
| Preview boundaries | Optional SSH workspace base environments and Git CLI integration require their respective previews. [SSH guide](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/ssh-tunnel) The base-environment flag supports environment version 4 or below, not version 5. [CLI options](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/cli/reference/ssh-commands) |
| Language/runtime scope | Serverless notebooks exclude Scala/R and RDD APIs and restrict dependencies. Standard also excludes R/RDDs and restricts filesystem/network access. These limits do not relocate a remote Python interpreter to the desktop. [Serverless limits](https://learn.microsoft.com/en-us/azure/databricks/compute/serverless/limitations), [standard limits](https://learn.microsoft.com/en-us/azure/databricks/compute/standard-limitations) |

## Minimal company-workspace validation

Proposed procedure only. Use nonsensitive fixtures in a designated test workspace under the company's normal authorization for remote fixtures and compute. Do not terminate or reconfigure shared production compute for recovery tests.

1. **Record the environment.** Capture cloud/region, Windows version, CLI/SDK versions, compute ID/type, `data_security_mode`, DBR/serverless environment version, Unity Catalog status, identity/grants, and proxy/VPN conditions. Identify a warehouse, standard all-purpose target, and serverless. Dedicated compute is optional for comparison.
2. **Verify the SQL baseline.** Execute `SELECT 1 AS value`; verify schema/results and an invalid-SQL error. Cancel a bounded query on approved test compute and poll its terminal status. Use a small row limit to inspect truncation. Test SQL session state separately if required.
3. **Test Command Execution on standard first.** Create a Python context. Run `counter = 41`, then `counter += 1; print(counter)` separately and require `42`. Return a bounded Spark table, create a temporary view, and query it with `spark.sql` in that context. Probe a separate SQL context before depending on shared state. Capture exact rejection details if creation fails.
4. **Verify cell outputs.** Test an exception, stdout/stderr, small table, static chart, and any required interactive chart. Inspect payload types, ordering, truncation, and tracebacks. Unsupported rendering must be visible, not silently dropped.
5. **Verify cancellation and state.** Cancel a bounded sleep, confirm termination remotely, then read `counter`. Separately cancel a bounded Spark operation. For Connect, verify local interruption separately from `interruptTag`. For SSH/Jupyter, test interrupt, restart, and changed-kernel detection.
6. **Disconnect without replay.** Save operation/context/kernel IDs, briefly disconnect, and reconnect. Observe continued execution and recovery of status, output, and variables. Repeat after client restart. Never rerun merely because a response was lost. Test compute restart only on isolated approved compute; require a clear state-lost indication.
7. **Prove serverless custom-client execution.** First validate documented SSH/Jupyter. Then demonstrate the smallest custom client through supported CLI/SSH and public kernel protocol only. Require stateful cells, Python/SQL interaction, outputs, cancel, reconnect, cleanup, and confirmed execution location. Launching an external IDE alone does not pass the in-app requirement.
8. **Validate Jobs separately.** Save a tiny remote notebook and submit it. Verify Run as identity, output, errors, and cancellation. Start another run and confirm it is not presented as continuation of the first interpreter. Clean up only test-created fixtures/sessions.

Record **pass**, **explicitly unsupported**, **permission/policy denied**, **network blocked**, or **inconclusive** for each combination, with exact configuration and sanitized response. A workspace denial is not a platform-wide prohibition. Dedicated success does not prove standard/shared support.

## Decision consequences

- The compute picker needs capability-aware choices. Warehouses, Connect sessions, and remote Python kernels offer different behavior.
- Fully remote interactive Python on company standard/shared compute remains the principal validation gap. Test Command Execution first; SSH cannot provide that combination.
- Serverless remote Python is documented through SSH for IDEs. Prove the in-app kernel integration before committing.
- Connect requires acceptance of local general Python. It cannot silently replace the stated remote-execution requirement.
- Jobs support whole-notebook runs and do not resolve interactive-session feasibility.
- Proposed compute switching starts a new session unless state migration is demonstrated. Cached outputs should identify their original target.

These are research implications and proposed validation gates. They do not select an architecture or reduce the user-confirmed scope.
