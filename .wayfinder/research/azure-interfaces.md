# Azure desktop interface inventory

Research for **Verify Azure workspace, SQL, and volume APIs**, refreshed 2026-09-21 against official Azure Databricks documentation and Databricks API references. This replaces the preliminary inventory.

The interfaces cover sign-in, discovery, SQL execution, notebook content storage, and volume transfers. Notebook import/export establishes a storage path only; interactive execution is a separate investigation.

**Confirmed** means explicitly documented. **Inferred** means a conclusion from documented interfaces, not a live result. **Live-unverified** applies throughout: no company workspace, credentials, customer data, or remote writes were involved.

| Capability | Candidate interface | Constraints relevant to planning |
| --- | --- | --- |
| Sign in as the user | OAuth U2M with CLI/SDK unified authentication, or custom public OAuth client with PKCE | Reusing an authenticated CLI and registering the app's own OAuth integration are different routes. Custom registration involves account administration. |
| Discover compute | Warehouses and Clusters APIs; serverless capability/permission checks | Discoverability does not establish execution compatibility. Investigate how to show only usable choices. |
| Run SQL | Statement Execution API | Select warehouse, submit asynchronously, poll, fetch chunks, cancel. Inline results have a 25 MiB limit; external result downloads require their own storage reachability. |
| Read and save notebooks | Workspace list/import/export APIs | Content round-trip is separate from interactive execution. Base64 import/export has a documented 10 MB limit; verify format fidelity. |
| Discover volumes | Unity Catalog volume APIs | Catalog/schema hierarchy and user privileges determine accessible results. |
| Browse and transfer volume files | Files API | Public Preview; uploads up to 5 GiB. Explicit overwrite handling and pagination are needed. |

## Source overview

- [Azure OAuth U2M](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/auth/oauth-u2m) and [custom OAuth integrations](https://learn.microsoft.com/en-us/azure/databricks/integrations/enable-disable-oauth): browser-based user authorization, refresh, and PKCE. A public desktop client should not embed a client secret. The company must permit the selected authentication route.
- [Azure CLI authentication](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/cli/authentication): Windows and macOS authentication support. Whether the app requires, bundles, or avoids the CLI is an architecture decision.
- [Azure SQL execution](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/sql-execution-tutorial): statement submission, status, results, and cancellation. Asynchronous submission can avoid blocking the desktop interface. Do not send Databricks authorization headers to external signed storage URLs.
- [Workspace import](https://docs.databricks.com/api/workspace-objects/v1/import) and [export](https://docs.databricks.com/api/workspace-objects/v1/export): notebook formats and limits. Import offers overwrite without a documented version precondition. Inference: investigate conflict protection before promising safe simultaneous edits in the browser and desktop app.
- [Files API](https://docs.databricks.com/api/files/v2/file): raw-byte upload/download and directory listing. Upload defaults to overwrite if unspecified, so a client should explicitly request no overwrite until replacement is intended. This is a planning recommendation, not a resolved UX decision.
- [Volume API](https://docs.databricks.com/api/uc-volumes/v1/get-volume): discovery within catalogs/schemas. Paginated responses can be empty while still carrying a continuation token.
- [Azure volume privileges](https://learn.microsoft.com/en-us/azure/databricks/volumes/privileges): `USE CATALOG`, `USE SCHEMA`, and `READ VOLUME` for reading; writes additionally require `WRITE VOLUME`.

## Compute dependencies and discovery

"Compute" here means a user-selected warehouse or notebook cluster, not Databricks' underlying managed services.

| Operation | Running customer compute | Evidence and limits |
| --- | --- | --- |
| OAuth sign-in/refresh | None specified | Browser/token flow has no compute target. [U2M](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/auth/oauth-u2m) |
| Warehouse discovery | No startup required by documented operation | `GET /api/2.0/sql/warehouses` includes stopped warehouses, state, and serverless configuration. Lists resources accessible to the user. [Warehouses API](https://docs.databricks.com/api/warehouses/v1/list-warehouses) |
| Classic compute discovery | No startup required by documented operation | `GET /api/2.1/clusters/list` includes pinned/active clusters and clusters terminated within 30 days. [Clusters API](https://docs.databricks.com/api/clusters/v2/cluster) |
| Workspace list/read/save | Independence inferred | `list`, `get-status`, `export`, and `import` have no cluster/warehouse target or startup step. [Workspace API](https://docs.databricks.com/api/workspace-objects/v1/import) |
| Catalog/schema/volume discovery | Independence inferred | Unity Catalog metadata APIs have no compute target. Results are privilege-filtered. [Catalogs](https://docs.databricks.com/api/uc-catalogs/v1/catalog), [schemas](https://docs.databricks.com/api/uc-schemas/v1/schema), [volumes](https://docs.databricks.com/api/uc-volumes/v1/get-volume) |
| Files API list/upload/download | Independence inferred | Azure documents direct HTTP transfers without compute selection. SQL or notebook file utilities would instead require execution. [Azure volume file operations](https://learn.microsoft.com/en-us/azure/databricks/volumes/volume-files) |
| SQL execution | Warehouse required | Statement submission specifies `warehouse_id`; `PENDING` can mean waiting for the warehouse. [Statement API](https://docs.databricks.com/api/statement-execution/v1/statement-execution) |
| Completed result retrieval | No new execution specified; shutdown behavior live-unverified | Uses statement/chunk endpoints or temporary storage URLs. Do not assume indefinite availability after compute stops. [Statement API](https://docs.databricks.com/api/statement-execution/v1/statement-execution) |

Confirmed: schema and volume pagination can return an empty page with `next_page_token`; continue until the token is absent. Catalog/schema APIs can expose selective metadata with `include_browse`, which does not grant data access. Warehouses and clusters also have paginated listing. [Schemas API](https://docs.databricks.com/api/uc-schemas/v1/schema), [Volumes API](https://docs.databricks.com/api/uc-volumes/v1/get-volume), [Warehouses API](https://docs.databricks.com/api/warehouses/v1/list-warehouses), [Clusters API](https://docs.databricks.com/api/clusters/v2/cluster)

Inferred: a compute picker must apply the chosen execution method's compatibility rules after discovery. A classic cluster list does not establish serverless notebook availability. A serverless SQL warehouse is also not proof of serverless notebook access.

## Company authentication and permissions

Confirmed: supported CLI/SDK unified authentication and a custom OAuth client are distinct deployment routes. Tools implementing their own OAuth flow must use their own enabled client ID. Custom integration setup is account-admin managed and specifies redirects, scopes, and token lifetime. Public clients do not require a confidential-client secret. Inferred: distribute a public PKCE client without an embedded reusable secret, or use supported CLI/SDK authentication. Do not copy token-cache files. [U2M](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/auth/oauth-u2m), [Custom OAuth integrations](https://learn.microsoft.com/en-us/azure/databricks/integrations/enable-disable-oauth)

Confirmed: CLI authentication documentation explicitly covers Windows Credential Manager and macOS Keychain storage from CLI 1.0.0. This establishes a documented cross-platform route, not a decision to bundle that version. Live-unverified: the installed CLI/SDK combination, corporate SSO, redirect handling, and permission to install/register this client. [CLI authentication](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/cli/authentication)

Confirmed: notebook viewing uses `CAN VIEW` in the UI and `CAN READ` in the Permissions API; editing needs `CAN EDIT`. Creation needs appropriate destination-folder permissions. Warehouse `CAN USE` allows query execution. Seeing a warehouse does not prove it can be used. Cluster attachment/restart/management are distinct permissions. [Azure ACLs](https://learn.microsoft.com/en-us/azure/databricks/security/auth/access-control/)

Confirmed: Statement Execution callers need Databricks SQL entitlement and permissions for their queried data. Ordinary Unity Catalog table reads need `USE CATALOG`, `USE SCHEMA`, and `SELECT`. Volume file reads/listing need the two parent usage privileges and `READ VOLUME`; writing/deleting adds `WRITE VOLUME`. Provisioning or managing a volume itself has additional privileges. [Azure SQL tutorial](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/sql-execution-tutorial), [Azure Unity Catalog permission concepts](https://learn.microsoft.com/en-us/azure/databricks/data-governance/unity-catalog/access-control/permissions-concepts), [Azure volume privileges](https://learn.microsoft.com/en-us/azure/databricks/volumes/privileges)

## Result, format, and concurrency limits

Confirmed: SQL submit/status/cancel/chunk endpoints support asynchronous operation. Row/byte limits report truncation. Results become unavailable in `CLOSED` state. Azure external result links are SAS URLs with expiration within 15 minutes; a fresh link can be requested while the result remains available. Inferred: retain statement IDs for reconnect handling, display truncation, and avoid treating the statement service as permanent result storage. SQL execution also does not decide where the editable SQL document is saved. [Statement API](https://docs.databricks.com/api/statement-execution/v1/statement-execution)

Confirmed: Workspace import defaults to `overwrite=false`; an existing path then fails. Overwrite replaces content and has no documented version/ETag precondition. The base64 `content` transport limits import/export to 10 MB. This API has no documented atomic compare-and-save operation. Inferred: re-exporting before save can detect some changes but leaves a race before unconditional overwrite. Safe simultaneous web/desktop editing remains a design constraint. [Workspace API](https://docs.databricks.com/api/workspace-objects/v1/import)

Confirmed: Azure's general notebook limits separately allow IPYNB import/export up to 100 MB, while source/DBC/HTML/R Markdown remain at 10 MB. This does not prove the base64 API accepts 100 MB. Live-unverified: which transport supports larger IPYNB files. Use the selected endpoint's limit until tested. [Notebook limitations](https://learn.microsoft.com/en-us/azure/databricks/notebooks/notebook-limitations)

Confirmed: source notebooks use comments to mark cell boundaries; HTML/IPYNB/DBC exports can contain outputs, while source lacks that same output representation. Inferred: validate markdown, mixed-language cells, outputs, metadata, and environment declarations before claiming round-trip fidelity. [Notebook import/export](https://learn.microsoft.com/en-us/azure/databricks/notebooks/notebook-export-import)

Confirmed: Files API upload takes raw bytes. Downloads support byte ranges and `If-Unmodified-Since`, which is a download condition, not an upload guard. Directory pages contain at most 1,000 entries. No conditional replacement token or resumable upload session is documented here. Inferred: do not promise conflict-free replacement or resumable uploads. [Files API](https://docs.databricks.com/api/files/v2/file)

## Corporate network implications

Confirmed: IP access lists constrain workspace REST APIs as well as the UI. Context-based ingress can distinguish identity, request type, and network source. Therefore browser access alone is insufficient evidence of desktop API access. [IP access lists](https://learn.microsoft.com/en-us/azure/databricks/security/network/front-end/ip-access-list), [Context-based ingress](https://learn.microsoft.com/en-us/azure/databricks/security/network/front-end/context-based-ingress)

Confirmed: inbound Private Link needs appropriate endpoints, routing, and DNS; browser authentication has its own private-connectivity configuration. Inferred: validate on the actual corporate VPN/proxy/DNS/certificate configuration for Windows and macOS. [Azure inbound Private Link](https://learn.microsoft.com/en-us/azure/databricks/security/network/front-end/front-end-private-connect)

Confirmed: SQL external result downloads reach Azure storage directly and need separate network reachability. Do not forward Databricks authorization headers there. External-link disposition can be disabled through Databricks support. [Azure SQL tutorial](https://learn.microsoft.com/en-us/azure/databricks/dev-tools/sql-execution-tutorial)

## Live validation before company compatibility claims

These follow-up checks have not run. They do not prevent concept and architecture decisions based on the documented capabilities.

1. Exercise the chosen authentication route with a normal company user on Windows and macOS, including refresh, sign-out, VPN loss, and denied access.
2. With customer compute stopped, discover resources, export a notebook, and transfer a disposable volume file. Record whether any compute starts.
3. In an approved test location, round-trip representative notebook formats and test simultaneous browser edits, overwrites, renames, and larger IPYNB transport.
4. On an approved warehouse, test startup/wait behavior, SQL submission/cancel/reconnect, chunked and truncated results, external-link access, and retention after warehouse shutdown.
5. Test limited-permission users, pagination, duplicate filenames, interrupted transfers, and Files API preview availability. Admin-only success is insufficient.

Documentation supports in-app SQL, notebook storage, and volume transfers. Remaining gates are live company access, preview acceptance, file/notebook fidelity and concurrent saves, plus the separately researched notebook execution path.
