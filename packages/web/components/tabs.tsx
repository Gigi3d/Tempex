'use client';

import { useId, useState, type ReactNode } from 'react';

/// Tempo-style DIAGRAM / CODE switch for a panel.
export function Tabs({ tabs }: { tabs: { label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(0);
  const id = useId();
  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="View" className="flex justify-end gap-px p-4">
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            role="tab"
            id={`${id}-tab-${index}`}
            aria-controls={`${id}-panel-${index}`}
            aria-selected={index === active}
            onClick={() => setActive(index)}
            className="tab"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.label}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          hidden={index !== active}
          className="flex-1 px-4 pb-6"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
