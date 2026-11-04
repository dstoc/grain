"""Linux CI measurements; stdout/stderr retain the wrapped command's output."""
import argparse
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", help="New JSON result path (must not exist)")
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
if not args.command:
    parser.error("a command is required")
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    parser.error(f"result already exists: {output}")


def read(path):
    source = Path(path)
    return source.read_text().strip() if source.exists() else None


def command(*parts):
    return subprocess.check_output(parts, text=True).strip()


def tree_rss(root):
    processes = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            # comm may contain spaces or parentheses; fields after the last ')' are fixed.
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            processes[int(entry.name)] = (int(fields[1]), int(fields[21]))
        except (OSError, ValueError, IndexError):
            continue
    family = {root}
    while True:
        expanded = family | {pid for pid, (parent, _) in processes.items() if parent in family}
        if expanded == family:
            break
        family = expanded
    return sum(processes[pid][1] for pid in family if pid in processes) * os.sysconf("SC_PAGE_SIZE") // 1024


metadata = {
    "revision": command("git", "rev-parse", "HEAD"),
    "tree": command("git", "rev-parse", "HEAD^{tree}"),
    "worktree_status": command("git", "status", "--porcelain"),
    "command": args.command,
    "node": command("node", "--version"),
    "npm": command("npm", "--version"),
    "packages": {name: json.loads(Path(f"node_modules/{name}/package.json").read_text())["version"]
                 for name in ["yjs", "vitest", "vite-plus"] if Path(f"node_modules/{name}/package.json").exists()},
    "platform": platform.platform(),
    "logical_cpus": os.cpu_count(),
    "cpu_affinity": sorted(os.sched_getaffinity(0)),
    "cpu_model": next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")), None),
    "memory": read("/proc/meminfo"),
    "cpu_limit": read("/sys/fs/cgroup/cpu.max"),
    "memory_limit": read("/sys/fs/cgroup/memory.max"),
    "runner": {key: os.environ.get(key) for key in ["RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"]},
    "flags": {key: os.environ.get(key) for key in ["CI", "MARKDOWN_EXTENSIVE_SMOKE_TESTS", "MARKDOWN_EXTENSIVE_TESTS", "NODE_OPTIONS"]},
    "start": time.time(),
    "load_start": os.getloadavg(),
}
output.write_text(json.dumps(metadata, indent=2) + "\n")
before = resource.getrusage(resource.RUSAGE_CHILDREN)
start = time.monotonic()
process = subprocess.Popen(args.command)
peak = 0
while process.poll() is None:
    peak = max(peak, tree_rss(process.pid))
    time.sleep(0.1)
code = process.wait()
after = resource.getrusage(resource.RUSAGE_CHILDREN)
metadata.update({
    "exit_code": code, "end": time.time(), "wall_seconds": time.monotonic() - start,
    "user_seconds": after.ru_utime - before.ru_utime,
    "system_seconds": after.ru_stime - before.ru_stime,
    "largest_child_peak_rss_kib": after.ru_maxrss,
    "sampled_tree_peak_rss_kib": peak,
    "rss_note": "100ms concurrent process-tree RSS samples; shared pages can be counted more than once; short peaks may be missed. Largest-child RSS is not a concurrent tree peak.",
    "load_end": os.getloadavg(),
})
output.write_text(json.dumps(metadata, indent=2) + "\n")
raise SystemExit(code if code >= 0 else 128 - code)
