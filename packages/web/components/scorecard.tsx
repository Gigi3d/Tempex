import type { CriterionSignal } from '@/lib/snapshot';

export type ScorecardTotals = { total: number; checked: number; earned: number; open: number };

function fraction(evidence: string | undefined): string | null {
  const match = evidence?.match(/^(\d+) of (\d+)/);
  return match ? `${match[1]} of ${match[2]}` : null;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

/// One row per criterion. Code decides the checks; the hatched rows are the
/// weight no check decided, which splits at the midpoint.
export function CriterionScorecard({ rows, totals, animate = false }: { rows: CriterionSignal[]; totals: ScorecardTotals; animate?: boolean }) {
  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto">
        <table className="table min-w-[680px]">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Check</th>
              <th className="w-[22%]">Weight</th>
              <th className="text-right">Credit</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const open = row.kind !== 'check';
              const credit = row.credit ?? 0;
              const earned = credit * row.weight;
              const partial = !open && credit > 0 && credit < 1;
              return (
                <tr key={row.id} className={animate ? 'anim-fade' : undefined} style={animate ? { animationDelay: `${index * 140}ms` } : undefined}>
                  <td>
                    <details className="group">
                      <summary className="cursor-pointer list-none text-[14px] text-fg marker:hidden">
                        {row.text}
                        <span className="ml-2 font-mono text-[11px] text-fg-3 group-open:hidden">+ evidence</span>
                      </summary>
                      <p className="mt-2 max-w-[60ch] font-mono text-[11.5px] leading-relaxed text-fg-3">{row.evidence ?? 'no evidence string'}</p>
                    </details>
                  </td>
                  <td>
                    <span className={open ? 'chip chip-pip' : 'chip'}>{open ? 'open' : ((typeof row.check === 'string' ? row.check : row.check?.type) ?? 'check')}</span>
                  </td>
                  <td>
                    <div className={`h-2 w-full ${open ? 'hatch' : 'bg-panel-2'}`} aria-hidden>
                      {!open ? <div className="h-2 bg-ref" style={{ width: `${credit * 100}%` }} /> : null}
                    </div>
                  </td>
                  <td className="text-right font-mono text-[13px] num">
                    {open ? '—' : round(earned)} / {row.weight}
                  </td>
                  <td>
                    {open ? (
                      <span className="chip chip-pip">unchecked · midpoint</span>
                    ) : partial ? (
                      <span className="chip chip-ref">{fraction(row.evidence) ?? `${Math.round(credit * 100)}%`}</span>
                    ) : credit >= 1 ? (
                      <span className="chip chip-ref">✓ pass</span>
                    ) : (
                      <span className="chip chip-fail">✕ fail</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-[14px] text-fg-2">
        <span className="text-fg">
          Code checked {round(totals.checked)} of {round(totals.total)} weight and credited {round(totals.earned)}.
        </span>{' '}
        {totals.open > 0
          ? `${round(totals.open)} ${totals.open === 1 ? 'unit has' : 'units have'} no check and ${totals.open === 1 ? 'splits' : 'split'} at the midpoint.`
          : 'Every unit was decided by a check.'}
      </p>
    </div>
  );
}
