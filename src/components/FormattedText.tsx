import React from 'react';

interface FormattedTextProps {
  text: string;
  className?: string;
}

function normalizeStructuredLines(raw: string): string[] {
  let normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // Insert line breaks before common brief labels if Gemini or stored rows put them inline
  normalized = normalized
    .replace(
      /\s+(?=(?:Student(?:'s)? Problem|Topic|Weak Sub-?topics?|Questions? (?:They )?Got Wrong|Incorrect Questions?|Suggested 30-?Minute Plan|30-?Minute Plan|Session Plan):)/gi,
      '\n'
    )
    // Insert line breaks before "Step 1:", "Step 2:", or Arabic "الخطوة 1:" when inline
    .replace(/(?<!^)(?<!\n)\s+(?=(?:Step\s+\d+[:.)]|الخطوة\s+\d+[:.)]))/gi, '\n')
    // Insert line breaks before numbered list items like " 1. ", " 2. ", " 3. " when inline
    .replace(/(?<!^)(?<!\n)\s+(?=\d+\.\s+[A-Za-z\u0600-\u06FF])/g, '\n');

  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export const FormattedText: React.FC<FormattedTextProps> = ({ text, className = '' }) => {
  const lines = normalizeStructuredLines(text);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div dir="auto" className={`space-y-2.5 ${className}`}>
      {lines.map((line, index) => {
        // Check for numbered step: "1. ..." or "Step 1: ..."
        const stepMatch = line.match(/^((?:Step\s+\d+|الخطوة\s+\d+)[:.)]?|\d+[.)])\s*(.+)$/i);
        if (stepMatch) {
          const [, marker, content] = stepMatch;
          return (
            <div key={index} className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center px-2 py-0.5 min-w-[28px] rounded bg-[#0B2240]/10 text-[#0B2240] font-mono text-xs font-semibold shrink-0 mt-0.5">
                {marker.replace(/[:.)]+$/, '')}
              </span>
              <p className="text-sm sm:text-[15px] text-slate-800 leading-relaxed flex-1">
                {content}
              </p>
            </div>
          );
        }

        // Check for labelled section line: "Topic: Subnetting"
        const labelMatch = line.match(
          /^([A-Za-z0-9\s'-]{2,40}):\s*(.*)$/
        );
        if (labelMatch) {
          const [, label, value] = labelMatch;
          const isHeadingOnly = value.trim().length === 0;
          if (isHeadingOnly) {
            return (
              <p
                key={index}
                className="pt-1 text-xs font-semibold uppercase tracking-wide text-[#0B2240]"
              >
                {label}
              </p>
            );
          }
          return (
            <p key={index} className="text-sm sm:text-[15px] text-slate-800 leading-relaxed">
              <strong className="font-semibold text-[#0B2240]">{label}:</strong> {value}
            </p>
          );
        }

        // Check for bulleted line "- ..." or "* ..."
        const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
        if (bulletMatch) {
          return (
            <div key={index} className="flex items-start gap-2.5 pl-1">
              <span className="text-[#0B2240] font-bold leading-relaxed" aria-hidden="true">
                •
              </span>
              <p className="text-sm sm:text-[15px] text-slate-800 leading-relaxed flex-1">
                {bulletMatch[1]}
              </p>
            </div>
          );
        }

        return (
          <p key={index} className="text-sm sm:text-[15px] text-slate-800 leading-relaxed">
            {line}
          </p>
        );
      })}
    </div>
  );
};
