import React from 'react';
import { Loader2 } from 'lucide-react';

interface SpinnerProps {
  label?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ label = 'Loading...' }) => {
  return (
    <div
      className="flex items-center gap-3 py-3 text-sm font-medium text-[#0B2240]"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="w-5 h-5 animate-spin text-[#164E87] shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
};
