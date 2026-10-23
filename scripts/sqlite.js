#!/usr/bin/env node
'use strict';
// Read-only look into a SQLite database: its tables with row counts and columns, or the rows of one query.
const { parseArgs, home, cli, fs, path } = require('./_util');
const { spawnSync } = require('child_process');

const PY = `
import sqlite3, sys, json
db, sql, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
c = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
if not sql:
    for (name, kind) in c.execute("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name"):
        cols = [r[1] + ' ' + (r[2] or '') for r in c.execute('pragma table_info("%s")' % name.replace('"', '""'))]
        n = c.execute('select count(*) from "%s"' % name.replace('"', '""')).fetchone()[0]
        print('%s%s  (%d rows)\\n    %s' % (name, ' [view]' if kind == 'view' else '', n, ', '.join(cols)))
else:
    cur = c.execute(sql)
    names = [d[0] for d in cur.description or []]
    rows = cur.fetchmany(limit + 1)
    print(json.dumps({'cols': names, 'rows': [[str(v) if isinstance(v, bytes) else v for v in r] for r in rows[:limit]], 'more': len(rows) > limit}, default=str))
`;

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: sqlite <db file> ["SELECT ..."] [--max N] [--width N]\n  Without a query it lists tables, row counts and columns. Read-only: SELECT, WITH, PRAGMA and EXPLAIN only.';
  const db = path.resolve(cwd, home(pos[0]));
  if (!fs.existsSync(db)) return `No such file: ${db}`;
  const sql = pos.slice(1).join(' ').trim();
  if (sql && !/^(select|with|pragma|explain)\b/i.test(sql)) return 'Read-only: only SELECT, WITH, PRAGMA and EXPLAIN queries.';
  const max = Number(opt.max) || 50;
  const r = spawnSync('python3', ['-I', '-c', PY, db, sql, String(max)], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
  if (r.status !== 0) return `error: ${(r.stderr || '').trim().split('\n').pop()}`;
  if (!sql) return r.stdout.trim() || '(no tables)';
  const { cols, rows, more } = JSON.parse(r.stdout);
  const width = Number(opt.width) || 60;
  const cell = (v) => (v === null ? 'NULL' : String(v).replace(/\s+/g, ' ')).slice(0, width);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => cell(row[i]).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(w[i])).join(' | ');
  return [line(cols), w.map((n) => '-'.repeat(n)).join('-+-'), ...rows.map((row) => line(row.map(cell))), `(${rows.length} row${rows.length === 1 ? '' : 's'}${more ? `, more not shown; use --max` : ''})`].join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
