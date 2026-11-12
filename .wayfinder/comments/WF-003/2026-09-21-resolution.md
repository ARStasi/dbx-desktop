# Resolution

Resolved by [Azure desktop interface inventory](../../research/azure-interfaces.md).

Azure Databricks documents suitable interfaces for user authentication, resource discovery, SQL submission and results, workspace notebook storage, and Unity Catalog volume browsing and transfers. A standalone desktop client can use a public OAuth client with PKCE if the company registers and permits it, or an architecture can reuse supported CLI and SDK authentication. The Files API supports the requested in-app volume experience but remains Public Preview and caps one upload at 5 GiB.

Notebook storage and execution are separate. Workspace import and export do not provide an interactive session, and the APIs do not document atomic compare-and-save behavior. Company compatibility still requires live checks for SSO, network policy, permissions, preview acceptance, notebook round trips, concurrent edits, transfers, and warehouse result handling.
