import { ReadyCheck } from '@/components/ready-check';
import { ExternalLink, SectionHead, SourceChip } from '@/components/ui';
import { getQuote } from '@/lib/beacon';
import { txUrl } from '@/lib/format';
import { snapshot } from '@/lib/snapshot';

export const revalidate = 300;
export const metadata = { title: 'What it costs to start', description: 'The zero-balance onboarding story, line by line, with the fee measured from a real receipt.' };

export default async function QuotePage() {
  const [seller, buyer] = await Promise.all([getQuote('seller'), getQuote('buyer')]);
  return (
    <div className="wrap pt-16">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHead eyebrow="What it costs to start" title={seller.data.total.value === '0' ? 'A seller agent starts with zero.' : `A seller agent starts with ${seller.data.total.value} αUSD.`}>
          No account to activate, no registration fee, and the transaction fee is paid by Tempo’s hosted fee payer. Every line
          below comes from the beacon, and the fee is measured from a real receipt on chain.
        </SectionHead>
        <SourceChip source={seller.source} asOf={seller.asOf} />
      </div>

      <section className="mt-12 grid gap-10 lg:grid-cols-2">
        {[seller.data, buyer.data].map((quote) => (
          <div key={quote.role} className="panel">
            <div className="flex items-center justify-between border-b hairline p-5">
              <p className={`label ${quote.role === 'seller' ? 'text-bolt' : 'text-pip'}`}>As {quote.role}</p>
              <p className="font-mono text-[22px] num">{quote.total.value} αUSD</p>
            </div>
            {quote.breakdown.map((line) => (
              <div key={line.line} className="flex items-start justify-between gap-6 border-b hairline px-5 py-4 last:border-b-0">
                <div>
                  <p className="text-[14px]">{line.line}</p>
                  <p className="mt-1 text-[12.5px] text-fg-3">{line.note}</p>
                </div>
                <p className="font-mono num">{line.cost.value}</p>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="mt-10 panel p-6">
        <p className="text-[14px] text-fg-2">
          Measured fee: <span className="font-mono text-fg">{seller.data.fee.measured.value} αUSD</span> on job {seller.data.fee.measuredOn.jobId},{' '}
          {seller.data.fee.sponsored ? 'paid by the sponsor' : 'paid by the sender'}.{' '}
          <ExternalLink href={txUrl(seller.data.fee.measuredOn.tx)}>See the transaction</ExternalLink>
        </p>
      </section>

      <section className="mt-14 flex flex-col gap-5">
        <SectionHead eyebrow="Ask the chain" title="Can this address start right now?" />
        <div className="max-w-3xl">
          <ReadyCheck example={snapshot.receipt.parties.seller} />
        </div>
      </section>
    </div>
  );
}
