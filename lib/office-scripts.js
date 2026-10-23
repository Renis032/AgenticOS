'use strict';
// Office scripts: the manifest and running a script for an agent or the Terminal app.

function install(ctx) {
  const { SCRIPTS, addEvent, agents, fs, home, os, path, spawn } = ctx;

  const scriptManifest = () => JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'manifest.json'), 'utf8'));

  function runScript(agentId, name, args) {
    const a = agents.get(agentId);
    const list = scriptManifest();
    if (!list.some((x) => x.name === name)) return Promise.resolve({ error: `No script "${name}". Scripts: ${list.map((x) => x.name).join(', ')}.` });
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SCRIPTS, `${name}.js`), ...(Array.isArray(args) ? args.map(String) : [])],
        { cwd: a && a.cwd ? home(a.cwd) : os.homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (c) => { if (out.length < 60000) out += c; });
      child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.on('error', (e) => { err += e.message; });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (a) { a.scriptRuns = (a.scriptRuns || 0) + 1; addEvent(a, { kind: 'script', name, args: (args || []).slice(0, 8), ok: code === 0 }); }
        resolve(code === 0 ? { message: (out || '(no output)').slice(0, 50000) } : { error: (err || out || `exit code ${code}`).slice(0, 4000) });
      });
    });
  }

  return { runScript, scriptManifest };
}

module.exports = { install };
