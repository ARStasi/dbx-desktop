"""Runs notebook cells for dbx-desktop in a local Python process.

The app starts one of these per notebook on serverless compute. It talks JSON
lines: requests arrive on stdin, replies leave on the original stdout. Cell
code runs in one shared namespace, so variables carry from cell to cell.
`spark` is a Databricks Connect session on serverless compute, so Spark and
SQL work runs in Databricks; plain Python runs here.

Requests:  {"op": "run", "id": 1, "code": "..."}  and  {"op": "cancel", "id": 1}
Replies:   {"ready": true} once, then one result per run, shaped like
           nbexec.Output in the Go code.
"""

import ast
import base64
import contextlib
import io
import json
import linecache
import os
import queue
import signal
import sys
import threading
import time
import traceback
import _thread

ROW_LIMIT = 10000
MAX_TEXT = 1_000_000

# Keep the protocol on a private copy of stdout, and point file descriptor 1
# at stderr so output from C extensions or subprocesses cannot corrupt it.
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
_send_lock = threading.Lock()


def send(obj):
    line = json.dumps(obj, default=str)
    with _send_lock:
        _proto.write(line + "\n")
        _proto.flush()


g = {"__name__": "__main__", "__builtins__": __builtins__}
_collect = None  # what the running cell has displayed
_running = None  # id of the running cell


def _cell_text(v):
    if v is None:
        return None
    try:
        import pandas as pd

        if pd.api.types.is_scalar(v) and bool(pd.isna(v)):
            return None
    except Exception:
        pass
    if isinstance(v, str):
        return v
    if isinstance(v, (bytes, bytearray)):
        return repr(bytes(v))
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            pass
    if hasattr(v, "tolist"):
        v = v.tolist()
    if isinstance(v, (list, tuple, dict)):
        return json.dumps(v, default=str)
    if hasattr(v, "asDict"):
        return json.dumps(v.asDict(recursive=True), default=str)
    return str(v)


def _table(pdf, types, truncated):
    cols = [{"name": str(c), "type": t} for c, t in zip(pdf.columns, types)]
    rows = [[_cell_text(v) for v in r] for r in pdf.itertuples(index=False, name=None)]
    _collect["tables"].append({"columns": cols, "rows": rows, "truncated": truncated})


def _is_spark_df(obj):
    return hasattr(obj, "toPandas") and hasattr(obj, "schema") and hasattr(obj, "limit")


def _is_pandas_df(obj):
    return type(obj).__name__ == "DataFrame" and hasattr(obj, "itertuples") and hasattr(obj, "dtypes")


def _figure_png(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def display(obj=None, *args, **kwargs):
    """Shows a DataFrame as a table, a figure as an image, anything else as text."""
    if _collect is None:
        print(repr(obj))
        return
    if obj is None:
        return
    if _is_spark_df(obj):
        types = [f.dataType.simpleString() for f in obj.schema.fields]
        pdf = obj.limit(ROW_LIMIT + 1).toPandas()
        _table(pdf.head(ROW_LIMIT), types, len(pdf) > ROW_LIMIT)
    elif _is_pandas_df(obj):
        _table(obj.head(ROW_LIMIT), [str(t) for t in obj.dtypes], len(obj) > ROW_LIMIT)
    elif hasattr(obj, "savefig"):
        _collect["images"].append(_figure_png(obj))
    elif hasattr(obj, "figure") and hasattr(obj.figure, "savefig"):
        _collect["images"].append(_figure_png(obj.figure))
    else:
        _collect["texts"].append(repr(obj))


def _open_figures():
    """Collects and closes matplotlib figures the cell left open, as notebooks do."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        try:
            _collect["images"].append(_figure_png(plt.figure(num)))
        except Exception as e:  # noqa: BLE001
            _collect["notes"].append(f"A figure could not be drawn: {e}")
    plt.close("all")


def _error_parts(e):
    tb = e.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
        tb = tb.tb_next
    only = "".join(traceback.format_exception_only(type(e), e)).strip()
    if isinstance(e, SyntaxError):
        # Python's own parser frames say nothing about the cell.
        detail = only
        summary = only.splitlines()[-1] if only else "SyntaxError"
    else:
        detail = "".join(traceback.format_exception(type(e), e, tb))
        # Spark errors often start their message on a new line; use the first
        # line that says something, after the short type name.
        message = next((l.strip() for l in str(e).splitlines() if l.strip()), "")
        summary = f"{type(e).__name__}: {message}" if message else type(e).__name__
    if len(summary) > 500:
        summary = summary[:500] + "…"
    return summary, detail


def run(cid, code):
    global _collect, _running
    start = time.time()
    _collect = {"tables": [], "images": [], "texts": [], "notes": []}
    out = io.StringIO()
    status, error, detail = "finished", "", ""
    name = f"<cell {cid}>"
    linecache.cache[name] = (len(code), None, code.splitlines(True), name)
    try:
        tree = ast.parse(code, name, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            _running = cid
            exec(compile(tree, name, "exec"), g)
            if last is not None:
                value = eval(compile(last, name, "eval"), g)
                if value is not None:
                    if _is_pandas_df(value):
                        display(value)
                    else:
                        _collect["texts"].append(repr(value))
            _open_figures()
    except KeyboardInterrupt:
        status = "cancelled"
    except BaseException as e:  # noqa: BLE001 - report everything, including SystemExit
        status = "error"
        error, detail = _error_parts(e)
    finally:
        _running = None

    text = out.getvalue()
    if _collect["texts"]:
        text += ("" if not text or text.endswith("\n") else "\n") + "\n".join(_collect["texts"])
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + "\n… output cut off"
    table = _collect["tables"][-1] if _collect["tables"] else None
    kind = "table" if table else "image" if _collect["images"] else "text" if text else "none"
    reply = {
        "id": cid,
        "status": status,
        "kind": kind,
        "text": text,
        "columns": table["columns"] if table else [],
        "rows": table["rows"] if table else [],
        "truncated": bool(table and table["truncated"]),
        "images": _collect["images"],
        "imageNotes": _collect["notes"],
        "error": error,
        "detail": detail,
        "durationMs": int((time.time() - start) * 1000),
    }
    _collect = None
    send(reply)


def interrupt():
    spark = g.get("spark")
    if spark is not None and hasattr(spark, "interruptAll"):
        try:
            spark.interruptAll()
        except Exception:  # noqa: BLE001
            pass
    if hasattr(signal, "pthread_kill"):
        # A real signal also wakes blocking calls such as time.sleep.
        signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
    else:
        # Windows has no pthread_kill; this interrupts at the next Python
        # instruction, and the app ends the session if the cell stays stuck.
        _thread.interrupt_main()


def reader(q):
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("op") == "cancel":
            if _running is not None and _running == msg.get("id"):
                interrupt()
        else:
            q.put(msg)
    q.put(None)  # stdin closed: the app is done with this session


def setup():
    g["display"] = display
    if os.environ.get("DBX_KERNEL_TEST") == "1":
        return "test"  # the Go tests run the driver without Databricks Connect
    from databricks.connect import DatabricksSession

    profile = os.environ.get("DBX_PROFILE") or None
    builder = DatabricksSession.builder
    if profile:
        builder = builder.profile(profile)
    spark = builder.serverless(True).getOrCreate()
    g["spark"] = spark
    g["display"] = display
    try:
        from databricks.sdk import WorkspaceClient

        g["dbutils"] = WorkspaceClient(profile=profile).dbutils
    except Exception:  # noqa: BLE001 - dbutils is a convenience
        pass
    from importlib import metadata

    try:
        return metadata.version("databricks-connect")
    except metadata.PackageNotFoundError:
        return ""


def main():
    # A parent that ignores Ctrl+C passes that on; cancel needs it handled.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        version = setup()
    except BaseException as e:  # noqa: BLE001
        summary, detail = _error_parts(e)
        send({"ready": False, "error": summary, "detail": detail})
        return
    send({"ready": True, "python": sys.version.split()[0], "connect": version})
    q = queue.Queue()
    threading.Thread(target=reader, args=(q,), daemon=True).start()
    while True:
        try:
            msg = q.get()
        except KeyboardInterrupt:
            continue  # a cancel that arrived between cells
        if msg is None:
            return
        if msg.get("op") == "run":
            try:
                run(msg.get("id"), msg.get("code", ""))
            except KeyboardInterrupt:
                send({"id": msg.get("id"), "status": "cancelled", "kind": "none", "text": "", "columns": [],
                      "rows": [], "truncated": False, "images": [], "imageNotes": [], "error": "",
                      "detail": "", "durationMs": 0})


if __name__ == "__main__":
    main()
