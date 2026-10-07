/// Pip (the buyer), Bolt (the seller) and Ref (the referee): the hand-drawn cast
/// from the pitch deck. Each takes an `id` so its wobble filter is unique on a page.

type Mood = 'happy' | 'beaming' | 'worried' | 'angry' | 'sad' | 'calm' | 'wink' | 'listening';

const STROKE = { stroke: '#0c0c0d', strokeWidth: 6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function Wobble({ id, seed }: { id: string; seed: number }) {
  return (
    <defs>
      <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves={2} seed={seed} />
        <feDisplacementMap in="SourceGraphic" scale={5} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </defs>
  );
}

function Eyes({ mood, y }: { mood: Mood; y: number }) {
  if (mood === 'happy' || mood === 'beaming' || mood === 'calm') {
    return (
      <>
        <path d={`M64 ${y + 2} Q78 ${y - 12} 92 ${y + 2}`} fill="none" />
        <path d={`M108 ${y + 2} Q122 ${y - 12} 136 ${y + 2}`} fill="none" />
      </>
    );
  }
  if (mood === 'wink') {
    return (
      <>
        <circle cx="78" cy={y} r="11" fill="#0c0c0d" stroke="none" />
        <path d={`M110 ${y + 2} L134 ${y - 2}`} fill="none" />
      </>
    );
  }
  return (
    <>
      <circle cx="78" cy={y} r="12" fill="#0c0c0d" stroke="none" />
      <circle cx="122" cy={y} r="12" fill="#0c0c0d" stroke="none" />
      <circle cx="82" cy={y - 5} r="4" fill="#fff" stroke="none" />
      <circle cx="126" cy={y - 5} r="4" fill="#fff" stroke="none" />
    </>
  );
}

function Brows({ mood, y }: { mood: Mood; y: number }) {
  if (mood === 'worried' || mood === 'sad') {
    return (
      <>
        <path d={`M62 ${y + 6} L88 ${y - 2}`} fill="none" />
        <path d={`M138 ${y + 6} L112 ${y - 2}`} fill="none" />
      </>
    );
  }
  if (mood === 'angry') {
    return (
      <>
        <path d={`M62 ${y - 4} L90 ${y + 8}`} fill="none" />
        <path d={`M138 ${y - 4} L110 ${y + 8}`} fill="none" />
      </>
    );
  }
  return null;
}

function Mouth({ mood, y }: { mood: Mood; y: number }) {
  switch (mood) {
    case 'beaming':
      return <path d={`M74 ${y - 4} Q100 ${y + 32} 126 ${y - 4} Z`} fill="#7a2e1d" />;
    case 'worried':
      return <path d={`M76 ${y + 8} q6 -8 12 0 t12 0 t12 0 t12 0`} fill="none" />;
    case 'angry':
    case 'sad':
      return <path d={`M78 ${y + 12} Q100 ${y - 4} 122 ${y + 12}`} fill="none" />;
    case 'listening':
      return <path d={`M86 ${y + 6} L114 ${y + 6}`} fill="none" />;
    default:
      return <path d={`M76 ${y} Q100 ${y + 22} 124 ${y}`} fill="none" />;
  }
}

export function Pip({ id, mood = 'happy', size = 160, title = 'Pip, the buyer' }: { id: string; mood?: Mood; size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={`${title}, ${mood}`}>
      <Wobble id={id} seed={3} />
      <g filter={`url(#${id})`} {...STROKE}>
        <path d="M100 44 L100 24" fill="none" />
        <circle cx="100" cy="18" r="9" fill="#4be3a6" />
        <circle cx="34" cy="112" r="15" fill="#fb923c" />
        <circle cx="166" cy="112" r="15" fill="#fb923c" />
        <circle cx="100" cy="112" r="66" fill={mood === 'angry' ? '#fbbf24' : '#f7c548'} />
        <ellipse cx="74" cy="78" rx="20" ry="10" fill="#fff4c2" stroke="none" transform="rotate(-25 74 78)" />
        <Brows mood={mood} y={82} />
        <Eyes mood={mood} y={104} />
        <circle cx="62" cy="130" r="11" fill="#fb7185" stroke="none" opacity="0.5" />
        <circle cx="138" cy="130" r="11" fill="#fb7185" stroke="none" opacity="0.5" />
        <Mouth mood={mood} y={134} />
        {mood === 'worried' ? <path d="M156 62 q10 16 0 22 q-10 -6 0 -22 Z" fill="#6aa8ff" strokeWidth={4} /> : null}
      </g>
    </svg>
  );
}

export function Bolt({ id, mood = 'happy', size = 160, title = 'Bolt, the seller' }: { id: string; mood?: Mood; size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={`${title}, ${mood}`}>
      <Wobble id={id} seed={11} />
      <g filter={`url(#${id})`} {...STROKE}>
        <path d="M100 46 L100 26" fill="none" />
        <circle cx="100" cy="20" r="9" fill="#f7c548" />
        <rect x="20" y="96" width="20" height="32" rx="8" fill="#818cf8" />
        <rect x="160" y="96" width="20" height="32" rx="8" fill="#818cf8" />
        <rect x="36" y="46" width="128" height="126" rx="38" fill="#6aa8ff" />
        <ellipse cx="74" cy="72" rx="20" ry="9" fill="#cfe2ff" stroke="none" transform="rotate(-20 74 72)" />
        <Brows mood={mood} y={84} />
        <Eyes mood={mood} y={106} />
        <Mouth mood={mood} y={138} />
        {mood === 'sad' ? <path d="M72 122 q6 12 0 16 q-6 -4 0 -16 Z" fill="#cfe2ff" strokeWidth={3} /> : null}
      </g>
    </svg>
  );
}

export function Ref({ id, mood = 'calm', size = 160, title = 'Ref, the referee' }: { id: string; mood?: Mood; size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={`${title}, ${mood}`}>
      <Wobble id={id} seed={7} />
      <g filter={`url(#${id})`} {...STROKE}>
        <circle cx="34" cy="118" r="15" fill="#2fbf86" />
        <circle cx="166" cy="118" r="15" fill="#2fbf86" />
        <circle cx="100" cy="114" r="66" fill="#4be3a6" />
        <path d="M42 94 Q44 42 100 40 Q156 42 158 94 Z" fill="#f4f4f0" />
        <path d="M74 46 L72 92 M100 40 L100 92 M126 46 L128 92" fill="none" strokeWidth={9} />
        <path d="M36 94 L170 94" fill="none" strokeWidth={8} />
        <path d="M100 40 L100 22" fill="none" />
        <circle cx="100" cy="16" r="9" fill="#f472b6" />
        <Eyes mood={mood} y={118} />
        <circle cx="64" cy="140" r="11" fill="#fb7185" stroke="none" opacity="0.45" />
        <circle cx="136" cy="140" r="11" fill="#fb7185" stroke="none" opacity="0.45" />
        <Mouth mood={mood} y={148} />
        <path d="M120 158 L150 158 A12 12 0 1 1 146 180 L120 174 Z" fill="#cbd5e1" />
      </g>
    </svg>
  );
}
