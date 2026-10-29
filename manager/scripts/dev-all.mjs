// Runs the web dev server (5180) and the Domain API (8787) together (npm run dev:all). No dependencies.
// PORT is removed from the children's env: CORS and public/config.json require the fixed 5180/8787 pair.
// Each child gets its own process group so SIGINT/SIGTERM reaches the grandchildren (vite, tsx) under npm.
// If a child process exits on its own, the other is stopped and this process exits non-zero. Note that
// `tsx watch` does NOT exit when the API crashes (it waits for a file change), so an API crash keeps dev:all up.
// D-MDEV-1 applies: the API runs with AUTH_MODE=disabled (see docs/development.md).
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const { PORT: _ignoredPort, ...env } = process.env;
const children = ["dev", "dev:api"].map((script) => spawn(npm, ["run", script], { stdio: "inherit", env, detached: true }));
let exitCode = null;

function stopAll(signal) {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // group already gone
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    exitCode ??= 0;
    stopAll(signal);
  });
}

let remaining = children.length;
for (const child of children) {
  child.on("exit", (code, signal) => {
    // A child dying on its own (not because we are shutting down) is a failure.
    exitCode ??= code === 0 && signal === null ? 1 : (code ?? 1);
    stopAll("SIGTERM");
    if (--remaining === 0) process.exit(exitCode);
  });
}
