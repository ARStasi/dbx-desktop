# Resolution

Resolved by [Azure notebook execution options](../../research/notebook-execution.md).

No documented interface provides one uniform, fully remote interactive notebook session across Azure serverless and standard shared compute for a custom desktop app. SQL Statement Execution is a direct path for warehouse SQL. Command Execution offers reusable remote contexts on classic all-purpose compute, but serverless is unsupported and the company's standard-compute configuration needs a live test. Databricks Connect supports serverless and standard compute for Spark operations, while general Python runs in the desktop process. SSH provides a remote interpreter on serverless and qualifying dedicated compute, but it is Beta, excludes shared compute, and its custom-client kernel integration still needs proof. Jobs can run whole notebooks but do not provide an interactive cell session.

The first version therefore needs a capability-aware compute picker and explicit execution semantics. It cannot promise identical behavior across warehouses, serverless, and standard compute until the chosen paths pass the documented company-workspace validation procedure.
