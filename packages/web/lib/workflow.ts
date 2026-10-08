import type { JobRecord } from './types';

/// What happens next on a job, for one party, at one moment.
///
/// A mirror of TempexEscrow's own `require`s: every move listed here is one the
/// contract would accept right now from that party, and every deadline is the
/// one the contract enforces. The dashboard, the inbox and the job workspace all
/// read from this one function, so they cannot disagree about what is possible.

export const SELLER_RESPONSE_WINDOW = 7 * 86_400;
export const ARBITRATION_WINDOW = 7 * 86_400;
/// When a deadline this close turns a move from "to do" into "urgent".
export const URGENT_SECONDS = 24 * 3_600;

export type Side = 'buyer' | 'seller';

export type MoveId =
  | 'fund'
  | 'cancel'
  | 'deliver'
  | 'accept'
  | 'dispute'
  | 'respond'
  | 'requestRuling'
  | 'autoAccept'
  | 'refundExpired'
  | 'settleLapsed';

export type Move = {
  id: MoveId;
  title: string;
  detail: string;
  /// The last second the contract accepts it, when it has one.
  deadline: number | null;
  /// 'you' when only this party can; 'anyone' for permissionless keeper calls.
  who: 'you' | 'anyone';
  tone: 'ref' | 'pip' | 'bolt' | 'fail';
  /// Whether the move is in this party's interest (it belongs in their inbox).
  forYou: boolean;
};

export type Outlook = {
  side: Side | null;
  moves: Move[];
  /// What the job is waiting on when this party has nothing to do.
  waiting: { title: string; detail: string; until: number | null } | null;
  closed: boolean;
  /// The next deadline that matters to anyone on this job.
  nextDeadline: number | null;
};

export function sideOf(job: Pick<JobRecord, 'buyer' | 'seller'>, address: string | null | undefined): Side | null {
  if (!address) return null;
  const lower = address.toLowerCase();
  if (job.buyer.toLowerCase() === lower) return 'buyer';
  if (job.seller.toLowerCase() === lower) return 'seller';
  return null;
}

export function reviewDeadline(job: JobRecord): number | null {
  if (!job.delivered) return null;
  return job.delivered.reviewDeadline || job.delivered.deliveredAt + job.reviewWindow;
}

export function responseDeadline(job: JobRecord): number | null {
  if (!job.dispute) return null;
  return job.dispute.responseDeadline ?? job.dispute.disputedAt + SELLER_RESPONSE_WINDOW;
}

/// The escrow's evidenceClosedAt: when the seller answered, or when its window shut.
export function evidenceClosedAt(job: JobRecord, now: number): number | null {
  if (!job.dispute) return null;
  if (job.response) return job.response.respondedAt;
  const deadline = responseDeadline(job)!;
  return now > deadline ? deadline : null;
}

const CLOSED = new Set(['accepted', 'resolved', 'refunded', 'cancelled', 'lapsed']);

export function outlook(job: JobRecord, address: string | null | undefined, now: number = Math.floor(Date.now() / 1000)): Outlook {
  const side = sideOf(job, address);
  const moves: Move[] = [];
  let waiting: Outlook['waiting'] = null;
  let nextDeadline: number | null = null;
  const add = (move: Omit<Move, 'forYou'> & { forYou?: boolean }) => moves.push({ forYou: move.forYou ?? move.who === 'you', ...move });

  if (CLOSED.has(job.stage)) {
    return { side, moves, waiting: null, closed: true, nextDeadline: null };
  }

  switch (job.stage) {
    case 'created': {
      nextDeadline = job.deliveryDeadline;
      if (side === 'buyer') {
        if (now < job.deliveryDeadline) {
          add({ id: 'fund', title: 'Fund the job', detail: 'Lock the amount in escrow so the seller can start.', deadline: job.deliveryDeadline - 1, who: 'you', tone: 'ref' });
        }
        add({ id: 'cancel', title: 'Cancel', detail: 'Call the job off. Nothing was escrowed, so nothing moves.', deadline: null, who: 'you', tone: 'fail' });
      } else {
        waiting = { title: 'Waiting for the buyer to fund', detail: 'No money is in escrow yet. Do not start work until it is.', until: job.deliveryDeadline };
      }
      break;
    }
    case 'funded': {
      if (now <= job.deliveryDeadline) {
        nextDeadline = job.deliveryDeadline;
        if (side === 'seller') {
          add({ id: 'deliver', title: 'Deliver the work', detail: 'Commit the work by its hash. The buyer then has the review window to accept or dispute.', deadline: job.deliveryDeadline, who: 'you', tone: 'bolt' });
        } else {
          waiting = { title: 'Waiting for delivery', detail: 'The money is in escrow. If nothing is delivered by the deadline, the buyer can take it back.', until: job.deliveryDeadline };
        }
      } else {
        add({
          id: 'refundExpired',
          title: side === 'buyer' ? 'Take your money back' : 'Refund the buyer',
          detail: 'The delivery deadline passed with nothing delivered. The full amount returns to the buyer.',
          deadline: null,
          who: 'anyone',
          tone: 'pip',
          forYou: side === 'buyer',
        });
        if (side === 'seller') waiting = { title: 'Delivery deadline passed', detail: 'The escrow no longer accepts a delivery for this job.', until: null };
      }
      break;
    }
    case 'delivered': {
      const review = reviewDeadline(job)!;
      if (now <= review) nextDeadline = review;
      if (now <= review && side === 'buyer') {
        add({ id: 'accept', title: 'Accept and pay', detail: 'Release the payment to the seller, less the platform fee.', deadline: review, who: 'you', tone: 'ref' });
        add({ id: 'dispute', title: 'Dispute', detail: 'Ask the arbiter to rule. You post a 5% bond and your final offer; the seller answers within 7 days.', deadline: review, who: 'you', tone: 'fail' });
      }
      if (now >= review) {
        add({
          id: 'autoAccept',
          title: side === 'seller' ? 'Collect your payment' : 'Settle as accepted',
          detail: 'The review window closed without a dispute, so the delivery counts as accepted.',
          deadline: null,
          who: 'anyone',
          tone: 'ref',
          forYou: side === 'seller',
        });
      } else if (side === 'seller') {
        waiting = { title: 'Buyer is reviewing', detail: 'If the buyer neither accepts nor disputes in time, you can collect the payment yourself.', until: review };
      }
      break;
    }
    case 'disputed': {
      const responseBy = responseDeadline(job)!;
      const closedAt = evidenceClosedAt(job, now);
      if (!job.response && now <= responseBy) {
        nextDeadline = responseBy;
        if (side === 'seller') {
          add({ id: 'respond', title: 'Answer the dispute', detail: 'Pin your copy of the work, your statement and your final ask. The arbiter waits for this or for the window to close.', deadline: responseBy, who: 'you', tone: 'bolt' });
        } else {
          waiting = { title: 'Waiting for the seller to answer', detail: 'The seller has 7 days to pin its side. After that the arbiter can rule on what it has.', until: responseBy };
        }
        // The buyer may also ask for a ruling once the seller has answered; until
        // then the escrow would reject any verdict.
      }
      if (closedAt !== null) {
        const lapse = closedAt + ARBITRATION_WINDOW;
        if (now <= lapse) {
          nextDeadline = lapse;
          add({ id: 'requestRuling', title: 'Ask the arbiter to rule', detail: 'Send the case (terms, your evidence and the seller’s answer) to the arbiter. Its verdict lands on chain.', deadline: lapse, who: 'anyone', tone: 'pip', forYou: side !== null });
        } else {
          add({ id: 'settleLapsed', title: 'Settle on the default split', detail: 'The arbiter did not rule in time. The escrow splits at the midpoint of the two offers.', deadline: null, who: 'anyone', tone: 'pip', forYou: side !== null });
        }
      }
      break;
    }
    default:
      break;
  }

  return { side, moves, waiting, closed: false, nextDeadline };
}

export type InboxItem = { job: JobRecord; move: Move; side: Side; urgent: boolean };

/// Everything waiting on this address, most pressing first: moves with a
/// deadline sort by it, and open-ended moves (collect, reclaim) come after.
export function inbox(jobs: readonly JobRecord[], address: string, now: number = Math.floor(Date.now() / 1000)): InboxItem[] {
  const items: InboxItem[] = [];
  for (const job of jobs) {
    const view = outlook(job, address, now);
    if (!view.side) continue;
    for (const move of view.moves) {
      if (!move.forYou || move.id === 'cancel') continue;
      items.push({ job, move, side: view.side, urgent: move.deadline !== null && move.deadline - now <= URGENT_SECONDS });
    }
  }
  return items.sort((a, b) => (a.move.deadline ?? Number.MAX_SAFE_INTEGER) - (b.move.deadline ?? Number.MAX_SAFE_INTEGER) || Number(b.job.jobId) - Number(a.job.jobId));
}

/// Money a party has on the line or coming to it, from the jobs alone.
export function exposure(jobs: readonly JobRecord[], address: string): { buying: bigint; selling: bigint; open: number } {
  let buying = 0n;
  let selling = 0n;
  let open = 0;
  for (const job of jobs) {
    if (CLOSED.has(job.stage) || job.stage === 'created') continue;
    open += 1;
    const side = sideOf(job, address);
    if (side === 'buyer') buying += BigInt(job.amount);
    if (side === 'seller') selling += BigInt(job.amount);
  }
  return { buying, selling, open };
}

export const STEP_LABEL: Record<string, string> = {
  created: 'Opened the job',
  funded: 'Funded escrow',
  delivered: 'Delivered',
  accepted: 'Accepted',
  disputed: 'Opened a dispute',
  responded: 'Answered the dispute',
  ruled: 'Verdict relayed',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  'settled-lapsed': 'Settled on the default split',
  withdrew: 'Withdrew credit',
};
