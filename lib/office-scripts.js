'use strict';
// Office scripts: the manifest and running a script for an agent or the Terminal app. A team can also keep its own
// scripts in its library folder (<team docs>/scripts/manifest.json + <name>.js); only that team's agents see them.

function install(ctx) {
  const { SCRIPTS, addEvent, agents, fs, home, os, path, spawn, teamScriptsDir } = ctx;

  const scriptManifest = () => JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'manifest.json'), 'utf8'));
  const teamManifest = (dir) => { try { return dir ? JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) : []; } catch { return []; } };

  function runScript(agentId, name, args) {
    const a = agents.get(agentId);
    const teamDir = a && teamScriptsDir ? teamScriptsDir(a) : null;
    const list = scriptManifest();
    const team = teamManifest(teamDir);
    const dir = list.some((x) => x.name === name) ? SCRIPTS : team.some((x) => x.name === name) ? teamDir : null;
    if (!dir) return Promise.resolve({ error: `No script "${name}". Scripts: ${[...list, ...team].map((x) => x.name).join(', ')}.` });
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(dir, `${name}.js`), ...(Array.isArray(args) ? args.map(String) : [])],
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
