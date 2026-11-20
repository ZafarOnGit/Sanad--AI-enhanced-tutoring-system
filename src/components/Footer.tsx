import React from 'react';

interface FooterProps {
  onOpenHumanSupport: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onOpenHumanSupport }) => {
  return (
    <footer className="border-t border-slate-200 bg-white mt-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
        <p className="text-center sm:text-left">
          Prototype with dummy data – not connected to TuTrak
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <span>HCT Academic Success Center</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onOpenHumanSupport}
            className="text-[#0B2240] font-medium hover:underline cursor-pointer whitespace-nowrap"
          >
            Talk to a human
          </button>
        </div>
      </div>
    </footer>
  );
};
