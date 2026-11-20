import React, { useEffect } from 'react';
import { Building2, PhoneCall, X } from 'lucide-react';

interface HumanSupportModalProps {
  isOpen: boolean;
  onClose: () => void;
  campus?: string;
  email?: string;
}

export const HumanSupportModal: React.FC<HumanSupportModalProps> = ({
  isOpen,
  onClose,
  campus,
  email,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="human-support-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-lg p-6 text-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#0B2240] text-white flex items-center justify-center shrink-0">
              <PhoneCall className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="human-support-title" className="font-display text-lg font-semibold text-[#0B2240]">
                Academic Success Center
              </h2>
              <p className="text-xs text-slate-500">Human Tutor & Advisor Support</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-2 -mr-2 -mt-2 text-slate-400 hover:text-slate-700 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-5 p-4 rounded-lg bg-slate-50 border border-slate-200">
          <p className="text-base font-medium text-[#0B2240]">
            Visit or call your campus ASC
          </p>
          <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
            {campus ? (
              <>
                Your campus is <strong className="font-semibold text-slate-900">{campus}</strong>. Drop by the Academic Success Center desk on campus or call student services during campus hours (demo).
              </>
            ) : (
              <>
                Drop by the Academic Success Center desk at your HCT campus or call student services during campus hours (demo).
              </>
            )}
          </p>
        </div>

        {campus && (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
            <Building2 className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
            <span>{campus} Campus</span>
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
