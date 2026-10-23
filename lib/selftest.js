'use strict';
// The office self-test: one small job through routing, search, a teammate, a question, a file edit and undo.

function install(ctx) {
  const { DATA, agents, answerUser, broadcast, changesOf, createTicket, decidePlan, eventsOf, fs, limits, now, os, path, readJson, revertChanges, stopTicket, touchTicket } = ctx;

  const SELFTEST_FILE = path.join(os.homedir(), '.cache', 'agent-office-selftest', 'notes.txt');
  let selftest = null;
  try { selftest = JSON.parse(fs.readFileSync(path.join(DATA, 'selftest.json'), 'utf8')); } catch {}

  function selftestStep(name, ok, detail) {
    selftest.steps.push({ name, ok: !!ok, detail: detail || '' });
    broadcast({ type: 'selftest', selftest });
  }

  async function runSelfTest() {
    if (selftest && selftest.status === 'running') return selftest;
    const roster = readJson('roster.json');
    selftest = { status: 'running', startedAt: now(), steps: [], costUsd: 0 };
    broadcast({ type: 'selftest', selftest });
    const finish = (status) => {
      selftest.status = status;
      selftest.finishedAt = now();
      try { fs.writeFileSync(path.join(DATA, 'selftest.json'), JSON.stringify(selftest, null, 1)); } catch {}
      broadcast({ type: 'selftest', selftest });
      broadcast({ type: 'notify', kind: status === 'passed' ? 'answer' : 'limit', title: `Self-test ${status}`,
        text: `${selftest.steps.filter((x) => x.ok).length} of ${selftest.steps.length} checks passed · $${selftest.costUsd.toFixed(2)}` });
    };
    const leads = roster.residents.map((k) => agents.get(k)).filter(Boolean);
    const down = leads.filter((a) => a.status === 'offline');
    selftestStep('Server and leads are up', !down.length, down.length ? `Offline: ${down.map((a) => a.persona).join(', ')}` : leads.map((a) => a.persona).join(', '));
    if (limits.hold) { selftestStep('Usage limit allows work', false, 'Work is paused near a limit; continue or wait for the reset first.'); return finish('failed'); }
    const original = 'Self-test notes\nfirst line is: alpha-7\n';
    fs.mkdirSync(path.dirname(SELFTEST_FILE), { recursive: true });
    fs.writeFileSync(SELFTEST_FILE, original);
    const lead = roster.roles['personal-lead'] ? 'personal-lead' : roster.residents.find((k) => k !== roster.root);
    const leadName = roster.roles[lead].persona;
    const t = createTicket({ effort: 'low', text: `Office self-test (automatic; keep it cheap). This is for ${leadName}, the ${roster.roles[lead].name}.
  Do exactly these steps, nothing more:
  1. Call search_tickets with "self-test".
  2. Delegate ONE teammate (role "researcher", model haiku, effort low) to read ${SELFTEST_FILE} and report its second line.
  3. Call ask_user: "Top or bottom?" with options ["Top", "Bottom"].
  4. With the Edit tool, add the line "selftest: <second line the teammate reported>" to ${SELFTEST_FILE} at the position the user chose.
  5. Answer in one sentence.` });
    const startedAt = now();
    const answered = { q: false };
    const ok = await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (t.waiting && !answered.q) { answered.q = true; answerUser(t, 'Bottom'); }
        if (t.plan && t.plan.status === 'pending') decidePlan(t, 'approve', '');
        if (['done', 'failed', 'stopped', 'interrupted'].includes(t.status)) { clearInterval(timer); resolve(t.status === 'done'); }
        else if (now() - startedAt > 8 * 60000) { clearInterval(timer); stopTicket(t); resolve(false); }
      }, 1500);
    });
    selftest.ticketId = t.id;
    selftest.costUsd = t.costUsd || 0;
    const routed = t.thread.find((e) => e.kind === 'assign' && e.from === roster.root);
    selftestStep('Ticket reached the right lead (routing rules or God)', t.direct === lead || (routed && routed.to === lead),
      t.direct === lead ? `routing rules → ${leadName}` : routed ? `God → ${(agents.get(routed.to) || {}).persona}` : 'nobody');
    const leadEvents = eventsOf(agents.get(lead)).filter((e) => e.t >= startedAt);
    selftestStep('Lead searched earlier tickets', leadEvents.some((e) => e.kind === 'tool_use' && /search_tickets/.test(e.name)), '');
    const team = [...agents.values()].filter((a) => !a.resident && (a.tickets || []).includes(t.id));
    selftestStep('A teammate was delegated and reported back', team.some((a) => a.lastOutcome === 'done'), team.map((a) => `${a.persona} (${a.model}/${a.effort}) ${a.lastOutcome}`).join(', ') || 'nobody');
    selftestStep('Lead asked you a question and got the answer', t.thread.some((e) => e.kind === 'question') && t.thread.some((e) => e.kind === 'reply'), '');
    const ch = changesOf(t).find((c) => c.path === SELFTEST_FILE);
    const now1 = fs.existsSync(SELFTEST_FILE) ? fs.readFileSync(SELFTEST_FILE, 'utf8') : '';
    selftestStep('File edit was made at the chosen spot and tracked', ch && ch.state === 'modified' && /selftest:.*alpha-7/.test(now1) && now1.trim().endsWith('alpha-7'),
      ch ? `+${ch.added} −${ch.removed}` : 'not tracked');
    if (ch) revertChanges(t, SELFTEST_FILE);
    const back = fs.existsSync(SELFTEST_FILE) ? fs.readFileSync(SELFTEST_FILE, 'utf8') : '';
    selftestStep('Undo restored the file exactly', back === original, '');
    selftestStep('Ticket finished with an answer and a cost', ok && !!t.answer && t.costUsd > 0, ok ? `$${t.costUsd.toFixed(3)} in ${Math.round((now() - startedAt) / 1000)}s` : `status ${t.status}`);
    selftestStep('Usage limits are being read', !!limits.updatedAt && now() - limits.updatedAt < 3600000, limits.updatedAt ? `updated ${Math.round((now() - limits.updatedAt) / 60000)} min ago` : 'never');
    t.archived = true;
    touchTicket(t);
    try { fs.rmSync(path.dirname(SELFTEST_FILE), { recursive: true, force: true }); } catch {}
    finish(selftest.steps.every((x) => x.ok) ? 'passed' : 'failed');
    return selftest;
  }

  return { runSelfTest, selftestNow: () => selftest };
}

module.exports = { install };
