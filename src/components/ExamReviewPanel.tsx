import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ListChecks,
  X,
  XCircle,
} from 'lucide-react';
import { formatCourse } from '../courses';
import type { DiagnosticItemPayload, DiagnosticQuestion, StoredExamRecord } from '../types';

interface ExamReviewPanelProps {
  course: string;
  topic?: string;
  diagExam?: StoredExamRecord;
  retestExam?: StoredExamRecord;
  initialStage?: 'diagnostic' | 'retest';
  initialFilter?: 'mistakes' | 'all';
  onContinueExam?: (stage: 'diagnostic' | 'studyPack' | 'retest') => void;
  onClose?: () => void;
}

interface MergedQuestionReview {
  index: number;
  answer: DiagnosticItemPayload;
  question?: DiagnosticQuestion;
}

function getQuestionTypeLabel(type?: string): string {
  switch (type) {
    case 'multiple':
      return 'Select all';
    case 'written':
      return 'Written';
    default:
      return 'Single choice';
  }
}

export const ExamReviewPanel: React.FC<ExamReviewPanelProps> = ({
  course,
  topic,
  diagExam,
  retestExam,
  initialStage,
  initialFilter = 'mistakes',
  onContinueExam,
  onClose,
}) => {
  const defaultStage: 'diagnostic' | 'retest' =
    initialStage ||
    (retestExam && retestExam.answers.length > 0 ? 'retest' : 'diagnostic');

  const [stage, setStage] = useState<'diagnostic' | 'retest'>(defaultStage);
  const [filter, setFilter] = useState<'mistakes' | 'all'>(initialFilter);

  const activeExam = stage === 'retest' ? retestExam : diagExam;

  const mergedItems: MergedQuestionReview[] = useMemo(() => {
    if (!activeExam) return [];
    return activeExam.answers.map((ans, idx) => {
      const matchedQuestion =
        activeExam.questions[idx] ||
        activeExam.questions.find((q) => q.question === ans.question);
      return {
        index: idx,
        answer: ans,
        question: matchedQuestion,
      };
    });
  }, [activeExam]);

  const mistakeCount = mergedItems.filter((item) => !item.answer.correct).length;
  const displayedItems =
    filter === 'mistakes'
      ? mergedItems.filter((item) => !item.answer.correct)
      : mergedItems;

  const diagMistakes = diagExam ? diagExam.answers.filter((a) => !a.correct).length : 0;
  const retestMistakes = retestExam ? retestExam.answers.filter((a) => !a.correct).length : 0;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-7 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-[#0B2240] bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
              {formatCourse(course)}
            </span>
            <span className="text-sm font-semibold text-slate-800">
              {topic || activeExam?.topic || 'Exam Review'}
            </span>
          </div>
          <h2 className="font-display text-xl font-bold text-[#0B2240] flex items-center gap-2">
            <ListChecks className="w-5 h-5" aria-hidden="true" />
            <span>Question &amp; Mistake Review</span>
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {onContinueExam && activeExam?.status === 'in_progress' && (
            <button
              type="button"
              onClick={() => onContinueExam(activeExam.stage)}
              className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer"
            >
              <span>
                Continue from Question {Math.min(activeExam.answers.length + 1, Math.max(1, activeExam.totalQuestions))}
              </span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close review"
              className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Stage tabs & Mistake filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {diagExam && (
            <button
              type="button"
              onClick={() => setStage('diagnostic')}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium border cursor-pointer transition-colors ${
                stage === 'diagnostic'
                  ? 'bg-[#0B2240] text-white border-[#0B2240]'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              Diagnostic · {Math.round(diagExam.score * 100)}% ({diagMistakes} mistake{diagMistakes === 1 ? '' : 's'})
            </button>
          )}
          {retestExam && (
            <button
              type="button"
              onClick={() => setStage('retest')}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium border cursor-pointer transition-colors ${
                stage === 'retest'
                  ? 'bg-[#0B2240] text-white border-[#0B2240]'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              Retest · {Math.round(retestExam.score * 100)}% ({retestMistakes} mistake{retestMistakes === 1 ? '' : 's'})
            </button>
          )}
        </div>

        <div className="inline-flex rounded-lg border border-slate-300 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={() => setFilter('mistakes')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
              filter === 'mistakes'
                ? 'bg-white text-[#0B2240] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Mistakes ({mistakeCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
              filter === 'all'
                ? 'bg-white text-[#0B2240] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All answered ({mergedItems.length})
          </button>
        </div>
      </div>

      {/* Progress notice if still in progress */}
      {activeExam && activeExam.status === 'in_progress' && (
        <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-950">
          <span>
            This {activeExam.stage} is still in progress: <strong>{activeExam.answers.length}</strong> of{' '}
            <strong>{activeExam.totalQuestions}</strong> questions attempted.
          </span>
          {onContinueExam && (
            <button
              type="button"
              onClick={() => onContinueExam(activeExam.stage)}
              className="font-semibold underline hover:text-[#0B2240] cursor-pointer"
            >
              Resume exam →
            </button>
          )}
        </div>
      )}

      {/* Empty states */}
      {!activeExam || mergedItems.length === 0 ? (
        <div className="p-6 rounded-xl bg-slate-50 border border-slate-200 text-center text-sm text-slate-600">
          No answered questions recorded for this stage yet.
        </div>
      ) : displayedItems.length === 0 ? (
        <div className="p-6 rounded-xl bg-emerald-50 border border-emerald-200 text-center space-y-2">
          <p className="font-display text-base font-semibold text-emerald-950 flex items-center justify-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-700" aria-hidden="true" />
            <span>No mistakes in this {stage}!</span>
          </p>
          <p className="text-xs text-emerald-800">
            Switch to &ldquo;All answered ({mergedItems.length})&rdquo; above to inspect every question and explanation.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {displayedItems.map(({ index, answer, question }) => {
            const qType = answer.questionType || question?.type;
            const explanationText = answer.feedback || question?.explanation;

            return (
              <article
                key={`${stage}-${index}`}
                className={`rounded-xl border p-4 sm:p-5 space-y-3 ${
                  answer.correct
                    ? 'bg-white border-emerald-200'
                    : 'bg-white border-red-200'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold text-[#0B2240] bg-slate-100 px-2 py-0.5 rounded">
                      Q{index + 1}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium">
                      {getQuestionTypeLabel(qType)}
                    </span>
                    <span className="text-slate-600 font-medium">{answer.subtopic}</span>
                  </div>

                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md border font-semibold ${
                      answer.correct
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : 'bg-red-50 text-red-800 border-red-200'
                    }`}
                  >
                    {answer.correct ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Correct</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Mistake</span>
                      </>
                    )}
                  </span>
                </div>

                <h3
                  dir="auto"
                  className="font-display text-base font-semibold text-slate-900 leading-snug"
                >
                  {answer.question}
                </h3>

                {/* Options breakdown when stored */}
                {question && question.options && question.options.length > 0 && (
                  <ul className="space-y-1.5 text-xs">
                    {question.options.map((opt, optIdx) => {
                      const isCorrectOpt = question.correctIndexes?.includes(optIdx);
                      return (
                        <li
                          key={optIdx}
                          dir="auto"
                          className={`px-3 py-2 rounded-lg border flex items-center justify-between gap-2 ${
                            isCorrectOpt
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-950 font-medium'
                              : 'bg-slate-50 border-slate-200 text-slate-600'
                          }`}
                        >
                          <span>{opt}</span>
                          {isCorrectOpt && (
                            <span className="text-[11px] font-semibold text-emerald-700 shrink-0">
                              Correct option
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div
                    className={`p-3 rounded-lg border ${
                      answer.correct
                        ? 'bg-emerald-50/60 border-emerald-200 text-emerald-950'
                        : 'bg-red-50/70 border-red-200 text-red-950'
                    }`}
                  >
                    <p className="font-semibold mb-1 opacity-80">Your answer</p>
                    <p dir="auto" className="leading-relaxed">
                      {answer.studentAnswer || '—'}
                    </p>
                  </div>

                  <div className="p-3 rounded-lg border bg-emerald-50/60 border-emerald-200 text-emerald-950">
                    <p className="font-semibold mb-1 opacity-80">
                      {qType === 'written' ? 'Model answer' : 'Correct answer'}
                    </p>
                    <p dir="auto" className="leading-relaxed">
                      {answer.correctAnswer || question?.modelAnswer || '—'}
                    </p>
                  </div>
                </div>

                {explanationText && (
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-1">
                    <p className="font-semibold text-[#0B2240] flex items-center gap-1.5">
                      <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Explanation &amp; Feedback</span>
                    </p>
                    <p dir="auto" className="leading-relaxed">
                      {explanationText}
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
