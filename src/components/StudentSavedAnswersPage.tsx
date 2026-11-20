import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bookmark,
  HelpCircle,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { deleteBookmark, fetchCourses, fetchStudentBookmarks } from '../api';
import { formatCourse } from '../courses';
import { formatUserError } from '../firebase';
import type { BookmarkItem } from '../types';
import { FormattedText } from './FormattedText';
import { Spinner } from './Spinner';

interface StudentSavedAnswersPageProps {
  studentUid: string;
  onAskForHelp: () => void;
}

function formatDateOnly(raw: string | undefined): string {
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return raw;
  return new Date(parsed).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const StudentSavedAnswersPage: React.FC<StudentSavedAnswersPageProps> = ({
  studentUid,
  onAskForHelp,
}) => {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [courses, setCourses] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [courseFilter, setCourseFilter] = useState('ALL');

  const loadSavedAnswers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [list, courseList] = await Promise.all([
        fetchStudentBookmarks(studentUid),
        fetchCourses().catch(() => [] as string[]),
      ]);
      setBookmarks(list);
      if (courseList.length > 0) {
        setCourses(courseList);
      }
    } catch (err) {
      setError(
        formatUserError(err, 'Could not load your saved answers. Please try again.')
      );
    } finally {
      setIsLoading(false);
    }
  }, [studentUid]);

  useEffect(() => {
    void loadSavedAnswers();
  }, [loadSavedAnswers]);

  const handleDelete = async (bookmarkId: string) => {
    setDeletingId(bookmarkId);
    setError(null);
    try {
      await deleteBookmark(bookmarkId);
      setBookmarks((prev) => prev.filter((b) => b.id !== bookmarkId));
    } catch (err) {
      setError(formatUserError(err, 'Could not delete saved answer.'));
    } finally {
      setDeletingId(null);
    }
  };

  const courseOptions = useMemo(() => {
    return Array.from(
      new Set([...courses, ...bookmarks.map((b) => b.course).filter(Boolean)])
    ).sort((a, b) => a.localeCompare(b));
  }, [courses, bookmarks]);

  const filteredBookmarks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return bookmarks.filter((bm) => {
      if (courseFilter !== 'ALL' && bm.course !== courseFilter) return false;
      if (!q) return true;
      return (
        bm.title.toLowerCase().includes(q) ||
        bm.topic.toLowerCase().includes(q) ||
        bm.note.toLowerCase().includes(q) ||
        formatCourse(bm.course).toLowerCase().includes(q)
      );
    });
  }, [bookmarks, courseFilter, searchQuery]);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#0B2240] flex items-center gap-2.5">
              <Bookmark className="w-6 h-6" aria-hidden="true" />
              <span>Saved answers</span>
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Review AI explanations, study packs, and personal reminders you saved during study sessions.
            </p>
          </div>

          <button
            type="button"
            disabled={isLoading}
            onClick={() => void loadSavedAnswers()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>

        {/* Search & Course Filter */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
          <div className="relative flex-1">
            <Search
              className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search saved answers, topics, or notes..."
              aria-label="Search saved answers"
              className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
            />
          </div>

          <select
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
            aria-label="Filter saved answers by course"
            className="w-full sm:w-64 min-h-[42px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
          >
            <option value="ALL">All courses</option>
            {courseOptions.map((code) => (
              <option key={code} value={code}>
                {formatCourse(code)}
              </option>
            ))}
          </select>
        </div>
      </section>

      {isLoading && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <Spinner label="Loading saved answers..." />
        </div>
      )}

      {error && !isLoading && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm text-red-800"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </span>
          <button
            type="button"
            onClick={() => void loadSavedAnswers()}
            className="px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && bookmarks.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
          <p className="font-display text-base font-semibold text-[#0B2240]">
            No saved answers yet
          </p>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Save any AI explanation, question feedback, or study pack while asking for help to keep it handy for revision.
          </p>
          <div className="pt-1">
            <button
              type="button"
              onClick={onAskForHelp}
              className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
            >
              <HelpCircle className="w-4 h-4" aria-hidden="true" />
              <span>Ask for help</span>
            </button>
          </div>
        </div>
      )}

      {!isLoading && !error && bookmarks.length > 0 && filteredBookmarks.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
          <p className="font-display text-base font-semibold text-[#0B2240]">
            No matching saved answers
          </p>
          <p className="text-sm text-slate-500">
            Try clearing your search or switching the course filter.
          </p>
        </div>
      )}

      {!isLoading && !error && filteredBookmarks.length > 0 && (
        <div className="space-y-4">
          {filteredBookmarks.map((bm) => (
            <article
              key={bm.id}
              className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-[#0B2240] bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                      {formatCourse(bm.course)}
                    </span>
                    <span className="text-xs font-semibold text-slate-700">{bm.topic}</span>
                    {bm.createdAt && (
                      <span className="text-xs text-slate-400">
                        · {formatDateOnly(bm.createdAt)}
                      </span>
                    )}
                  </div>
                  <h2 className="font-display text-base font-semibold text-[#0B2240]">
                    {bm.title}
                  </h2>
                </div>

                <button
                  type="button"
                  disabled={deletingId === bm.id}
                  onClick={() => void handleDelete(bm.id)}
                  aria-label={`Delete saved answer ${bm.title}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{deletingId === bm.id ? 'Removing...' : 'Delete'}</span>
                </button>
              </div>

              <div
                dir="auto"
                className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-800"
              >
                <FormattedText text={bm.note} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};
