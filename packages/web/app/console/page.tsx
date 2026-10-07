import { BlueprintBuilder } from '@/components/blueprint-builder';
import { CopyButton } from '@/components/copy';
import { Chip, Eyebrow, SectionHead, SourceChip } from '@/components/ui';
import { beaconUrl, getManifest } from '@/lib/beacon';

export const revalidate = 300;
export const metadata = { title: 'Agent console', description: 'The beacon, the machine interface to Tempex, made readable.' };

type Tool = { name: string; description: string; route: string; method: string; paid: boolean; when?: string; returns?: string };
type Route = { path: string; method: string; summary: string; paid: boolean };

export default async function ConsolePage() {
  const result = await getManifest();
  const manifest = result.data as { routes: Route[]; tools: Tool[]; verification?: { recipe?: string[] } };
  const base = beaconUrl() ?? 'https://<beacon>';
  const free = manifest.routes.filter((r) => !r.paid && r.method === 'GET').length;

  return (
    <div className="wrap pt-16">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHead eyebrow="Agent console" title="This page is decorative. The beacon is the product.">
          Agents don’t read websites. They read the beacon: a read-only HTTP surface over the escrow, with manifests, tool
          descriptors and calldata blueprints. Everything here is that interface, made readable for people.
        </SectionHead>
        <SourceChip source={result.source} asOf={result.asOf} />
      </div>

      <section className="mt-12 grid gap-px border hairline bg-line md:grid-cols-3">
        {[
          ['Manifest', '/.well-known/tempex.json', 'Identity, protocol state, costs, tools, and how to verify all of it.'],
          ['Agent card', '/.well-known/agent.json', 'A2A-style skills and the endpoint to call.'],
          ['Stats', '/stats', 'Whole-network evidence with the receipts behind each number.'],
        ].map(([title, path, body]) => {
          const command = `curl -s ${base}${path}`;
          return (
            <div key={path} className="flex flex-col gap-3 bg-ink-2 p-6">
              <p className="text-[16px]">{title}</p>
              <p className="text-[13px] text-fg-2">{body}</p>
              <div className="mt-auto flex items-center justify-between gap-2 border hairline bg-ink px-3 py-2">
                <code className="min-w-0 truncate font-mono text-[12px] text-fg-2">{command}</code>
                <CopyButton value={command} label={`Copy ${command}`} />
              </div>
            </div>
          );
        })}
      </section>

      <section className="mt-16 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow>Route table</Eyebrow>
          <Chip>{manifest.routes.length} routes</Chip>
          <Chip>{free} free GET</Chip>
          <Chip tone="pip">{manifest.routes.filter((r) => r.paid).length} paid</Chip>
        </div>
        <div className="overflow-x-auto border hairline">
          <table className="table min-w-[760px]">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>What it answers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {manifest.routes.map((route) => (
                <tr key={`${route.method} ${route.path}`}>
                  <td>
                    <Chip tone={route.method === 'POST' ? 'bolt' : 'plain'}>{route.method}</Chip>
                  </td>
                  <td className="font-mono text-[13px]">{route.path}</td>
                  <td className="text-[13.5px] text-fg-2">{route.summary}</td>
                  <td>{route.paid ? <Chip tone="pip">402 · paid</Chip> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-16 flex flex-col gap-6">
        <SectionHead eyebrow="Blueprint builder" title="Pick an intent. Get calldata to sign.">
          The beacon builds the exact calls, with the ABI’s own argument names. An agent signs and sends them; Tempo batches
          them into one atomic transaction.
        </SectionHead>
        <div className="panel p-6">
          <BlueprintBuilder />
        </div>
      </section>

      <section className="mt-16 flex flex-col gap-4">
        <Eyebrow>Tools, MCP-style</Eyebrow>
        <div className="grid gap-px border hairline bg-line md:grid-cols-2">
          {manifest.tools.map((tool) => (
            <div key={tool.name} className="flex flex-col gap-2 bg-ink-2 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-ref">{tool.name}</span>
                <Chip>
                  {tool.method} {tool.route}
                </Chip>
                {tool.paid ? <Chip tone="pip">paid</Chip> : null}
              </div>
              <p className="text-[13.5px] text-fg-2">{tool.description}</p>
              {tool.when ? <p className="text-[12.5px] text-fg-3">Use when: {tool.when}</p> : null}
            </div>
          ))}
        </div>
      </section>

      {manifest.verification?.recipe ? (
        <section className="mt-16 flex flex-col gap-4">
          <Eyebrow>Don’t trust the beacon. Verify it.</Eyebrow>
          <ol className="flex max-w-4xl flex-col gap-2 text-[14px] text-fg-2">
            {manifest.verification.recipe.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
