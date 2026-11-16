"""Exercise automatic CLI launch in a real PTY using an isolated fake provider."""
import fcntl
import json
import os
import pty
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
base = Path(tempfile.mkdtemp(prefix="factory-auto-launch-"))
project = base / "project's $literal"
project.mkdir()
calls = base / "call.json"
fake = base / "opencode"
fake.write_text(
    '#!/usr/bin/env node\nconst fs=require("node:fs");\n'
    + "fs.writeFileSync(" + json.dumps(str(calls))
    + ',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||"{}")}));\n'
    + 'console.log(JSON.stringify({type:"text",part:{text:"## Completed\\nLauncher smoke check complete.\\nTHEFACTORY_TASK_RESULT: completed"}}));\n'
)
fake.chmod(0o700)
prompt = "/literal/path\n  Unicode 工場 🏭\n$(touch NEVER) `echo no` 'quoted' --demo"
request = dict(version=1, id="integration-launch-id", directory=str(project), prompt=prompt, profile="saved",
               model="fixture/main", agentModels={"developer": "fixture/code#low"},
               execution="standard", workers=3, auto=False, autoFallback=False,
               graphify=False, muted=True)
request_file = base / "launch.json"
request_file.write_text(json.dumps(request))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
env = dict(os.environ, FACTORY_OPENCODE=str(fake), FACTORY_MENUBAR_DIR=str(base / "status"),
           OPENCODE_DB=str(base / "absent.db"), XDG_CONFIG_HOME=str(base / "config"),
           XDG_STATE_HOME=str(base / "state"), FACTORY_SOUND="0")
process = subprocess.Popen(["node", "bin/theFactory.js", "--launch-request", str(request_file)],
                           stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root)
os.close(slave)
output = bytearray()


def drain():
    try:
        while True:
            part = os.read(master, 65536)
            if not part:
                break
            output.extend(part)
    except OSError:
        pass


threading.Thread(target=drain, daemon=True).start()
try:
    for _ in range(150):
        if calls.exists():
            break
        if process.poll() is not None:
            raise RuntimeError("CLI exited early: " + output.decode(errors="replace")[-1000:])
        time.sleep(0.1)
    result = json.loads(calls.read_text())
    assert Path(result["cwd"]).resolve() == project.resolve(), "Wrong working directory"
    assert result["args"][-1].startswith(prompt), "Prompt was altered or treated as a command"
    assert "--auto" not in result["args"], "Auto approval was unexpectedly enabled"
    assert "--session" not in result["args"], "An old session was resumed"
    assert result["config"]["agents"]["developer"]["model"] == "fixture/code#low", "Individual model was lost"
    assert result["config"]["agents"]["reviewer"]["model"] == "fixture/main", "Other agent model was changed"
    assert not (project / "NEVER").exists(), "Prompt was executed as shell code"
    status_file = base / "status" / (str(process.pid) + ".json")
    status = {}
    for _ in range(40):
        if status_file.exists():
            status = json.loads(status_file.read_text())
            if status["state"] == "done":
                break
        time.sleep(0.1)
    assert status.get("state") == "done", "Run did not complete: " + str(status.get("state"))
    assert status["progress"]["fraction"] == 1, "Completion was not projected"
    assert status["launchID"] == request["id"], "Launch identity was lost"
    print("PTY auto-launch passed: automatic start, selected cwd, literal prompt, fresh session, individual model, completed snapshot. No provider calls.")
finally:
    if process.poll() is None:
        os.write(master, b"\x03")
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)
    os.close(master)
    shutil.rmtree(base)
