#!/bin/bash
input=$(cat)
printf '%s' "$input" | node -e '
const fs = require("fs"), os = require("os"), path = require("path");
let j = {}; try { j = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
const dir = (j.workspace && j.workspace.current_dir) || process.cwd();
const user = os.userInfo().username, host = os.hostname().split(".")[0];
const parts = [`\x1b[2;32m${user}@${host}\x1b[0m:\x1b[2;34m${dir.replace(os.homedir(), "~")}\x1b[0m`];
try {
  const l = JSON.parse(fs.readFileSync(path.join(os.homedir(), "agent-workplace", "data", "limits.json"), "utf8"));
  const w = l.windows || {}, now = Date.now();
  const pct = (x) => (x && x.resetsAt > now ? Math.round(x.utilization * 100) : 0) + "%";
  const col = (x) => { const u = x && x.resetsAt > now ? x.utilization : 0; return u >= 0.85 ? 31 : u >= 0.7 ? 33 : 32; };
  if (w.five_hour) parts.push(`\x1b[${col(w.five_hour)}m5h ${pct(w.five_hour)}\x1b[0m`);
  if (w.seven_day) parts.push(`\x1b[${col(w.seven_day)}mwk ${pct(w.seven_day)}\x1b[0m`);
} catch {}
try {
  const idle = (Date.now() - fs.statSync(j.transcript_path).mtimeMs) / 60000;
  parts.push(idle < 55 ? `\x1b[32mcache warm\x1b[0m` : idle < 60 ? `\x1b[33mcache cools in ${Math.max(1, Math.round(60 - idle))}m\x1b[0m` : `\x1b[2mcache cold\x1b[0m`);
} catch {}
try {
  const fd = fs.openSync(j.transcript_path, "r"), size = fs.fstatSync(fd).size, n = Math.min(size, 400000), buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n").reverse();
  for (const l of lines) {
    if (!l.includes("\"usage\"") || !l.includes("\"assistant\"")) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const u = e.message && e.message.usage; if (!u) continue;
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const base = /haiku/.test(e.message.model) ? 1 : /sonnet/.test(e.message.model) ? 3 : 5;
    const per = (ctx * 0.1 * base) / 1e6;
    const k = Math.round(ctx / 1000) + "k";
    parts.push(ctx >= 300000 ? `\x1b[1;31mctx ${k} ⚠ ${per >= 0.01 ? "~$" + per.toFixed(2) + "/msg · " : ""}finish up, then /clear or /compact\x1b[0m` : ctx >= 150000 ? `\x1b[33mctx ${k}\x1b[0m` : `\x1b[2mctx ${k}\x1b[0m`);
    break;
  }
} catch {}
process.stdout.write(parts.join("  "));
'
