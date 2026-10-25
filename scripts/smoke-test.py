#!/usr/bin/env python3
"""Pack and load the npm artifact in an isolated OpenCode server; never publish."""
import base64
import json
import os
import fcntl
import pty
from pathlib import Path
import re
import selectors
import select
import signal
import shlex
import shutil
import subprocess
import struct
import termios
import tempfile
import time
import urllib.request
import urllib.parse


ROOT = Path(__file__).resolve().parents[1]


def check_tui(launcher):
    """Start the installed package's actual TUI, without credentials or prompts."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    child = subprocess.Popen([str(launcher)], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    success = False
    try:
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline and child.poll() is None:
            if not select.select([master], [], [], 0.3)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            output.extend(chunk)
            for query, reply in [
                (b"\x1b[6n", b"\x1b[1;1R"),
                (b"\x1b[c", b"\x1b[?1;2c"),
                (b"\x1b[>c", b"\x1b[>0;0;0c"),
                (b"\x1b[?u", b"\x1b[?0u"),
            ]:
                if query in chunk:
                    os.write(master, reply)
            text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
            if "TUI plugin error" in text or "Cannot find package" in text:
                raise RuntimeError("Installed TUI failed to load (terminal output suppressed)")
            if "OpenAI limits: Connect OpenAI OAuth or enable codexAuthFallback" in text:
                success = True
                break
        if not success:
            raise RuntimeError("TUI did not leave Loading state and render the no-auth RPC result")
        print("Actual installed TUI: mount, RPC and reactive status update (PASS)", flush=True)
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        os.close(master)


def main():
    opencode = shutil.which("opencode")
    npm = shutil.which("npm")
    if not opencode or not npm:
        raise RuntimeError("npm and opencode must be available in PATH")
    sandbox = Path(tempfile.mkdtemp(prefix="openai-limits-smoke-", dir="/tmp/opencode"))
    print(f"Sandbox (retained for inspection): {sandbox}", flush=True)
    project = sandbox / "project"
    project.mkdir()
    home = sandbox / "home"
    home.mkdir()
    env = {key: os.environ[key] for key in ("PATH", "LANG", "TERM", "TMPDIR") if key in os.environ}
    env.update({
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
    })

    def run(args, cwd):
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError(f"Command failed: {args[0]} {args[1]}; {result.stderr[-1800:]}")
        return result.stdout

    pack = json.loads(run([npm, "pack", "--json", "--pack-destination", str(sandbox)], ROOT))[0]
    paths = {entry["path"] for entry in pack["files"]}
    assert "LICENSE" in paths and "index.js" in paths and "tui.js" in paths and "dist/tui.js" in paths
    assert "opencode.json" not in paths and not any(p.endswith(".test.ts") for p in paths)
    print(f"Package contents: PASS ({len(paths)} files)", flush=True)
    (project / "package.json").write_text(json.dumps({"private": True, "type": "module"}))
    run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", str(sandbox / pack["filename"])], project)
    package = project / "node_modules" / pack["name"]
    assert package.is_dir()
    assert not any(p.endswith((".ts", ".tsx")) for p in paths), "Uncompiled TS in npm package"
    source = (package / "dist/tui.js").read_text()
    assert "createComponent" in source and "react/jsx-runtime" not in source
    print("Compiled Solid JS (no TSX or React runtime): PASS", flush=True)
    run(["node", "--input-type=module", "-e",
         'import { existsSync } from "node:fs"; '
         'for (const name of ["opencode-openai-limits", "opencode-openai-limits/rpc", "opencode-openai-limits/tui"]) '
         'if (!existsSync(new URL(import.meta.resolve(name)))) process.exit(1)'], project)
    (project / "opencode.json").write_text(json.dumps({
        "$schema": "https://opencode.ai/config.json",
        "plugins": [str(package)],
    }))
    print("Install tarball in clean project: PASS", flush=True)
    launcher = sandbox / "open-tui.sh"
    launcher.write_text("#!/bin/sh\ncd " + shlex.quote(str(project)) + " || exit 1\nexec " + shlex.join([
        "env", "-i", *[f"{key}={value}" for key, value in env.items()],
        opencode, "--standalone", str(project),
    ]) + "\n")
    launcher.chmod(0o700)

    server = subprocess.Popen(
        [opencode, "serve", "--hostname", "127.0.0.1", "--port", "0"],
        cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
    )
    selector = selectors.DefaultSelector()
    selector.register(server.stdout, selectors.EVENT_READ)
    selector.register(server.stderr, selectors.EVENT_READ)
    output = ""
    try:
        deadline = time.monotonic() + 45
        url = password = None
        while time.monotonic() < deadline:
            for key, _ in selector.select(timeout=0.5):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if chunk:
                    output += chunk.decode(errors="replace")
                else:
                    selector.unregister(key.fileobj)
            address = re.search(r"server listening on (http://127\.0\.0\.1:\d+)", output)
            secret = re.search(r"server password (\S+)", output)
            if address and secret:
                url, password = address[1], secret[1]
                break
            if server.poll() is not None:
                break
        if not url or not password:
            raise RuntimeError("Isolated server did not report readiness (raw output suppressed)")
        auth = base64.b64encode(f"opencode:{password}".encode()).decode()

        def api(path, body=None, method=None):
            request = urllib.request.Request(url + path, data=json.dumps(body).encode() if body is not None else None,
                                             method=method,
                                             headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=45) as response:
                content = response.read()
                return json.loads(content) if content else None

        location = "?" + urllib.parse.urlencode({"location[directory]": str(project)})
        api("/api/model" + location)
        plugins = api("/api/plugin" + location)["data"]
        plugin = next((p for p in plugins if p["id"] == "opencode-openai-limits"), None)
        if not plugin or plugin["state"]["status"] != "active":
            print("Plugin diagnostics:", json.dumps(plugin or [{"id": p["id"], "state": p["state"]} for p in plugins]))
            print("Config sources:", json.dumps(api("/api/config" + location)))
            raise RuntimeError("Plugin is not active")
        assert plugin["features"].get("server") and plugin["features"].get("tui"), "Entrypoint missing"
        print("OpenCode server activation + TUI entrypoint discovery: PASS", flush=True)
        result = api("/api/rpc/opencode-openai-limits/usage" + location, {"input": {}})["output"]
        assert result["status"] == "not_connected" and result["source"] == "none", result
        print("RPC without credentials, fallback off: PASS", flush=True)
        api("/api/credential", {
            "integrationID": "openai", "label": "Smoke test (fake key)",
            "value": {"type": "key", "key": "fake-smoke-key-not-a-real-secret"},
        })
        result = api("/api/rpc/opencode-openai-limits/usage" + location, {"input": {}})["output"]
        assert result["status"] == "hidden" and result["source"] == "none", result
        print("RPC with fake API key: hidden (PASS)", flush=True)
        # Remove the synthetic credential so the manual TUI opens in the no-auth state.
        credentials = api("/api/credential")
        for credential in credentials if isinstance(credentials, list) else credentials.get("data", []):
            if credential.get("integrationID") == "openai":
                api("/api/credential/" + credential["id"], method="DELETE")
    finally:
        selector.close()
        server.terminate()
        try:
            server.wait(timeout=8)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)

    check_tui(launcher)
    print("No existing credentials/configuration copied. Live usage/colors still need a manual check.")
    print(f"Manual clean TUI: {launcher}")


if __name__ == "__main__":
    main()
