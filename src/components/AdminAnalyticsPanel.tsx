import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  Download,
  RefreshCw,
} from 'lucide-react';
import { fetchAdminAnalyticsDataset, fetchCourses } from '../api';
import { formatCourse } from '../courses';
import { formatUserError } from '../firebase';
import type { AdminAnalyticsDataset } from '../types';
import { Spinner } from './Spinner';

type DateRangeKey = '7d' | '30d' | 'all';

const RANGE_OPTIONS: Array<{ id: DateRangeKey; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
];

function parseDateMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function getMondayKey(dateMs: number): { key: string; label: string } {
  const d = new Date(dateMs);
  const utcDay = d.getUTCDay();
  const diffToMonday = utcDay === 0 ? -6 : 1 - utcDay;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
  const key = monday.toISOString().slice(0, 10);
  const label = monday.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return { key, label };
}

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const AdminAnalyticsPanel: React.FC = () => {
  const [dataset, setDataset] = useState<AdminAnalyticsDataset | null>(null);
  const [courseCodes, setCourseCodes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DateRangeKey>('30d');

  const loadAnalytics = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [data, dynamicCourses] = await Promise.all([
        fetchAdminAnalyticsDataset(),
        fetchCourses().catch(() => [] as string[]),
      ]);
      setDataset(data);
      setCourseCodes(dynamicCourses);
    } catch (err) {
      setError(
        formatUserError(err, 'Could not load usage analytics right now.')
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  const metrics = useMemo(() => {
    if (!dataset) return null;
    const now = Date.now();
    const cutoffMs =
      range === '7d'
        ? now - 7 * 86_400_000
        : range === '30d'
          ? now - 30 * 86_400_000
          : null;
    const sevenDaysCutoff = now - 7 * 86_400_000;

    const inRange = (rawDate: string | undefined): boolean => {
      if (cutoffMs === null) return true;
      const ms = parseDateMs(rawDate);
      if (ms === null) return false;
      return ms >= cutoffMs;
    };

    const filteredRequests = dataset.requests.filter((r) => inRange(r.createdAt));

    const totalRequests = filteredRequests.length;
    const resolvedByAiCount = filteredRequests.filter(
      (r) => r.status === 'Resolved by AI'
    ).length;
    const escalatedToTutorCount = filteredRequests.filter((r) =>
      ['Escalated to tutor', 'Booked with tutor', 'Waitlist'].includes(r.status)
    ).length;

    const resolvedPct =
      totalRequests > 0 ? Math.round((resolvedByAiCount / totalRequests) * 100) : 0;
    const escalatedPct =
      totalRequests > 0 ? Math.round((escalatedToTutorCount / totalRequests) * 100) : 0;

    // Requests per course (code + full name)
    const courseCounts = new Map<string, number>();
    courseCodes.forEach((c) => courseCounts.set(c, 0));
    filteredRequests.forEach((r) => {
      if (!r.course) return;
      courseCounts.set(r.course, (courseCounts.get(r.course) || 0) + 1);
    });
    const requestsPerCourse = Array.from(courseCounts.entries())
      .map(([code, count]) => ({
        code,
        label: formatCourse(code),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

    // Requests per week
    const weekMap = new Map<string, { key: string; label: string; count: number }>();
    filteredRequests.forEach((r) => {
      const ms = parseDateMs(r.createdAt);
      if (ms === null) return;
      const wk = getMondayKey(ms);
      const existing = weekMap.get(wk.key);
      if (existing) {
        existing.count += 1;
      } else {
        weekMap.set(wk.key, { key: wk.key, label: wk.label, count: 1 });
      }
    });
    const requestsPerWeek = Array.from(weekMap.values()).sort((a, b) =>
      a.key.localeCompare(b.key)
    );

    // Bookings per tutor
    const filteredBookings = dataset.bookings.filter((b) => {
      if (b.status !== 'booked' && b.status !== 'completed') return false;
      return inRange(b.date || b.createdAt);
    });
    const tutorMap = new Map<string, number>();
    filteredBookings.forEach((b) => {
      const name = b.tutorName.trim() || 'Tutor';
      tutorMap.set(name, (tutorMap.get(name) || 0) + 1);
    });
    const bookingsPerTutor = Array.from(tutorMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    // Active students this week (last 7 days across requests, retests, bookings, student activity)
    const activeStudentSet = new Set<string>();
    dataset.requests.forEach((r) => {
      const ms = parseDateMs(r.createdAt);
      if (r.studentUid && ms !== null && ms >= sevenDaysCutoff) {
        activeStudentSet.add(r.studentUid);
      }
    });
    dataset.retests.forEach((rt) => {
      const ms = parseDateMs(rt.createdAt);
      if (rt.studentUid && ms !== null && ms >= sevenDaysCutoff) {
        activeStudentSet.add(rt.studentUid);
      }
    });
    dataset.bookings.forEach((b) => {
      const ms = parseDateMs(b.createdAt || b.date);
      if (b.studentUid && ms !== null && ms >= sevenDaysCutoff) {
        activeStudentSet.add(b.studentUid);
      }
    });
    dataset.activity.forEach((act) => {
      const ms = parseDateMs(act.createdAt);
      if (act.actorRole === 'student' && act.actorUid && ms !== null && ms >= sevenDaysCutoff) {
        activeStudentSet.add(act.actorUid);
      }
    });
    const activeStudentsThisWeek = activeStudentSet.size;

    // Average retest score in selected date range
    const filteredRetests = dataset.retests.filter((rt) => inRange(rt.createdAt));
    const retestScores: number[] = filteredRetests.map((rt) =>
      rt.score <= 1 ? rt.score * 100 : rt.score
    );
    if (retestScores.length === 0) {
      filteredRequests.forEach((r) => {
        if (typeof r.retestScore === 'number') {
          retestScores.push(r.retestScore <= 1 ? r.retestScore * 100 : r.retestScore);
        }
      });
    }
    const avgRetestScore =
      retestScores.length > 0
        ? Math.round(retestScores.reduce((sum, s) => sum + s, 0) / retestScores.length)
        : null;

    // Most asked topics
    const topicMap = new Map<string, { topic: string; course: string; count: number }>();
    filteredRequests.forEach((r) => {
      const cleanTopic = (r.topic || '').trim();
      if (!cleanTopic || cleanTopic.toLowerCase() === 'general topic') return;
      const key = `${r.course}::${cleanTopic.toLowerCase()}`;
      const existing = topicMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        topicMap.set(key, { topic: cleanTopic, course: r.course, count: 1 });
      }
    });
    const topTopics = Array.from(topicMap.values())
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
      .slice(0, 8);

    return {
      totalRequests,
      resolvedByAiCount,
      escalatedToTutorCount,
      resolvedPct,
      escalatedPct,
      requestsPerCourse,
      requestsPerWeek,
      bookingsPerTutor,
      totalTutorBookings: filteredBookings.length,
      activeStudentsThisWeek,
      avgRetestScore,
      retestSampleCount: retestScores.length,
      topTopics,
    };
  }, [dataset, range, courseCodes]);

  const handleExportCsv = () => {
    if (!metrics) return;
    const rangeLabel = RANGE_OPTIONS.find((o) => o.id === range)?.label || range;
    const lines: string[] = [];

    lines.push(['Section', 'Label', 'Detail', 'Value'].map(escapeCsvCell).join(','));
    lines.push(['Summary', 'Date range', '', rangeLabel].map(escapeCsvCell).join(','));
    lines.push(['Summary', 'Total requests', '', metrics.totalRequests].map(escapeCsvCell).join(','));
    lines.push(
      ['Summary', 'Resolved by AI (%)', `${metrics.resolvedByAiCount} requests`, `${metrics.resolvedPct}%`]
        .map(escapeCsvCell)
        .join(',')
    );
    lines.push(
      [
        'Summary',
        'Escalated to tutor (%)',
        `${metrics.escalatedToTutorCount} requests`,
        `${metrics.escalatedPct}%`,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
    lines.push(
      ['Summary', 'Active students this week', 'Last 7 days', metrics.activeStudentsThisWeek]
        .map(escapeCsvCell)
        .join(',')
    );
    lines.push(
      [
        'Summary',
        'Average retest score',
        `${metrics.retestSampleCount} retests`,
        metrics.avgRetestScore !== null ? `${metrics.avgRetestScore}%` : 'No data',
      ]
        .map(escapeCsvCell)
        .join(',')
    );

    metrics.requestsPerCourse.forEach((row) => {
      lines.push(['Requests per course', row.label, '', row.count].map(escapeCsvCell).join(','));
    });
    metrics.requestsPerWeek.forEach((row) => {
      lines.push(
        ['Requests per week', `Week of ${row.label}`, row.key, row.count]
          .map(escapeCsvCell)
          .join(',')
      );
    });
    metrics.bookingsPerTutor.forEach((row) => {
      lines.push(['Bookings per tutor', row.name, '', row.count].map(escapeCsvCell).join(','));
    });
    metrics.topTopics.forEach((row) => {
      lines.push(
        ['Most asked topics', row.topic, formatCourse(row.course), row.count]
          .map(escapeCsvCell)
          .join(',')
      );
    });

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `sanad-analytics-${range}-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const maxCourseCount = Math.max(
    1,
    ...(metrics?.requestsPerCourse.map((c) => c.count) || [1])
  );
  const maxWeekCount = Math.max(
    1,
    ...(metrics?.requestsPerWeek.map((w) => w.count) || [1])
  );
  const maxTutorCount = Math.max(
    1,
    ...(metrics?.bookingsPerTutor.map((t) => t.count) || [1])
  );
  const maxTopicCount = Math.max(
    1,
    ...(metrics?.topTopics.map((t) => t.count) || [1])
  );

  return (
    <div className="space-y-6">
      {/* Analytics Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#0B2240] flex items-center gap-2">
            <BarChart3 className="w-5 h-5" aria-hidden="true" />
            <span>Usage Analytics</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Track course demand, AI resolution rates, tutoring bookings, and student activity.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Date Range Filter */}
          <div
            role="group"
            aria-label="Analytics date range"
            className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRange(opt.id)}
                className={`px-3 py-1.5 min-h-[34px] text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  range === opt.id
                    ? 'bg-white text-[#0B2240] shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={isLoading || !metrics}
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Export CSV</span>
          </button>

          <button
            type="button"
            disabled={isLoading}
            onClick={() => void loadAnalytics()}
            className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <Spinner label="Loading usage analytics..." />
        </div>
      )}

      {error && !isLoading && (
        <div
          role="alert"
          className="p-5 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </span>
          <button
            type="button"
            onClick={() => void loadAnalytics()}
            className="px-4 py-2 min-h-[40px] rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && metrics && (
        <>
          {/* Summary KPI Tiles */}
          <section
            aria-label="Key usage metrics"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4"
          >
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Total requests</div>
              <div className="mt-2 font-mono text-3xl font-semibold text-[#0B2240] tabular-nums">
                {metrics.totalRequests}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {RANGE_OPTIONS.find((o) => o.id === range)?.label}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Resolved by AI</div>
              <div className="mt-2 font-mono text-3xl font-semibold text-emerald-700 tabular-nums">
                {metrics.resolvedPct}%
              </div>
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                {metrics.resolvedByAiCount} of {metrics.totalRequests} requests
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Escalated to tutor</div>
              <div className="mt-2 font-mono text-3xl font-semibold text-amber-700 tabular-nums">
                {metrics.escalatedPct}%
              </div>
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                {metrics.escalatedToTutorCount} of {metrics.totalRequests} requests
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Active students this week</div>
              <div className="mt-2 font-mono text-3xl font-semibold text-[#0B2240] tabular-nums">
                {metrics.activeStudentsThisWeek}
              </div>
              <p className="mt-1 text-xs text-slate-500">Last 7 days</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="text-xs font-medium text-slate-500">Average retest score</div>
              <div className="mt-2 font-mono text-3xl font-semibold text-[#0B2240] tabular-nums">
                {metrics.avgRetestScore !== null ? `${metrics.avgRetestScore}%` : '—'}
              </div>
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                {metrics.retestSampleCount} completed retest{metrics.retestSampleCount === 1 ? '' : 's'}
              </p>
            </div>
          </section>

          {/* Charts Grid: Requests per Course & Requests per Week */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Requests per Course */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-base font-semibold text-[#0B2240]">
                  Requests per course
                </h3>
                <span className="text-xs text-slate-500 tabular-nums">
                  {metrics.totalRequests} total
                </span>
              </div>

              {metrics.requestsPerCourse.every((c) => c.count === 0) ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  No course requests recorded in this date range.
                </p>
              ) : (
                <div className="space-y-3.5">
                  {metrics.requestsPerCourse.map((row) => {
                    const widthPct = Math.round((row.count / maxCourseCount) * 100);
                    return (
                      <div key={row.code} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-slate-800 truncate">{row.label}</span>
                          <span className="font-mono font-semibold text-[#0B2240] tabular-nums shrink-0">
                            {row.count}
                          </span>
                        </div>
                        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#0B2240] rounded-full transition-all"
                            style={{ width: `${row.count > 0 ? Math.max(4, widthPct) : 0}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Requests per Week */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-base font-semibold text-[#0B2240]">
                  Requests per week
                </h3>
                <span className="text-xs text-slate-500 tabular-nums">
                  {metrics.requestsPerWeek.length} week{metrics.requestsPerWeek.length === 1 ? '' : 's'}
                </span>
              </div>

              {metrics.requestsPerWeek.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  No weekly request data in this date range.
                </p>
              ) : (
                <div className="pt-2">
                  <div
                    role="img"
                    aria-label="Bar chart showing requests per week"
                    className="h-48 flex items-end gap-2 sm:gap-3 border-b border-slate-200 pb-2 overflow-x-auto"
                  >
                    {metrics.requestsPerWeek.map((wk) => {
                      const heightPct = Math.max(8, Math.round((wk.count / maxWeekCount) * 100));
                      return (
                        <div
                          key={wk.key}
                          className="flex-1 min-w-[48px] h-full flex flex-col items-center justify-end gap-1.5"
                        >
                          <span className="font-mono text-xs font-semibold text-[#0B2240] tabular-nums">
                            {wk.count}
                          </span>
                          <div className="w-full max-w-[42px] flex-1 flex items-end">
                            <div
                              className="w-full bg-[#0B2240] rounded-t-md transition-all"
                              style={{ height: `${heightPct}%` }}
                              title={`Week of ${wk.label}: ${wk.count} requests`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex items-center gap-2 sm:gap-3 overflow-x-auto">
                    {metrics.requestsPerWeek.map((wk) => (
                      <div
                        key={wk.key}
                        className="flex-1 min-w-[48px] text-center text-[11px] font-medium text-slate-600 truncate"
                      >
                        {wk.label}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Bookings per Tutor & Most Asked Topics */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Bookings per Tutor */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-base font-semibold text-[#0B2240]">
                  Bookings per tutor
                </h3>
                <span className="text-xs text-slate-500 tabular-nums">
                  {metrics.totalTutorBookings} booking{metrics.totalTutorBookings === 1 ? '' : 's'}
                </span>
              </div>

              {metrics.bookingsPerTutor.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  No tutor bookings recorded in this date range.
                </p>
              ) : (
                <div className="space-y-3.5">
                  {metrics.bookingsPerTutor.map((row) => {
                    const widthPct = Math.round((row.count / maxTutorCount) * 100);
                    return (
                      <div key={row.name} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-slate-800 truncate">{row.name}</span>
                          <span className="font-mono font-semibold text-[#0B2240] tabular-nums shrink-0">
                            {row.count}
                          </span>
                        </div>
                        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-700 rounded-full transition-all"
                            style={{ width: `${Math.max(4, widthPct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Most Asked Topics */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-base font-semibold text-[#0B2240]">
                  Most asked topics
                </h3>
                <span className="text-xs text-slate-500">Top {metrics.topTopics.length}</span>
              </div>

              {metrics.topTopics.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  No topics recorded in this date range yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {metrics.topTopics.map((item) => {
                    const widthPct = Math.round((item.count / maxTopicCount) * 100);
                    return (
                      <div key={`${item.course}-${item.topic}`} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                          <div className="min-w-0 truncate">
                            <span className="font-semibold text-slate-900">{item.topic}</span>
                            {item.course && (
                              <span className="text-slate-500"> · {formatCourse(item.course)}</span>
                            )}
                          </div>
                          <span className="font-mono font-semibold text-[#0B2240] tabular-nums shrink-0">
                            {item.count}
                          </span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-600 rounded-full transition-all"
                            style={{ width: `${Math.max(4, widthPct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
};
