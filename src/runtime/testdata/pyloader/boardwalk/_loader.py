# SPDX-License-Identifier: Apache-2.0
"""Minimal stdlib-only stand-in for the real ``boardwalk._loader``, for the runner's tests.

The runner's Python program path spawns ``<python3> -m boardwalk._loader <entry>``; the tests
put THIS package first on ``PYTHONPATH`` so the spawn contract is exercised end to end with no
dependency on the sdk-python repo. The protocol is plain NDJSON JSON-RPC over the Unix socket
in ``BOARDWALK_HOST_SOCK``: connect, ``bootstrap``, then act out the behavior named by the
entry file's CONTENT (one word), reporting a transformed input back via ``report_return`` in
the happy case. Failures propagate exactly like the real loader: traceback to stderr, non-zero
exit, curated server-side by the runner.
"""

import json
import os
import signal
import socket
import sys
import time


def _rpc(sock, reader, rpc_id, method, params):
    frame = {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params}
    sock.sendall((json.dumps(frame) + "\n").encode("utf-8"))
    while True:
        line = reader.readline()
        if not line:
            raise RuntimeError("the host closed the connection mid-call")
        response = json.loads(line)
        if response.get("id") != rpc_id:
            continue  # a notification (e.g. cancel) or an unrelated frame — not ours
        if "error" in response:
            err = response["error"]
            raise RuntimeError(f"{err['code']}: {err['message']}")
        return response["result"]


def main():
    entry = sys.argv[1]
    with open(entry, encoding="utf-8") as f:
        mode = f.read().strip()

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(os.environ["BOARDWALK_HOST_SOCK"])
    reader = sock.makefile("r", encoding="utf-8")
    boot = _rpc(sock, reader, 1, "bootstrap", {})

    if mode == "echo":
        print("echo fixture starting")
        print("a warning line", file=sys.stderr)
        value = {
            "echoed": boot["input"],
            "run_id": boot["context"]["runId"],
            "cwd": os.getcwd(),
            "home": os.environ.get("HOME"),
        }
        _rpc(sock, reader, 2, "report_return", {"value": value})
        sock.close()  # disconnect after report_return = the clean shutdown the server tolerates
    elif mode == "raise":
        raise ValueError("boom from python")
    elif mode == "hang":
        time.sleep(600)  # the abort test SIGTERMs us out of this
    elif mode == "stubborn-hang":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)  # forces the runner's SIGKILL escalation
        time.sleep(600)
    elif mode == "silent":
        pass  # exit 0 without reporting — the loader-contract violation
    elif mode == "badreturn":
        _rpc(sock, reader, 2, "report_return", {"value": {"n": "not-a-number"}})
    else:
        raise RuntimeError(f"unknown fixture mode: {mode}")


if __name__ == "__main__":
    main()
