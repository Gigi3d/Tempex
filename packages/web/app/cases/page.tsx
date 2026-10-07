import Link from 'next/link';

import { RulingGauge } from '@/components/gauge';
import { ArrowUpRight, Chip, SectionHead } from '@/components/ui';
import { CASE_NOTES, liveJobFor } from '@/lib/cases';
import { snapshot } from '@/lib/snapshot';

export const metadata = { title: 'Case studies', description: 'Four disputes, four rulings, all reproducible from the repository.' };

export default function Cases() {
  return (
    <div className="wrap pt-16">
      <SectionHead eyebrow="The dispute corpus" title="Four disputes. Four rulings. All in the repository.">
        Each case is a scenario in packages/demo with its expected band written down. The build runs the real rule engine on
        every one and refuses to ship if a prediction drifts.
      </SectionHead>
      <div className="mt-12 grid gap-px border hairline bg-line md:grid-cols-2">
        {snapshot.corpus.map((entry) => {
          const live = liveJobFor(entry.id);
          return (
            <Link key={entry.id} href={`/cases/${entry.id}`} className="group flex flex-col gap-5 bg-ink-2 p-8 hover:bg-panel">
              <div className="flex flex-wrap items-center gap-2">
                <Chip>{entry.id}</Chip>
                {entry.prediction.ok ? <Chip tone="ref">✓ reproduces</Chip> : <Chip tone="fail">✕ drifted</Chip>}
                {live ? <Chip tone="bolt">live as job {live}</Chip> : null}
              </div>
              <div>
                <p className="text-[24px] font-light tracking-tight">{entry.title}</p>
                <p className="mt-2 text-[14px] text-fg-2">{CASE_NOTES[entry.id]?.why}</p>
              </div>
              <RulingGauge size="compact" ruleBand={{ lowBps: entry.prediction.band[0], highBps: entry.prediction.band[1] }} awardBps={entry.prediction.rulingBps} />
              <div className="mt-auto flex items-center justify-between">
                <span className="font-mono text-[13px] text-fg-2">
                  band {entry.prediction.band[0]}–{entry.prediction.band[1]} · rules {entry.prediction.rulingBps}
                </span>
                <span className="inline-flex items-center gap-1 text-[13px] text-fg-3 group-hover:text-ref">
                  Open <ArrowUpRight />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
