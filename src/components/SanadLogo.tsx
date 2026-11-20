import React from 'react';

interface SanadLogoProps {
  variant?: 'dark' | 'light';
  showSubtitle?: boolean;
}

export const SanadLogo: React.FC<SanadLogoProps> = ({
  variant = 'light',
  showSubtitle = false,
}) => {
  const isDarkBg = variant === 'dark';

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
          isDarkBg
            ? 'bg-white/10 border-white/20 text-white'
            : 'bg-[#0B2240] border-[#0B2240] text-white'
        }`}
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
          <path d="M9 8h6" />
          <path d="M9 12h4" />
        </svg>
      </div>
      <div className="min-w-0">
        <div
          className={`font-display text-lg font-bold tracking-tight leading-tight flex items-center gap-1.5 ${
            isDarkBg ? 'text-white' : 'text-[#0B2240]'
          }`}
        >
          <span>Sanad</span>
          <span
            className={`font-normal ${isDarkBg ? 'text-slate-300' : 'text-slate-500'}`}
            lang="ar"
          >
            سند
          </span>
        </div>
        {showSubtitle && (
          <p
            className={`text-xs truncate ${
              isDarkBg ? 'text-slate-300' : 'text-slate-500'
            }`}
          >
            HCT Academic Success Center
          </p>
        )}
      </div>
    </div>
  );
};
