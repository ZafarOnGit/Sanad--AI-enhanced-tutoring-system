import React, { useState } from 'react';
import { ChevronDown, ChevronUp, FileText, Image as ImageIcon, Paperclip } from 'lucide-react';
import type { RequestAttachment } from '../types';

interface AttachmentListProps {
  attachments?: RequestAttachment[];
  title?: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getKindLabel(mimeType: RequestAttachment['mimeType']): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'image/jpeg') return 'JPG';
  return 'PNG';
}

export const AttachmentList: React.FC<AttachmentListProps> = ({
  attachments,
  title = 'Attached files',
}) => {
  const [expandedMap, setExpandedMap] = useState<Record<number, boolean>>({});

  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
        <Paperclip className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
        <span>
          {title} ({attachments.length})
        </span>
      </p>
      <div className="space-y-2">
        {attachments.map((att, idx) => {
          const isOpen = Boolean(expandedMap[idx]);
          const isPdf = att.mimeType === 'application/pdf';
          const sizeLabel = formatBytes(att.size);
          return (
            <div
              key={`${att.fileName}-${idx}`}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {isPdf ? (
                    <FileText className="w-4 h-4 text-[#0B2240] shrink-0" aria-hidden="true" />
                  ) : (
                    <ImageIcon className="w-4 h-4 text-[#0B2240] shrink-0" aria-hidden="true" />
                  )}
                  <span className="font-medium text-slate-900 truncate">{att.fileName}</span>
                  <span className="px-1.5 py-0.5 rounded bg-white border border-slate-200 font-mono text-[10px] font-semibold text-slate-700 shrink-0">
                    {getKindLabel(att.mimeType)}
                  </span>
                  {sizeLabel && (
                    <span className="text-slate-500 font-mono tabular-nums shrink-0">
                      {sizeLabel}
                    </span>
                  )}
                </div>

                {att.extractedText && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedMap((prev) => ({ ...prev, [idx]: !prev[idx] }))
                    }
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 bg-white text-[11px] font-medium text-[#0B2240] hover:bg-slate-100 cursor-pointer shrink-0"
                  >
                    <span>{isOpen ? 'Hide text' : 'View text'}</span>
                    {isOpen ? (
                      <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>

              {isOpen && att.extractedText && (
                <div
                  dir="auto"
                  className="mt-2 pt-2 border-t border-slate-200 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto bg-white rounded p-2.5 border border-slate-200"
                >
                  {att.extractedText}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
