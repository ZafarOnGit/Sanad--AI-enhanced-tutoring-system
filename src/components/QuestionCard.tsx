import React, { useState } from 'react';
import { AlertCircle, Bookmark, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { gradeWrittenAnswer } from '../api';
import { formatUserError } from '../firebase';
import type { DiagnosticQuestion } from '../types';
import { Spinner } from './Spinner';

export interface QuestionAttemptResult {
  correct: boolean;
  studentAnswerText: string;
  correctAnswerText: string;
  feedbackText: string;
}

interface QuestionCardProps {
  question: DiagnosticQuestion;
  course: string;
  aiLabel?: string;
  groupName: string;
  attempt: QuestionAttemptResult | null;
  onComplete: (result: QuestionAttemptResult) => void;
  onBookmarkAnswer?: () => Promise<void>;
}

function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

export const QuestionCard: React.FC<QuestionCardProps> = ({
  question,
  course,
  aiLabel = 'AI-generated',
  groupName,
  attempt,
  onComplete,
  onBookmarkAnswer,
}) => {
  const [selectedSingle, setSelectedSingle] = useState<number | null>(null);
  const [selectedMultiple, setSelectedMultiple] = useState<number[]>([]);
  const [writtenText, setWrittenText] = useState('');

  const [isGrading, setIsGrading] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [isBookmarking, setIsBookmarking] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [bookmarkErr, setBookmarkErr] = useState<string | null>(null);

  const isRtl = containsArabic(question.question);
  const isLocked = attempt !== null;

  const handleCheckSingle = () => {
    if (isLocked || selectedSingle === null) return;
    const correctIdx = question.correctIndexes[0] ?? 0;
    const isCorrect = selectedSingle === correctIdx;
    onComplete({
      correct: isCorrect,
      studentAnswerText: question.options[selectedSingle] ?? '',
      correctAnswerText: question.options[correctIdx] ?? '',
      feedbackText: question.explanation,
    });
  };

  const toggleMultipleOption = (idx: number) => {
    if (isLocked) return;
    setSelectedMultiple((prev) =>
      prev.includes(idx) ? prev.filter((item) => item !== idx) : [...prev, idx]
    );
  };

  const handleCheckMultiple = () => {
    if (isLocked || selectedMultiple.length === 0) return;
    const chosenSorted = [...selectedMultiple].sort((a, b) => a - b);
    const expectedSorted = [...question.correctIndexes].sort((a, b) => a - b);
    const isCorrect =
      chosenSorted.length === expectedSorted.length &&
      chosenSorted.every((val, i) => val === expectedSorted[i]);

    onComplete({
      correct: isCorrect,
      studentAnswerText: chosenSorted.map((i) => question.options[i]).join(', '),
      correctAnswerText: expectedSorted.map((i) => question.options[i]).join(', '),
      feedbackText: question.explanation,
    });
  };

  const handleCheckWritten = async () => {
    const trimmed = writtenText.trim();
    if (isLocked || !trimmed || isGrading) return;
    setIsGrading(true);
    setGradeError(null);
    try {
      const graded = await gradeWrittenAnswer({
        course,
        question: question.question,
        modelAnswer: question.modelAnswer,
        studentAnswer: trimmed,
      });
      onComplete({
        correct: graded.correct,
        studentAnswerText: trimmed,
        correctAnswerText: question.modelAnswer,
        feedbackText: graded.feedback || question.explanation,
      });
    } catch (err) {
      setGradeError(
        formatUserError(err, "Sanad's AI is busy. Please try again.")
      );
    } finally {
      setIsGrading(false);
    }
  };

  const typeLabel =
    question.type === 'multiple'
      ? isRtl
        ? 'اختر كل ما ينطبق'
        : 'Select all that apply'
      : question.type === 'written'
        ? isRtl
          ? 'إجابة كتابية قصيرة'
          : 'Short written answer'
        : isRtl
          ? 'اختر إجابة واحدة'
          : 'Select one answer';

  return (
    <div className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-slate-500">{typeLabel}</p>
        <h3 className="font-display text-lg sm:text-xl font-semibold text-slate-900 leading-snug">
          {question.question}
        </h3>
      </div>

      {/* SINGLE CHOICE (Radio buttons) */}
      {question.type === 'single' && (
        <div className="space-y-2.5" role="radiogroup" aria-label={question.question}>
          {question.options.map((optionText, idx) => {
            const isSelected = selectedSingle === idx;
            const isCorrectOption = question.correctIndexes.includes(idx);

            let style =
              'bg-white border-slate-300 text-slate-900 hover:border-[#0B2240] hover:bg-slate-50';
            if (isLocked) {
              if (isCorrectOption) {
                style = 'bg-emerald-50 border-emerald-600 text-emerald-950';
              } else if (isSelected && !isCorrectOption) {
                style = 'bg-red-50 border-red-600 text-red-950';
              } else {
                style = 'bg-slate-50 border-slate-200 text-slate-500';
              }
            } else if (isSelected) {
              style = 'bg-slate-50 border-[#0B2240] ring-1 ring-[#0B2240] text-slate-900';
            }

            return (
              <label
                key={idx}
                className={`w-full text-start px-4 py-3.5 min-h-[48px] rounded-lg border text-sm font-medium transition-colors flex items-center justify-between gap-3 ${style} ${
                  isLocked ? 'cursor-default' : 'cursor-pointer'
                }`}
              >
                <span className="flex items-start gap-3">
                  <input
                    type="radio"
                    name={groupName}
                    value={idx}
                    disabled={isLocked}
                    checked={isSelected}
                    onChange={() => setSelectedSingle(idx)}
                    className="mt-1 h-4 w-4 accent-[#0B2240] shrink-0 cursor-pointer"
                  />
                  <span>{optionText}</span>
                </span>
                {isLocked && isCorrectOption && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 shrink-0">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    <span>Correct</span>
                  </span>
                )}
                {isLocked && isSelected && !isCorrectOption && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 shrink-0">
                    <XCircle className="w-4 h-4" aria-hidden="true" />
                    <span>Incorrect</span>
                  </span>
                )}
              </label>
            );
          })}

          {!isLocked && (
            <div className="pt-2">
              <button
                type="button"
                disabled={selectedSingle === null}
                onClick={handleCheckSingle}
                className="inline-flex items-center justify-center px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-45 transition-colors cursor-pointer"
              >
                Check
              </button>
            </div>
          )}
        </div>
      )}

      {/* MULTIPLE CHOICE (Checkboxes + Check button) */}
      {question.type === 'multiple' && (
        <div className="space-y-2.5" role="group" aria-label={question.question}>
          {question.options.map((optionText, idx) => {
            const isSelected = selectedMultiple.includes(idx);
            const isCorrectOption = question.correctIndexes.includes(idx);

            let style =
              'bg-white border-slate-300 text-slate-900 hover:border-[#0B2240] hover:bg-slate-50';
            if (isLocked) {
              if (isCorrectOption && isSelected) {
                style = 'bg-emerald-50 border-emerald-600 text-emerald-950';
              } else if (isCorrectOption && !isSelected) {
                style = 'bg-emerald-50/60 border-emerald-500 text-emerald-900';
              } else if (!isCorrectOption && isSelected) {
                style = 'bg-red-50 border-red-600 text-red-950';
              } else {
                style = 'bg-slate-50 border-slate-200 text-slate-500';
              }
            } else if (isSelected) {
              style = 'bg-slate-50 border-[#0B2240] ring-1 ring-[#0B2240] text-slate-900';
            }

            return (
              <label
                key={idx}
                className={`w-full text-start px-4 py-3.5 min-h-[48px] rounded-lg border text-sm font-medium transition-colors flex items-center justify-between gap-3 ${style} ${
                  isLocked ? 'cursor-default' : 'cursor-pointer'
                }`}
              >
                <span className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    disabled={isLocked}
                    checked={isSelected}
                    onChange={() => toggleMultipleOption(idx)}
                    className="mt-1 h-4 w-4 rounded accent-[#0B2240] shrink-0 cursor-pointer"
                  />
                  <span>{optionText}</span>
                </span>
                {isLocked && isCorrectOption && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 shrink-0">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    <span>{isSelected ? 'Correct' : 'Should select'}</span>
                  </span>
                )}
                {isLocked && !isCorrectOption && isSelected && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 shrink-0">
                    <XCircle className="w-4 h-4" aria-hidden="true" />
                    <span>Incorrect</span>
                  </span>
                )}
              </label>
            );
          })}

          {!isLocked && (
            <div className="pt-2">
              <button
                type="button"
                disabled={selectedMultiple.length === 0}
                onClick={handleCheckMultiple}
                className="inline-flex items-center justify-center px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-45 transition-colors cursor-pointer"
              >
                Check
              </button>
            </div>
          )}
        </div>
      )}

      {/* WRITTEN ANSWER (Text box + Gemini grading) */}
      {question.type === 'written' && (
        <div className="space-y-3">
          <textarea
            rows={3}
            dir="auto"
            disabled={isLocked || isGrading}
            value={writtenText}
            onChange={(e) => setWrittenText(e.target.value)}
            placeholder={
              isRtl ? 'اكتب إجابتك القصيرة هنا...' : 'Write your short answer here...'
            }
            className="w-full px-3.5 py-3 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B2240] focus:border-[#0B2240] disabled:bg-slate-50"
          />

          {isGrading && <Spinner label="Checking your written answer..." />}

          {gradeError && !isGrading && (
            <div
              role="alert"
              className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
            >
              <div className="flex items-center gap-2 text-sm text-amber-900">
                <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                <span>{gradeError}</span>
              </div>
              <button
                type="button"
                onClick={() => void handleCheckWritten()}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {!isLocked && (
            <div>
              <button
                type="button"
                disabled={writtenText.trim().length === 0 || isGrading}
                onClick={() => void handleCheckWritten()}
                className="inline-flex items-center justify-center px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-45 transition-colors cursor-pointer"
              >
                Check
              </button>
            </div>
          )}
        </div>
      )}

      {/* Instant Feedback Box */}
      {attempt && (
        <div
          aria-live="polite"
          className={`p-4 rounded-lg border space-y-2 ${
            attempt.correct
              ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
              : 'bg-red-50 border-red-200 text-red-950'
          }`}
        >
          <div className="flex items-center justify-between gap-2 text-xs font-semibold">
            <span className="inline-flex items-center gap-1.5">
              {attempt.correct ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                  <span>{isRtl ? 'إجابة صحيحة' : 'Correct'}</span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-red-700" aria-hidden="true" />
                  <span>{isRtl ? 'إجابة غير صحيحة' : 'Incorrect'}</span>
                </>
              )}
            </span>
            <span className="font-normal opacity-75">{aiLabel}</span>
          </div>
          <p className="text-sm leading-relaxed">{attempt.feedbackText}</p>
          {question.type === 'written' && question.modelAnswer && (
            <p className="text-xs pt-1 border-t border-current/15 opacity-90">
              <strong className="font-semibold">
                {isRtl ? 'الإجابة النموذجية:' : 'Model answer:'}
              </strong>{' '}
              {question.modelAnswer}
            </p>
          )}
          {onBookmarkAnswer && (
            <div className="pt-2 border-t border-current/15 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                disabled={isBookmarking || isBookmarked}
                onClick={async () => {
                  if (isBookmarking || isBookmarked) return;
                  setIsBookmarking(true);
                  setBookmarkErr(null);
                  try {
                    await onBookmarkAnswer();
                    setIsBookmarked(true);
                  } catch (err) {
                    setBookmarkErr(
                      formatUserError(err, 'Could not save answer.')
                    );
                  } finally {
                    setIsBookmarking(false);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] text-xs font-medium bg-white/90 text-[#0B2240] border border-current/20 rounded-md hover:bg-white disabled:opacity-70 transition-colors cursor-pointer"
              >
                {isBookmarked ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                    <span>{isRtl ? 'تم الحفظ' : 'Saved'}</span>
                  </>
                ) : (
                  <>
                    <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{isBookmarking ? 'Saving...' : isRtl ? 'حفظ الإجابة' : 'Save answer'}</span>
                  </>
                )}
              </button>
              {bookmarkErr && (
                <span className="text-xs text-red-700 font-medium">{bookmarkErr}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
