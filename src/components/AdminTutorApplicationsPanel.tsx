import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  GraduationCap,
  Mail,
  RefreshCw,
  Settings,
  Sparkles,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  fetchAllTutorApplicationsAdmin,
  fetchCourses,
  fetchTutorOnboardingSettings,
  reviewTutorApplicationAdmin,
  updateTutorOnboardingSettingsAdmin,
} from '../api';
import { formatCourse, getCourseName } from '../courses';
import { formatUserError } from '../firebase';
import type {
  TutorApplicationItem,
  TutorApplicationStatus,
  TutorOnboardingSettings,
} from '../types';
import { Spinner } from './Spinner';

interface AdminTutorApplicationsPanelProps {
  adminUid: string;
  adminEmail: string;
  onApplicantPromoted?: () => void;
  onPendingCountChange?: (count: number) => void;
}

function statusBadgeClasses(status: TutorApplicationStatus): string {
  switch (status) {
    case 'approved':
      return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    case 'rejected':
      return 'bg-red-50 text-red-800 border-red-200';
    default:
      return 'bg-amber-50 text-amber-800 border-amber-200';
  }
}

export const AdminTutorApplicationsPanel: React.FC<AdminTutorApplicationsPanelProps> = ({
  adminUid,
  adminEmail,
  onApplicantPromoted,
  onPendingCountChange,
}) => {
  const [applications, setApplications] = useState<TutorApplicationItem[]>([]);
  const [catalogCourses, setCatalogCourses] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | TutorApplicationStatus>('all');

  // Screening settings state
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<TutorOnboardingSettings>({
    minGpa: 3.0,
    requireFirstSemesterCompleted: true,
    requireFacultyDocs: false,
  });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  // Per-application review drafts
  const [selectedCoursesMap, setSelectedCoursesMap] = useState<Record<string, string[]>>({});
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});
  const [previewDocAppId, setPreviewDocAppId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadAll = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [apps, catalog, cfg] = await Promise.all([
        fetchAllTutorApplicationsAdmin(),
        fetchCourses().catch(() => [] as string[]),
        fetchTutorOnboardingSettings(),
      ]);
      setApplications(apps);
      onPendingCountChange?.(apps.filter((a) => a.status === 'pending').length);
      if (catalog.length > 0) setCatalogCourses(catalog);
      setSettings(cfg);

      const initialCourses: Record<string, string[]> = {};
      const initialNotes: Record<string, string> = {};
      apps.forEach((app) => {
        initialCourses[app.id] =
          app.approvedCourses.length > 0
            ? app.approvedCourses
            : app.requestedCourses.length > 0
              ? app.requestedCourses
              : app.matchedCourses;
        initialNotes[app.id] = app.adminNotes || '';
      });
      setSelectedCoursesMap(initialCourses);
      setNotesMap(initialNotes);
    } catch (err) {
      setLoadError(
        formatUserError(err, 'Could not load tutor applications. Please try again.')
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingSettings(true);
    setSettingsNotice(null);
    setActionError(null);
    try {
      const updated = await updateTutorOnboardingSettingsAdmin({
        minGpa: settings.minGpa,
        requireFirstSemesterCompleted: settings.requireFirstSemesterCompleted,
        requireFacultyDocs: settings.requireFacultyDocs,
        updatedBy: adminEmail || adminUid,
      });
      setSettings(updated);
      setSettingsNotice('Screening rules updated for all future tutor applications.');
    } catch (err) {
      setActionError(formatUserError(err, 'Failed to save screening settings.'));
    } finally {
      setIsSavingSettings(false);
    }
  };

  const toggleApprovedCourse = (appId: string, code: string) => {
    setSelectedCoursesMap((prev) => {
      const current = prev[appId] || [];
      const next = current.includes(code)
        ? current.filter((c) => c !== code)
        : [...current, code];
      return { ...prev, [appId]: next };
    });
  };

  const handleReviewDecision = async (
    app: TutorApplicationItem,
    decision: 'approved' | 'rejected'
  ) => {
    const approvedCourses = selectedCoursesMap[app.id] || [];
    const adminNotes = (notesMap[app.id] || '').trim();

    if (decision === 'approved' && approvedCourses.length === 0) {
      setActionError('Select at least one approved course before approving this tutor.');
      return;
    }

    setReviewingId(app.id);
    setActionError(null);
    setActionBanner(null);

    try {
      const res = await reviewTutorApplicationAdmin({
        application: app,
        decision,
        approvedCourses,
        adminNotes,
        adminUid,
        adminEmail,
      });
      setActionBanner(
        decision === 'approved'
          ? `Approved ${app.applicantName} as Tutor (${approvedCourses.map(formatCourse).join(', ')}). ${res.emailNotificationStatus}`
          : `Rejected ${app.applicantName}'s application. ${res.emailNotificationStatus}`
      );
      await loadAll();
      if (decision === 'approved') {
        onApplicantPromoted?.();
      }
    } catch (err) {
      setActionError(formatUserError(err, 'Failed to save application review.'));
    } finally {
      setReviewingId(null);
    }
  };

  const filteredApps =
    filterStatus === 'all'
      ? applications
      : applications.filter((a) => a.status === filterStatus);

  const counts = {
    all: applications.length,
    pending: applications.filter((a) => a.status === 'pending').length,
    approved: applications.filter((a) => a.status === 'approved').length,
    rejected: applications.filter((a) => a.status === 'rejected').length,
  };

  return (
    <div className="space-y-5">
      {/* Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#0B2240]">
            Tutor Applications &amp; Onboarding
          </h2>
          <p className="text-xs text-slate-500">
            Inspect student AI-verified transcripts &amp; faculty credentials, edit approved courses, and notify applicants
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setShowSettings((prev) => !prev);
              setSettingsNotice(null);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Screening Rules (GPA ≥ {settings.minGpa.toFixed(1)})</span>
          </button>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => void loadAll()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Configurable Screening Rules Panel */}
      {showSettings && (
        <form
          onSubmit={handleSaveSettings}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-[#0B2240]">
              Configurable Pre-Screening &amp; Document Rules
            </h3>
            <span className="text-xs text-slate-500">Applies to all new tutor applications</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-center">
            <div>
              <label htmlFor="min-gpa-input" className="block text-xs font-medium text-slate-700 mb-1">
                Minimum Student GPA (0.0 – 4.0)
              </label>
              <input
                id="min-gpa-input"
                type="number"
                step="0.1"
                min="0"
                max="4"
                value={settings.minGpa}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    minGpa: Number(e.target.value),
                  }))
                }
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>

            <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer pt-4 sm:pt-0">
              <input
                type="checkbox"
                checked={settings.requireFirstSemesterCompleted}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    requireFirstSemesterCompleted: e.target.checked,
                  }))
                }
                className="mt-0.5 h-4 w-4 accent-[#0B2240]"
              />
              <span>Require completed 1st semester for student applicants</span>
            </label>

            <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer pt-4 sm:pt-0">
              <input
                type="checkbox"
                checked={settings.requireFacultyDocs}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    requireFacultyDocs: e.target.checked,
                  }))
                }
                className="mt-0.5 h-4 w-4 accent-[#0B2240]"
              />
              <span>Require supporting credential upload for faculty applicants</span>
            </label>
          </div>

          {settingsNotice && (
            <p className="text-xs font-medium text-emerald-800">{settingsNotice}</p>
          )}

          <button
            type="submit"
            disabled={isSavingSettings}
            className="px-4 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
          >
            {isSavingSettings ? 'Saving rules...' : 'Save screening rules'}
          </button>
        </form>
      )}

      {actionBanner && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
          <span>{actionBanner}</span>
        </div>
      )}

      {actionError && (
        <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Filter Pills */}
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'pending', 'approved', 'rejected'] as const).map((statusKey) => (
          <button
            key={statusKey}
            type="button"
            onClick={() => setFilterStatus(statusKey)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold capitalize border transition-colors cursor-pointer ${
              filterStatus === statusKey
                ? 'bg-[#0B2240] text-white border-[#0B2240]'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {statusKey} ({counts[statusKey]})
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <Spinner label="Loading tutor applications..." />
        </div>
      )}

      {loadError && !isLoading && (
        <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadAll()}
            className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !loadError && filteredApps.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
          No {filterStatus === 'all' ? '' : `${filterStatus} `}tutor applications found yet.
        </div>
      )}

      {!isLoading && !loadError && filteredApps.length > 0 && (
        <div className="space-y-4">
          {filteredApps.map((app) => {
            const isPreviewOpen = previewDocAppId === app.id;
            const docDataUrl =
              app.documentBase64 && app.documentMimeType
                ? `data:${app.documentMimeType};base64,${app.documentBase64}`
                : null;
            const isImageDoc = Boolean(app.documentMimeType?.startsWith('image/'));
            const isPdfDoc = app.documentMimeType === 'application/pdf';
            const selectedCourses = selectedCoursesMap[app.id] || [];
            const allCourseChoices = Array.from(
              new Set([
                ...catalogCourses,
                ...app.matchedCourses,
                ...app.requestedCourses,
                ...app.approvedCourses,
              ])
            );

            return (
              <article
                key={app.id}
                className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
              >
                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-4 border-b border-slate-200">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-xs font-semibold capitalize text-[#0B2240]">
                        {app.applicantType === 'student' ? (
                          <GraduationCap className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        <span>{app.applicantType}</span>
                      </span>
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-semibold capitalize ${statusBadgeClasses(
                          app.status
                        )}`}
                      >
                        {app.status}
                      </span>
                      {app.autoScreened && (
                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[11px] font-medium">
                          Auto-screened
                        </span>
                      )}
                    </div>
                    <h3 className="font-display text-lg font-bold text-[#0B2240]">
                      {app.applicantName}
                    </h3>
                    <p className="text-xs text-slate-600">
                      {app.campus} Campus
                      {app.createdAt &&
                        ` · Applied ${new Date(app.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}`}
                    </p>
                  </div>

                  {docDataUrl && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setPreviewDocAppId(isPreviewOpen ? null : app.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{isPreviewOpen ? 'Hide document' : 'Inspect document'}</span>
                      </button>
                      <a
                        href={docDataUrl}
                        download={app.documentFileName || `${app.applicantName}-document`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Download</span>
                      </a>
                    </div>
                  )}
                </div>

                {/* Uploaded Document Viewer */}
                {isPreviewOpen && docDataUrl && (
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span className="font-medium flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{app.documentFileName}</span>
                      </span>
                    </div>
                    {isImageDoc && (
                      <img
                        src={docDataUrl}
                        alt={`Uploaded document from ${app.applicantName}`}
                        className="max-h-96 rounded-lg border border-slate-200 bg-white object-contain"
                      />
                    )}
                    {isPdfDoc && (
                      <iframe
                        src={docDataUrl}
                        title={`Uploaded PDF from ${app.applicantName}`}
                        className="w-full h-96 rounded-lg border border-slate-200 bg-white"
                      />
                    )}
                  </div>
                )}

                {/* Student AI Verification Summary */}
                {app.applicantType === 'student' && (
                  <div className="space-y-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B2240]">
                        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>AI Transcript Extraction</span>
                      </span>
                      {app.screeningReason && (
                        <span className="text-xs text-slate-600">{app.screeningReason}</span>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                        <div className="text-[11px] text-slate-500">GPA</div>
                        <div className="font-mono text-base font-bold text-[#0B2240] tabular-nums">
                          {typeof app.gpa === 'number' ? app.gpa.toFixed(2) : '—'}
                        </div>
                      </div>
                      <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                        <div className="text-[11px] text-slate-500">Semesters</div>
                        <div className="font-mono text-base font-bold text-[#0B2240] tabular-nums">
                          {app.completedSemesters ?? '—'}
                        </div>
                      </div>
                      <div className="bg-white border border-slate-200 rounded-lg p-2.5">
                        <div className="text-[11px] text-slate-500">Credits</div>
                        <div className="font-mono text-base font-bold text-[#0B2240] tabular-nums">
                          {app.completedCredits ?? '—'}
                        </div>
                      </div>
                    </div>

                    {app.parsedTranscript?.extractedCourses &&
                      app.parsedTranscript.extractedCourses.length > 0 && (
                        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                                <th className="py-1.5 px-3">Course</th>
                                <th className="py-1.5 px-3">Title</th>
                                <th className="py-1.5 px-3">Grade</th>
                                <th className="py-1.5 px-3">Qualifying</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {app.parsedTranscript.extractedCourses.map((c, idx) => (
                                <tr key={`${c.code}-${idx}`}>
                                  <td className="py-1.5 px-3 font-mono font-semibold text-[#0B2240]">
                                    {c.code}
                                  </td>
                                  <td className="py-1.5 px-3 text-slate-700">{c.title || getCourseName(c.code) || '—'}</td>
                                  <td className="py-1.5 px-3 font-mono font-medium">{c.grade || '—'}</td>
                                  <td className="py-1.5 px-3">
                                    {c.passed ? (
                                      <span className="text-emerald-700 font-semibold">Yes</span>
                                    ) : (
                                      <span className="text-slate-400">No</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                  </div>
                )}

                {/* Approved Courses Editor + Decision Actions */}
                <div className="space-y-4 pt-1">
                  <div>
                    <p className="text-xs font-semibold text-[#0B2240] mb-2">
                      Courses to Approve ({selectedCourses.length} selected)
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {allCourseChoices.map((code) => {
                        const isChecked = selectedCourses.includes(code);
                        const isMatched = app.matchedCourses.includes(code);
                        const isRequested = app.requestedCourses.includes(code);
                        return (
                          <label
                            key={code}
                            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold cursor-pointer ${
                              isChecked
                                ? 'border-[#0B2240] bg-[#0B2240]/5 text-[#0B2240]'
                                : 'border-slate-200 text-slate-600'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleApprovedCourse(app.id, code)}
                              className="h-3.5 w-3.5 accent-[#0B2240]"
                            />
                            <span>{formatCourse(code)}</span>
                            {isMatched && app.applicantType === 'student' && (
                              <span className="text-[10px] font-sans font-semibold text-emerald-700">
                                (AI match)
                              </span>
                            )}
                            {isRequested && app.applicantType === 'faculty' && (
                              <span className="text-[10px] font-sans font-semibold text-blue-700">
                                (Requested)
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Coordinator Notes / Rejection Reason (included in email notification)
                    </label>
                    <input
                      type="text"
                      value={notesMap[app.id] || ''}
                      onChange={(e) =>
                        setNotesMap((prev) => ({ ...prev, [app.id]: e.target.value }))
                      }
                      placeholder="Optional approval note or clear rejection reason..."
                      className="w-full min-h-[38px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={reviewingId === app.id}
                        onClick={() => void handleReviewDecision(app, 'approved')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[38px] text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>
                          {reviewingId === app.id
                            ? 'Updating...'
                            : app.status === 'approved'
                              ? 'Update Approved Courses & Re-notify'
                              : 'Approve & Email Applicant'}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={reviewingId === app.id}
                        onClick={() => void handleReviewDecision(app, 'rejected')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[38px] text-xs font-semibold text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Reject &amp; Email Applicant</span>
                      </button>
                    </div>

                    {app.emailNotificationStatus && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                        <Mail className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                        <span>
                          {app.emailNotificationStatus
                            .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
                            .replace(/\s+for\s*$/i, '')
                            .trim() || 'Notification saved'}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
