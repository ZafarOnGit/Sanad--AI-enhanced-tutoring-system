import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bookmark,
  BookOpen,
  Calendar,
  CalendarClock,
  CheckCircle2,
  CheckSquare,
  Clock,
  Edit3,
  HelpCircle,
  ListChecks,
  Mail,
  MapPin,
  Minus,
  PhoneCall,
  RefreshCw,
  Search,
  Square,
  TrendingDown,
  TrendingUp,
  UserCheck,
  X,
} from 'lucide-react';
import {
  cancelOpenRequest,
  fetchAvailableBookingSlots,
  fetchCourses,
  fetchStudentBookings,
  fetchStudentBookmarks,
  fetchStudentExams,
  fetchStudentProgress,
  fetchStudentRequests,
  submitStudentRescheduleRequest,
  updateOpenRequest,
} from '../api';
import { formatCourse, normalizeCourseCode } from '../courses';
import { formatUserError } from '../firebase';
import type {
  BookingItem,
  BookmarkItem,
  ProgressItem,
  StoredExamRecord,
  StudentRequestItem,
  StudentResumeContext,
} from '../types';
import { AttachmentList } from './AttachmentList';
import { ExamReviewPanel } from './ExamReviewPanel';
import { Spinner } from './Spinner';

interface StudentHomeProps {
  studentUid: string;
  studentName: string;
  studentCampus?: string;
  unreadTutorNotesCount?: number;
  onAskForHelp: () => void;
  onOpenTutorNotes: () => void;
  onOpenSavedAnswers: () => void;
  onResumeRequest: (context: StudentResumeContext) => void;
  onOpenHumanSupport: () => void;
}

type ScoreTrend = 'Improving' | 'Steady' | 'Dipped' | 'New';

interface CourseTopicProgressSummary {
  key: string;
  course: string;
  topic: string;
  attempts: number;
  latestScore: number;
  bestScore: number;
  trend: ScoreTrend;
  mastered: boolean;
}

interface WeakChecklistItem {
  id: string;
  course: string;
  topic: string;
  subtopic: string;
  reason: string;
  request?: StudentRequestItem;
}

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const pct = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return `${pct}%`;
}

function normalizeRatio(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return value <= 1 ? value : value / 100;
}

function formatDate(raw: string | undefined): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getStatusBadgeClasses(status: string | undefined): string {
  const s = (status || '').toLowerCase().trim();
  if (s === 'resolved by ai' || s.includes('resolved')) {
    return 'bg-emerald-50 text-emerald-800 border-emerald-200';
  }
  if (s === 'booked with tutor' || s.includes('booked')) {
    return 'bg-blue-50 text-blue-800 border-blue-200';
  }
  if (s === 'waitlist' || s.includes('waitlist')) {
    return 'bg-amber-50 text-amber-800 border-amber-200';
  }
  if (s === 'cancelled' || s.includes('cancel')) {
    return 'bg-red-50 text-red-800 border-red-200';
  }
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

function isEditableOpenStatus(status: string): boolean {
  return !['Cancelled', 'Resolved by AI', 'Booked with tutor'].includes(status);
}

export const StudentHome: React.FC<StudentHomeProps> = ({
  studentUid,
  studentName,
  studentCampus,
  unreadTutorNotesCount = 0,
  onAskForHelp,
  onOpenTutorNotes,
  onOpenSavedAnswers,
  onResumeRequest,
  onOpenHumanSupport,
}) => {
  // Requests & stored exams state
  const [requests, setRequests] = useState<StudentRequestItem[]>([]);
  const [allExams, setAllExams] = useState<StoredExamRecord[]>([]);
  const [examsByRequest, setExamsByRequest] = useState<
    Record<string, { diag?: StoredExamRecord; retest?: StoredExamRecord }>
  >({});
  const [bookingFeedbackByReq, setBookingFeedbackByReq] = useState<
    Record<string, BookingItem>
  >({});
  const [studentBookings, setStudentBookings] = useState<BookingItem[]>([]);
  const [reviewingRequestId, setReviewingRequestId] = useState<string | null>(null);
  const [isLoadingRequests, setIsLoadingRequests] = useState(true);
  const [requestsError, setRequestsError] = useState<string | null>(null);

  // Reschedule request modal/inline state
  const [rescheduleBooking, setRescheduleBooking] = useState<BookingItem | null>(null);
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [reschedulePreferredSlotId, setReschedulePreferredSlotId] = useState('');
  const [openSlotsForReschedule, setOpenSlotsForReschedule] = useState<BookingItem[]>([]);
  const [isLoadingRescheduleSlots, setIsLoadingRescheduleSlots] = useState(false);
  const [isSubmittingReschedule, setIsSubmittingReschedule] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [rescheduleSuccessBanner, setRescheduleSuccessBanner] = useState<string | null>(null);

  // Search & course filter for My requests
  const [requestSearch, setRequestSearch] = useState('');
  const [requestCourseFilter, setRequestCourseFilter] = useState('ALL');

  // Edit / Cancel open request state
  const [courses, setCourses] = useState<string[]>([]);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [editCourse, setEditCourse] = useState('');
  const [editText, setEditText] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  // Saved answers summary count
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [isLoadingBookmarks, setIsLoadingBookmarks] = useState(true);

  // Progress state
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [isLoadingProgress, setIsLoadingProgress] = useState(true);
  const [progressError, setProgressError] = useState<string | null>(null);

  // Interactive revision checklist state (persisted locally per student)
  const checklistStorageKey = `sanad_study_checklist_${studentUid}`;
  const [checkedPlanIds, setCheckedPlanIds] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(`sanad_study_checklist_${studentUid}`);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  const toggleChecklistItem = (itemId: string) => {
    setCheckedPlanIds((prev) => {
      const next = { ...prev, [itemId]: !prev[itemId] };
      try {
        localStorage.setItem(checklistStorageKey, JSON.stringify(next));
      } catch {
        // Ignore storage quota issues
      }
      return next;
    });
  };

  const loadRequests = async () => {
    setIsLoadingRequests(true);
    setRequestsError(null);
    try {
      const [list, examList, bookingsList] = await Promise.all([
        fetchStudentRequests(studentUid),
        fetchStudentExams(studentUid).catch(() => [] as StoredExamRecord[]),
        fetchStudentBookings(studentUid).catch(() => [] as BookingItem[]),
      ]);
      const grouped: Record<string, { diag?: StoredExamRecord; retest?: StoredExamRecord }> = {};
      examList.forEach((exam) => {
        if (!grouped[exam.requestId]) grouped[exam.requestId] = {};
        if (exam.stage === 'retest') {
          if (!grouped[exam.requestId].retest) grouped[exam.requestId].retest = exam;
        } else {
          if (!grouped[exam.requestId].diag) grouped[exam.requestId].diag = exam;
        }
      });
      const bookingByReq: Record<string, BookingItem> = {};
      bookingsList.forEach((b) => {
        if (b.requestId) bookingByReq[b.requestId] = b;
      });
      setRequests(list);
      setAllExams(examList);
      setExamsByRequest(grouped);
      setStudentBookings(bookingsList);
      setBookingFeedbackByReq(bookingByReq);
    } catch (err) {
      setRequestsError(
        formatUserError(err, 'Could not reach Sanad right now. Please try again.')
      );
    } finally {
      setIsLoadingRequests(false);
    }
  };

  const openRescheduleDialog = async (booking: BookingItem) => {
    setRescheduleBooking(booking);
    setRescheduleReason(booking.rescheduleReason || '');
    setReschedulePreferredSlotId(booking.reschedulePreferredSlotId || '');
    setRescheduleError(null);
    setRescheduleSuccessBanner(null);
    setIsLoadingRescheduleSlots(true);
    try {
      const slots = await fetchAvailableBookingSlots();
      setOpenSlotsForReschedule(slots);
    } catch {
      setOpenSlotsForReschedule([]);
    } finally {
      setIsLoadingRescheduleSlots(false);
    }
  };

  const handleSubmitReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rescheduleBooking) return;
    if (rescheduleReason.trim().length < 3) {
      setRescheduleError('Please enter a brief reason for rescheduling.');
      return;
    }
    setIsSubmittingReschedule(true);
    setRescheduleError(null);
    try {
      const chosen = openSlotsForReschedule.find((s) => s.id === reschedulePreferredSlotId);
      await submitStudentRescheduleRequest({
        bookingId: rescheduleBooking.id,
        studentUid,
        reason: rescheduleReason.trim(),
        preferredSlotId: chosen?.id,
        preferredWhen: chosen
          ? `${chosen.date} ${chosen.start}-${chosen.end}`
          : undefined,
      });
      setRescheduleBooking(null);
      setRescheduleSuccessBanner(
        `Reschedule request sent to ${rescheduleBooking.tutorName}. You will see their update here once confirmed.`
      );
      await loadRequests();
    } catch (err) {
      setRescheduleError(
        formatUserError(err, 'Could not submit your reschedule request. Please try again.')
      );
    } finally {
      setIsSubmittingReschedule(false);
    }
  };

  const loadBookmarks = async () => {
    setIsLoadingBookmarks(true);
    try {
      const list = await fetchStudentBookmarks(studentUid);
      setBookmarks(list);
    } catch {
      // Summary count is secondary; Saved answers page shows full error/retry
    } finally {
      setIsLoadingBookmarks(false);
    }
  };

  const loadProgress = async () => {
    setIsLoadingProgress(true);
    setProgressError(null);
    try {
      const list = await fetchStudentProgress(studentUid);
      setProgress(list);
    } catch (err) {
      setProgressError(
        formatUserError(err, 'Could not load your topic progress. Please try again.')
      );
    } finally {
      setIsLoadingProgress(false);
    }
  };

  useEffect(() => {
    void loadRequests();
    void loadBookmarks();
    void loadProgress();
    void fetchCourses()
      .then((list) => {
        if (list.length > 0) setCourses(list);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentUid]);

  // Derived per-course progress cards (combining stored progress docs + completed exams)
  const courseProgressCards = useMemo(() => {
    const completedExams = allExams
      .filter((ex) => ex.status === 'completed' || ex.answers.length > 0)
      .slice()
      .sort((a, b) => Date.parse(a.updatedAt || '') - Date.parse(b.updatedAt || ''));

    const examHistoryMap = new Map<string, number[]>();
    completedExams.forEach((ex) => {
      const code = normalizeCourseCode(ex.course);
      const topicName = (ex.topic || '').trim();
      if (!code || !topicName) return;
      const key = `${code}::${topicName.toLowerCase()}`;
      const list = examHistoryMap.get(key) || [];
      list.push(normalizeRatio(ex.score));
      examHistoryMap.set(key, list);
    });

    const mergedMap = new Map<string, CourseTopicProgressSummary>();

    progress.forEach((item) => {
      const code = normalizeCourseCode(item.course);
      const topicName = item.topic.trim();
      if (!code || !topicName) return;
      const key = `${code}::${topicName.toLowerCase()}`;
      const scores = examHistoryMap.get(key) || [];

      const latestScore =
        typeof item.latestScore === 'number'
          ? normalizeRatio(item.latestScore)
          : scores.length > 0
            ? scores[scores.length - 1]
            : normalizeRatio(item.bestScore);

      const previousScore =
        typeof item.previousScore === 'number'
          ? normalizeRatio(item.previousScore)
          : scores.length > 1
            ? scores[scores.length - 2]
            : undefined;

      let trend: ScoreTrend = 'New';
      if (previousScore !== undefined) {
        if (latestScore - previousScore >= 0.03) trend = 'Improving';
        else if (previousScore - latestScore >= 0.03) trend = 'Dipped';
        else trend = 'Steady';
      }

      mergedMap.set(key, {
        key,
        course: code,
        topic: topicName,
        attempts: Math.max(item.attempts, scores.length || 1),
        latestScore,
        bestScore: normalizeRatio(item.bestScore),
        trend,
        mastered: latestScore >= 0.7,
      });
    });

    // Include any completed exam topics that may not have a progress doc yet
    examHistoryMap.forEach((scores, key) => {
      if (mergedMap.has(key) || scores.length === 0) return;
      const matchingExam = completedExams.find(
        (ex) =>
          `${normalizeCourseCode(ex.course)}::${(ex.topic || '').trim().toLowerCase()}` === key
      );
      if (!matchingExam) return;
      const latestScore = scores[scores.length - 1];
      const previousScore = scores.length > 1 ? scores[scores.length - 2] : undefined;
      let trend: ScoreTrend = 'New';
      if (previousScore !== undefined) {
        if (latestScore - previousScore >= 0.03) trend = 'Improving';
        else if (previousScore - latestScore >= 0.03) trend = 'Dipped';
        else trend = 'Steady';
      }
      mergedMap.set(key, {
        key,
        course: normalizeCourseCode(matchingExam.course),
        topic: matchingExam.topic.trim(),
        attempts: scores.length,
        latestScore,
        bestScore: Math.max(...scores),
        trend,
        mastered: latestScore >= 0.7,
      });
    });

    const byCourse = new Map<
      string,
      { course: string; topics: CourseTopicProgressSummary[]; masteredCount: number }
    >();

    Array.from(mergedMap.values()).forEach((entry) => {
      const existing = byCourse.get(entry.course) || {
        course: entry.course,
        topics: [],
        masteredCount: 0,
      };
      existing.topics.push(entry);
      if (entry.mastered) existing.masteredCount += 1;
      byCourse.set(entry.course, existing);
    });

    return Array.from(byCourse.values())
      .map((card) => ({
        ...card,
        topics: card.topics.sort((a, b) => a.topic.localeCompare(b.topic)),
      }))
      .sort((a, b) => a.course.localeCompare(b.course));
  }, [progress, allExams]);

  // Derived Personalised Study Plan (3 next steps + weak-topic revision checklist)
  const studyPlan = useMemo(() => {
    const checklistMap = new Map<string, WeakChecklistItem>();

    // 1. Collect weak subtopics from stored exams (excluding topics mastered with >=70% on retest)
    requests.forEach((req) => {
      if (req.status === 'Cancelled') return;
      const reqExams = examsByRequest[req.id];
      const diag = reqExams?.diag;
      const retest = reqExams?.retest;
      const code = normalizeCourseCode(req.course);
      const topicName = req.topic || diag?.topic || 'Course Topic';

      const retestMastered =
        retest && retest.status === 'completed' && normalizeRatio(retest.score) >= 0.7;
      if (retestMastered) return;

      const weakSet = new Set<string>();
      retest?.weakSubtopics.forEach((s) => s.trim() && weakSet.add(s.trim()));
      retest?.answers.filter((a) => !a.correct).forEach((a) => a.subtopic.trim() && weakSet.add(a.subtopic.trim()));
      diag?.weakSubtopics.forEach((s) => s.trim() && weakSet.add(s.trim()));
      diag?.answers.filter((a) => !a.correct).forEach((a) => a.subtopic.trim() && weakSet.add(a.subtopic.trim()));

      weakSet.forEach((sub) => {
        const id = `${code}::${sub.toLowerCase()}`;
        if (!checklistMap.has(id)) {
          checklistMap.set(id, {
            id,
            course: code,
            topic: topicName,
            subtopic: sub,
            reason: 'Missed during recent check',
            request: req,
          });
        }
      });
    });

    // 2. Add any topics whose latest score is < 70%
    courseProgressCards.forEach((card) => {
      card.topics.forEach((t) => {
        if (!t.mastered) {
          const id = `${card.course}::${t.topic.toLowerCase()}`;
          if (!checklistMap.has(id)) {
            const matchingReq = requests.find(
              (r) =>
                normalizeCourseCode(r.course) === card.course &&
                (r.topic || '').trim().toLowerCase() === t.topic.toLowerCase()
            );
            checklistMap.set(id, {
              id,
              course: card.course,
              topic: t.topic,
              subtopic: t.topic,
              reason: `Latest score ${Math.round(t.latestScore * 100)}% (target 70%)`,
              request: matchingReq,
            });
          }
        }
      });
    });

    const checklist = Array.from(checklistMap.values()).slice(0, 6);

    // Build 3 short next steps
    const unfinishedReq = requests.find((req) => {
      if (req.status === 'Cancelled' || req.status === 'Resolved by AI') return false;
      const ex = examsByRequest[req.id];
      return (
        ex?.diag?.status === 'in_progress' ||
        ex?.retest?.status === 'in_progress' ||
        Boolean(ex?.diag?.studyPack && (!ex?.retest || ex.retest.status !== 'completed'))
      );
    });

    const steps: Array<{
      id: string;
      text: string;
      ctaLabel?: string;
      onAction?: () => void;
    }> = [];

    if (unfinishedReq) {
      const ex = examsByRequest[unfinishedReq.id];
      const stage: 'diagnostic' | 'studyPack' | 'retest' =
        ex?.retest?.status === 'in_progress'
          ? 'retest'
          : ex?.diag?.status === 'in_progress'
            ? 'diagnostic'
            : 'studyPack';
      steps.push({
        id: 'step-resume',
        text: `Finish your ${unfinishedReq.topic || formatCourse(unfinishedReq.course)} session in ${formatCourse(unfinishedReq.course)}.`,
        ctaLabel: stage === 'studyPack' ? 'Open Study Pack' : 'Resume',
        onAction: () =>
          onResumeRequest({
            request: unfinishedReq,
            diagExam: ex?.diag,
            retestExam: ex?.retest,
            startStage: stage,
          }),
      });
    } else if (checklist.length > 0) {
      const topWeak = checklist[0];
      steps.push({
        id: 'step-focus',
        text: `Review ${topWeak.subtopic} (${formatCourse(topWeak.course)}) to raise your score past 70%.`,
        ctaLabel: 'Practice now',
        onAction: onAskForHelp,
      });
    } else {
      steps.push({
        id: 'step-start',
        text: 'Pick a course topic you want to strengthen and run a quick diagnostic check.',
        ctaLabel: 'Ask for help',
        onAction: onAskForHelp,
      });
    }

    if (checklist.length > 0) {
      steps.push({
        id: 'step-checklist',
        text: `Work through your ${checklist.length} weak-topic item${checklist.length === 1 ? '' : 's'} below and check each one off.`,
      });
    } else {
      steps.push({
        id: 'step-practice',
        text: 'Try a practice diagnostic in any of your courses to check your readiness before assessments.',
        ctaLabel: 'Practice topic',
        onAction: onAskForHelp,
      });
    }

    steps.push({
      id: 'step-saved',
      text:
        bookmarks.length > 0
          ? `Revisit your ${bookmarks.length} saved AI explanation${bookmarks.length === 1 ? '' : 's'} and notes for quick revision.`
          : 'Save helpful AI answers and study packs while studying so you can revise them anytime.',
      ctaLabel: 'Saved answers',
      onAction: onOpenSavedAnswers,
    });

    return { steps: steps.slice(0, 3), checklist };
  }, [
    requests,
    examsByRequest,
    courseProgressCards,
    bookmarks.length,
    onAskForHelp,
    onOpenSavedAnswers,
    onResumeRequest,
  ]);

  const requestCourseOptions = useMemo(() => {
    return Array.from(
      new Set([...courses, ...requests.map((r) => normalizeCourseCode(r.course)).filter(Boolean)])
    ).sort((a, b) => a.localeCompare(b));
  }, [courses, requests]);

  const filteredRequests = useMemo(() => {
    const q = requestSearch.trim().toLowerCase();
    return requests.filter((req) => {
      const normalizedReqCourse = normalizeCourseCode(req.course);
      if (requestCourseFilter !== 'ALL' && normalizedReqCourse !== requestCourseFilter) {
        return false;
      }
      if (!q) return true;
      return (
        formatCourse(req.course).toLowerCase().includes(q) ||
        (req.topic || '').toLowerCase().includes(q) ||
        req.text.toLowerCase().includes(q) ||
        (req.studentNote || '').toLowerCase().includes(q) ||
        (req.status || '').toLowerCase().includes(q)
      );
    });
  }, [requests, requestCourseFilter, requestSearch]);

  const startEditing = (req: StudentRequestItem) => {
    setEditingRequestId(req.id);
    setEditCourse(req.course);
    setEditText(req.text);
    setEditNote(req.studentNote || '');
    setEditError(null);
    setConfirmCancelId(null);
  };

  const handleSaveEdit = async (requestId: string) => {
    if (editText.trim().length < 10) {
      setEditError('Please describe your problem in a sentence (at least 10 characters).');
      return;
    }
    setIsSavingEdit(true);
    setEditError(null);
    try {
      await updateOpenRequest({
        requestId,
        studentUid,
        course: editCourse,
        text: editText,
        studentNote: editNote,
      });
      setEditingRequestId(null);
      await loadRequests();
    } catch (err) {
      setEditError(formatUserError(err, 'Failed to update request.'));
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleCancelRequest = async (requestId: string) => {
    setCancellingId(requestId);
    try {
      await cancelOpenRequest(requestId, studentUid);
      setConfirmCancelId(null);
      await loadRequests();
    } catch (err) {
      setRequestsError(formatUserError(err, 'Failed to cancel request.'));
    } finally {
      setCancellingId(null);
    }
  };

  const completedChecklistCount = studyPlan.checklist.filter(
    (item) => Boolean(checkedPlanIds[item.id])
  ).length;

  // Pending Topics to Learn (unfinished diagnostic, unfinished retest, or ready to book tutor)
  const pendingTopics = useMemo(() => {
    return requests
      .filter((req) => {
        const st = (req.status || '').trim();
        if (st === 'Cancelled' || st === 'Resolved by AI' || st === 'Booked with tutor') {
          return false;
        }
        const ex = examsByRequest[req.id];
        const diag = ex?.diag;
        const retest = ex?.retest;

        const diagDone =
          (diag && diag.status === 'completed') ||
          (req.diagScore !== null && req.diagScore !== undefined);
        const retestDone =
          (retest && retest.status === 'completed') ||
          (req.retestScore !== null && req.retestScore !== undefined);

        if (!diagDone) return true;
        if (!retestDone) return true;

        const finalRetestScore =
          retest?.status === 'completed'
            ? normalizeRatio(retest.score)
            : normalizeRatio(req.retestScore);
        return finalRetestScore < 0.7;
      })
      .map((req) => {
        const ex = examsByRequest[req.id];
        const diag = ex?.diag;
        const retest = ex?.retest;
        const diagInProgress = Boolean(
          diag && diag.status === 'in_progress' && diag.questions.length > 0
        );
        const retestInProgress = Boolean(
          retest && retest.status === 'in_progress' && retest.questions.length > 0
        );
        const diagCompleted =
          (diag && diag.status === 'completed') ||
          (req.diagScore !== null && req.diagScore !== undefined && !diagInProgress);
        const retestCompleted =
          (retest && retest.status === 'completed') ||
          (req.retestScore !== null && req.retestScore !== undefined && !retestInProgress);

        let stageBadge = 'Diagnostic not done';
        let primaryCta = 'Continue Diagnostic';
        let primaryStage: 'diagnostic' | 'studyPack' | 'retest' | 'retestResult' = 'diagnostic';

        if (retestInProgress && retest) {
          const nextQ = Math.min(retest.answers.length + 1, retest.questions.length);
          stageBadge = `Retest in progress (Q${nextQ} of ${retest.questions.length})`;
          primaryCta = `Continue Retest (Q${nextQ}/${retest.questions.length})`;
          primaryStage = 'retest';
        } else if (diagInProgress && diag) {
          const nextQ = Math.min(diag.answers.length + 1, diag.questions.length);
          stageBadge = `Diagnostic in progress (Q${nextQ} of ${diag.questions.length})`;
          primaryCta = `Continue Diagnostic (Q${nextQ}/${diag.questions.length})`;
          primaryStage = 'diagnostic';
        } else if (!diagCompleted) {
          stageBadge = 'Diagnostic not done';
          primaryCta = diag?.questions.length ? 'Continue Diagnostic' : 'Start Diagnostic';
          primaryStage = 'diagnostic';
        } else if (!retestCompleted) {
          stageBadge = 'Retest not done';
          primaryCta = 'Continue to Retest';
          primaryStage = 'retest';
        } else {
          stageBadge = 'Tutor booking needed';
          primaryCta = 'Book a tutor';
          primaryStage = 'retestResult';
        }

        const diagScoreDisplay = diagInProgress && diag
          ? `In progress (${diag.answers.length}/${diag.questions.length})`
          : diagCompleted
            ? formatScore(diag?.score ?? req.diagScore)
            : 'Not done';

        const retestScoreDisplay = retestInProgress && retest
          ? `In progress (${retest.answers.length}/${retest.questions.length})`
          : retestCompleted
            ? formatScore(retest?.score ?? req.retestScore)
            : 'Not done';

        return {
          req,
          diag,
          retest,
          stageBadge,
          primaryCta,
          primaryStage,
          diagScoreDisplay,
          retestScoreDisplay,
          hasStudyPack: Boolean(diag?.studyPack),
          diagCompleted,
        };
      });
  }, [requests, examsByRequest]);

  const activeTutorBookings = useMemo(() => {
    return studentBookings.filter((b) => b.status === 'booked' || b.status === 'completed');
  }, [studentBookings]);

  return (
    <div className="space-y-8">
      {/* Welcome Banner Card */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="space-y-1.5">
          {studentCampus && (
            <p className="text-xs font-medium text-slate-500">
              {studentCampus} Campus · Academic Success Center
            </p>
          )}
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#0B2240] tracking-tight">
            Welcome, {studentName}
          </h1>
          <p className="text-sm text-slate-600 max-w-xl">
            Get instant AI-guided diagnostic checks, personalized study packs from your course notes, or book a campus tutor.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onAskForHelp}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
          >
            <HelpCircle className="w-4 h-4" aria-hidden="true" />
            <span>Ask for help</span>
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onOpenTutorNotes}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <Mail className="w-4 h-4" aria-hidden="true" />
            <span>Tutor Notes</span>
            {(unreadTutorNotesCount ?? 0) > 0 && (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold rounded-full bg-amber-500 text-white tabular-nums">
                {unreadTutorNotesCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onOpenSavedAnswers}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <Bookmark className="w-4 h-4" aria-hidden="true" />
            <span>
              Saved answers{!isLoadingBookmarks && bookmarks.length > 0 ? ` (${bookmarks.length})` : ''}
            </span>
          </button>
          <button
            type="button"
            onClick={onOpenHumanSupport}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
            <span>Talk to a human</span>
          </button>
        </div>
      </section>

      {/* Pending Topics to Learn (Unfinished Diagnostics & Retests) */}
      {!isLoadingRequests && !requestsError && (
        <section
          aria-labelledby="pending-topics-heading"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2
                id="pending-topics-heading"
                className="font-display text-lg font-semibold text-[#0B2240] flex items-center gap-2"
              >
                <BookOpen className="w-5 h-5" aria-hidden="true" />
                <span>Pending topics to learn</span>
                {pendingTopics.length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full bg-amber-100 border border-amber-300 text-amber-900 text-xs font-semibold tabular-nums">
                    {pendingTopics.length}
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Pick up where you left off on unfinished diagnostics, study packs, and retests.
              </p>
            </div>
          </div>

          {pendingTopics.length === 0 ? (
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm text-slate-600">
              <span>All caught up — no unfinished diagnostics or retests right now.</span>
              <button
                type="button"
                onClick={onAskForHelp}
                className="px-3.5 py-2 min-h-[36px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-100 shrink-0 cursor-pointer"
              >
                Start a new topic
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {pendingTopics.map((item) => (
                <article
                  key={item.req.id}
                  className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[11px] font-semibold text-[#0B2240] bg-white border border-slate-200 px-2 py-0.5 rounded">
                        {formatCourse(item.req.course)}
                      </span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-900 text-[11px] font-semibold">
                        {item.stageBadge}
                      </span>
                    </div>

                    <h3 className="font-display text-sm font-semibold text-slate-900">
                      {item.req.topic || item.diag?.topic || 'Course Topic'}
                    </h3>

                    <p dir="auto" className="text-xs text-slate-600 line-clamp-2">
                      {item.req.text}
                    </p>

                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-1 text-xs text-slate-600">
                      <span>
                        Diagnostic:{' '}
                        <strong className="font-mono font-semibold text-[#0B2240] tabular-nums">
                          {item.diagScoreDisplay}
                        </strong>
                      </span>
                      <span>
                        Retest:{' '}
                        <strong className="font-mono font-semibold text-[#0B2240] tabular-nums">
                          {item.retestScoreDisplay}
                        </strong>
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200">
                    <button
                      type="button"
                      onClick={() =>
                        onResumeRequest({
                          request: item.req,
                          diagExam: item.diag,
                          retestExam: item.retest,
                          startStage: item.primaryStage,
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
                    >
                      <span>{item.primaryCta}</span>
                      <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>

                    {item.hasStudyPack && (
                      <button
                        type="button"
                        onClick={() =>
                          onResumeRequest({
                            request: item.req,
                            diagExam: item.diag,
                            retestExam: item.retest,
                            startStage: 'studyPack',
                          })
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        <span>Review study pack</span>
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {/* My Tutoring Sessions (with Reschedule Request) */}
      {!isLoadingRequests && !requestsError && activeTutorBookings.length > 0 && (
        <section
          aria-labelledby="my-sessions-heading"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 space-y-4"
        >
          <div>
            <h2
              id="my-sessions-heading"
              className="font-display text-lg font-semibold text-[#0B2240] flex items-center gap-2"
            >
              <Calendar className="w-5 h-5" aria-hidden="true" />
              <span>My tutoring sessions</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              View your scheduled campus tutor sessions or submit a reschedule request with a reason.
            </p>
          </div>

          {rescheduleSuccessBanner && (
            <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>{rescheduleSuccessBanner}</span>
              </span>
              <button
                type="button"
                onClick={() => setRescheduleSuccessBanner(null)}
                className="text-emerald-800 hover:text-emerald-950 cursor-pointer"
                aria-label="Dismiss message"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="space-y-3">
            {activeTutorBookings.map((booking) => (
              <article
                key={booking.id}
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5 space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {booking.course && (
                        <span className="font-mono text-xs font-semibold text-[#0B2240] bg-white border border-slate-200 px-2 py-0.5 rounded">
                          {formatCourse(booking.course)}
                        </span>
                      )}
                      <span className="text-sm font-semibold text-slate-900">
                        {booking.topic || 'Tutoring Session'}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold capitalize ${
                          booking.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : 'bg-blue-50 text-blue-800 border-blue-200'
                        }`}
                      >
                        {booking.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 pt-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
                        <UserCheck className="w-3.5 h-3.5 text-[#0B2240]" aria-hidden="true" />
                        <span>{booking.tutorName}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5 font-mono tabular-nums font-medium text-[#0B2240]">
                        <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>
                          {booking.date} · {booking.start} – {booking.end}
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1 text-slate-500">
                        <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{booking.campus}</span>
                      </span>
                    </div>
                  </div>

                  {booking.status === 'booked' && (
                    <button
                      type="button"
                      onClick={() => void openRescheduleDialog(booking)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[36px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-100 shrink-0 cursor-pointer"
                    >
                      <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {booking.rescheduleStatus === 'requested'
                          ? 'Update reschedule request'
                          : 'Request reschedule'}
                      </span>
                    </button>
                  )}
                </div>

                {booking.rescheduleStatus === 'requested' && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-950 space-y-1">
                    <p className="font-semibold text-amber-900">Reschedule requested — waiting for tutor</p>
                    {booking.rescheduleReason && (
                      <p>
                        <span className="font-medium">Reason:</span> {booking.rescheduleReason}
                      </p>
                    )}
                    {booking.reschedulePreferredWhen && (
                      <p>
                        <span className="font-medium">Preferred time:</span>{' '}
                        <span className="font-mono">{booking.reschedulePreferredWhen}</span>
                      </p>
                    )}
                  </div>
                )}

                {booking.rescheduleStatus === 'approved' && (
                  <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3.5 py-2 text-xs text-emerald-900">
                    <span className="font-semibold">Reschedule approved</span> — updated to{' '}
                    <span className="font-mono font-semibold">
                      {booking.date} {booking.start}–{booking.end}
                    </span>
                    {booking.rescheduleResponseNote ? ` (${booking.rescheduleResponseNote})` : '.'}
                  </div>
                )}

                {booking.rescheduleStatus === 'declined' && (
                  <div className="rounded-lg bg-slate-100 border border-slate-200 px-3.5 py-2 text-xs text-slate-700">
                    <span className="font-semibold text-slate-900">Reschedule request declined</span>
                    {booking.rescheduleResponseNote
                      ? ` — ${booking.rescheduleResponseNote}`
                      : '. Your original time remains booked.'}
                  </div>
                )}

                {booking.tutorFeedback && (
                  <div className="rounded-lg bg-white border border-slate-200 px-3.5 py-2.5 text-xs text-slate-800">
                    <span className="font-semibold text-[#0B2240]">Tutor feedback: </span>
                    <span dir="auto" className="whitespace-pre-wrap">
                      {booking.tutorFeedback}
                    </span>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Personalised Study Plan Card */}
      <section
        aria-labelledby="study-plan-heading"
        className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 space-y-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2
              id="study-plan-heading"
              className="font-display text-lg font-semibold text-[#0B2240] flex items-center gap-2"
            >
              <ListChecks className="w-5 h-5" aria-hidden="true" />
              <span>Personalised study plan</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              3 focused next steps and a revision checklist built from your recent weak topics.
            </p>
          </div>
          {studyPlan.checklist.length > 0 && (
            <span className="text-xs font-medium text-slate-600 tabular-nums shrink-0">
              {completedChecklistCount} of {studyPlan.checklist.length} revised
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 3 Short Next Steps */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Your next 3 steps
            </h3>
            <ol className="space-y-2.5">
              {studyPlan.steps.map((stepItem, idx) => (
                <li
                  key={stepItem.id}
                  className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex items-start justify-between gap-3"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span className="w-6 h-6 rounded-full bg-[#0B2240] text-white text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                      {idx + 1}
                    </span>
                    <p className="text-sm text-slate-800 leading-snug">{stepItem.text}</p>
                  </div>
                  {stepItem.ctaLabel && stepItem.onAction && (
                    <button
                      type="button"
                      onClick={stepItem.onAction}
                      className="px-2.5 py-1.5 min-h-[32px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {stepItem.ctaLabel}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </div>

          {/* Revision Checklist from Weak Topics */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Revision checklist
            </h3>
            {studyPlan.checklist.length === 0 ? (
              <div className="p-5 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-600 space-y-2">
                <p className="font-medium text-[#0B2240]">
                  No weak topics waiting for review right now.
                </p>
                <p className="text-xs text-slate-500">
                  As you complete diagnostics and practice questions, any subtopics under 70% will appear here automatically.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {studyPlan.checklist.map((item) => {
                  const isChecked = Boolean(checkedPlanIds[item.id]);
                  const reqExams = item.request ? examsByRequest[item.request.id] : undefined;
                  return (
                    <li
                      key={item.id}
                      className="px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <button
                        type="button"
                        onClick={() => toggleChecklistItem(item.id)}
                        aria-pressed={isChecked}
                        className="flex items-start gap-2.5 text-left min-w-0 flex-1 cursor-pointer group"
                      >
                        {isChecked ? (
                          <CheckSquare
                            className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <Square
                            className="w-4 h-4 text-slate-400 group-hover:text-[#0B2240] shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                        )}
                        <div className="min-w-0">
                          <p
                            className={`text-sm font-medium truncate ${
                              isChecked ? 'line-through text-slate-400' : 'text-slate-900'
                            }`}
                          >
                            {item.subtopic}
                          </p>
                          <p className="text-xs text-slate-500 truncate">
                            {formatCourse(item.course)} · {item.reason}
                          </p>
                        </div>
                      </button>

                      {item.request && reqExams?.diag?.studyPack ? (
                        <button
                          type="button"
                          onClick={() =>
                            onResumeRequest({
                              request: item.request!,
                              diagExam: reqExams.diag,
                              retestExam: reqExams.retest,
                              startStage: 'studyPack',
                            })
                          }
                          className="px-2.5 py-1 text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Study pack
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={onAskForHelp}
                          className="px-2.5 py-1 text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Practice
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* My Progress Card Per Course */}
      <section aria-labelledby="progress-heading" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2
              id="progress-heading"
              className="font-display text-lg font-semibold text-[#0B2240] flex items-center gap-2"
            >
              <TrendingUp className="w-5 h-5" aria-hidden="true" />
              <span>My progress</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Topics practised, latest scores, trend, and mastery (70% or more) per course
            </p>
          </div>
          <button
            type="button"
            disabled={isLoadingProgress}
            onClick={() => void loadProgress()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingProgress ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>

        {isLoadingProgress && (
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <Spinner label="Loading your progress..." />
          </div>
        )}

        {progressError && !isLoadingProgress && (
          <div
            role="alert"
            className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-xs text-red-800"
          >
            <span>{progressError}</span>
            <button
              type="button"
              onClick={() => void loadProgress()}
              className="px-3 py-1.5 rounded-md bg-[#0B2240] text-white font-medium cursor-pointer shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {!isLoadingProgress && !progressError && courseProgressCards.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-7 text-center text-sm text-slate-500">
            Complete a diagnostic or retest to see your course progress cards here.
          </div>
        )}

        {!isLoadingProgress && !progressError && courseProgressCards.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {courseProgressCards.map((card) => (
              <article
                key={card.course}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col"
              >
                <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-base font-semibold text-[#0B2240]">
                    {formatCourse(card.course)}
                  </h3>
                  <span className="text-xs font-medium text-slate-600 tabular-nums">
                    {card.topics.length} topic{card.topics.length === 1 ? '' : 's'} practised ·{' '}
                    {card.masteredCount} mastered
                  </span>
                </div>

                <div className="divide-y divide-slate-100">
                  {card.topics.map((topicItem) => {
                    const latestPct = Math.round(topicItem.latestScore * 100);
                    return (
                      <div
                        key={topicItem.key}
                        className="px-5 py-3.5 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-slate-900">
                              {topicItem.topic}
                            </span>
                            {topicItem.mastered && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-800 text-[11px] font-semibold">
                                <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                                <span>Mastered</span>
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 tabular-nums">
                            {topicItem.attempts} attempt{topicItem.attempts === 1 ? '' : 's'} · Best{' '}
                            {Math.round(topicItem.bestScore * 100)}%
                          </p>
                        </div>

                        <div className="text-right shrink-0 space-y-1">
                          <div className="font-mono text-base font-semibold text-[#0B2240] tabular-nums">
                            {latestPct}%
                          </div>
                          <div className="inline-flex items-center justify-end gap-1 text-xs font-medium">
                            {topicItem.trend === 'Improving' && (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Improving</span>
                              </span>
                            )}
                            {topicItem.trend === 'Dipped' && (
                              <span className="inline-flex items-center gap-1 text-amber-700">
                                <TrendingDown className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Dipped</span>
                              </span>
                            )}
                            {topicItem.trend === 'Steady' && (
                              <span className="inline-flex items-center gap-1 text-slate-600">
                                <Minus className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Steady</span>
                              </span>
                            )}
                            {topicItem.trend === 'New' && (
                              <span className="text-slate-500">Latest score</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* My Requests List with Search & Course Filter */}
      <section aria-labelledby="my-requests-heading" className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 id="my-requests-heading" className="font-display text-lg font-semibold text-[#0B2240]">
              My requests
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Search, filter, resume, edit, or cancel your help requests
            </p>
          </div>
          <button
            type="button"
            disabled={isLoadingRequests}
            onClick={() => void loadRequests()}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingRequests ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>

        {/* Search & Course Filter */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={requestSearch}
              onChange={(e) => setRequestSearch(e.target.value)}
              placeholder="Search my requests by topic, course, or description..."
              aria-label="Search my requests"
              className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
            />
          </div>

          <select
            value={requestCourseFilter}
            onChange={(e) => setRequestCourseFilter(e.target.value)}
            aria-label="Filter requests by course"
            className="w-full sm:w-64 min-h-[42px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
          >
            <option value="ALL">All courses</option>
            {requestCourseOptions.map((code) => (
              <option key={code} value={code}>
                {formatCourse(code)}
              </option>
            ))}
          </select>
        </div>

        {isLoadingRequests && (
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <Spinner label="Loading your requests..." />
          </div>
        )}

        {requestsError && !isLoadingRequests && (
          <div
            role="alert"
            className="p-5 rounded-xl bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2.5 text-sm text-red-800">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{requestsError}</span>
            </div>
            <button
              type="button"
              onClick={() => void loadRequests()}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        )}

        {!isLoadingRequests && !requestsError && requests.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
            <p className="font-display text-base font-semibold text-[#0B2240]">
              No requests yet
            </p>
            <p className="text-sm text-slate-500">
              Click &ldquo;Ask for help&rdquo; when you get stuck on a course topic.
            </p>
          </div>
        )}

        {!isLoadingRequests && !requestsError && requests.length > 0 && filteredRequests.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
            <p className="font-display text-base font-semibold text-[#0B2240]">
              No matching requests
            </p>
            <p className="text-sm text-slate-500">
              Try clearing your search or switching the course filter.
            </p>
          </div>
        )}

        {!isLoadingRequests && !requestsError && filteredRequests.length > 0 && (
          <div className="space-y-3">
            {filteredRequests.map((req) => {
              const statusLabel = req.status || 'Open';
              const isBooked = Boolean(req.tutor || req.when);
              const canModify = isEditableOpenStatus(statusLabel);
              const isEditing = editingRequestId === req.id;
              const isConfirmingCancel = confirmCancelId === req.id;

              const reqExams = examsByRequest[req.id];
              const diagExam = reqExams?.diag;
              const retestExam = reqExams?.retest;

              const diagInProgress = Boolean(
                diagExam && diagExam.status === 'in_progress' && diagExam.questions.length > 0
              );
              const retestInProgress = Boolean(
                retestExam && retestExam.status === 'in_progress' && retestExam.questions.length > 0
              );
              const canContinueStudyOrRetest = Boolean(
                !diagInProgress &&
                  !retestInProgress &&
                  diagExam &&
                  diagExam.questions.length > 0 &&
                  canModify
              );

              const totalAnswered =
                (diagExam?.answers.length || 0) + (retestExam?.answers.length || 0);
              const totalMistakes =
                (diagExam?.answers.filter((a) => !a.correct).length || 0) +
                (retestExam?.answers.filter((a) => !a.correct).length || 0);
              const isReviewOpen = reviewingRequestId === req.id;

              let continueLabel = 'Continue exam';
              let continueStage: 'diagnostic' | 'studyPack' | 'retest' = 'diagnostic';
              if (retestInProgress && retestExam) {
                const nextQ = Math.min(retestExam.answers.length + 1, retestExam.questions.length);
                continueLabel = `Continue Retest (Q${nextQ} of ${retestExam.questions.length})`;
                continueStage = 'retest';
              } else if (diagInProgress && diagExam) {
                const nextQ = Math.min(diagExam.answers.length + 1, diagExam.questions.length);
                continueLabel = `Continue Diagnostic (Q${nextQ} of ${diagExam.questions.length})`;
                continueStage = 'diagnostic';
              } else if (diagExam?.studyPack) {
                continueLabel = 'Continue Study Pack & Retest';
                continueStage = 'studyPack';
              } else if (diagExam) {
                continueLabel = 'Open Study Pack';
                continueStage = 'diagnostic';
              }

              return (
                <article
                  key={req.id}
                  className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-[#0B2240] bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                          {formatCourse(req.course)}
                        </span>
                        <span className="text-sm font-semibold text-slate-900">
                          {req.topic || 'Course Topic'}
                        </span>
                      </div>
                      {req.time && (
                        <p className="text-xs text-slate-500 flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{formatDate(req.time)}</span>
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center px-2.5 py-1 rounded-md border text-xs font-semibold whitespace-nowrap ${getStatusBadgeClasses(
                          statusLabel
                        )}`}
                      >
                        {statusLabel}
                      </span>
                      {canModify && !isEditing && (
                        <>
                          <button
                            type="button"
                            onClick={() => startEditing(req)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmCancelId(isConfirmingCancel ? null : req.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Cancel</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isConfirmingCancel && (
                    <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-red-900">
                      <span>Cancel this open request? It will be marked as Cancelled.</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={cancellingId === req.id}
                          onClick={() => void handleCancelRequest(req.id)}
                          className="px-3 py-1.5 rounded-md bg-red-700 text-white font-medium hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                        >
                          {cancellingId === req.id ? 'Cancelling...' : 'Confirm cancel'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmCancelId(null)}
                          className="px-3 py-1.5 rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
                        >
                          Keep open
                        </button>
                      </div>
                    </div>
                  )}

                  {isEditing ? (
                    <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">Course</label>
                        <select
                          value={editCourse}
                          onChange={(e) => setEditCourse(e.target.value)}
                          className="w-full sm:max-w-xs min-h-[38px] px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg"
                        >
                          {courses.map((c) => (
                            <option key={c} value={c}>
                              {formatCourse(c)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Problem description
                        </label>
                        <textarea
                          rows={3}
                          dir="auto"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Personal study note (optional)
                        </label>
                        <textarea
                          rows={2}
                          dir="auto"
                          value={editNote}
                          onChange={(e) => setEditNote(e.target.value)}
                          placeholder="Add notes from your study session..."
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                        />
                      </div>
                      {editError && (
                        <p role="alert" className="text-xs text-red-700 font-medium">
                          {editError}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={isSavingEdit}
                          onClick={() => void handleSaveEdit(req.id)}
                          className="px-4 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                        >
                          {isSavingEdit ? 'Saving...' : 'Save changes'}
                        </button>
                        <button
                          type="button"
                          disabled={isSavingEdit}
                          onClick={() => setEditingRequestId(null)}
                          className="px-4 py-2 min-h-[38px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p
                        dir="auto"
                        className="text-sm text-slate-700 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg px-4 py-3"
                      >
                        {req.text}
                      </p>
                      {req.studentNote && (
                        <p
                          dir="auto"
                          className="text-xs text-slate-600 bg-slate-50/70 border border-slate-200 rounded-lg px-3.5 py-2.5"
                        >
                          <strong className="font-semibold text-[#0B2240]">My study note: </strong>
                          {req.studentNote}
                        </p>
                      )}
                      {req.attachments && req.attachments.length > 0 && (
                        <AttachmentList attachments={req.attachments} />
                      )}
                    </>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600">
                      <div>
                        <span className="text-slate-500">Diagnostic score: </span>
                        <span className="font-mono font-semibold text-[#0B2240] tabular-nums">
                          {diagInProgress && diagExam
                            ? `In progress (${diagExam.answers.length}/${diagExam.questions.length})`
                            : req.diagScore !== null && req.diagScore !== undefined
                              ? formatScore(req.diagScore)
                              : diagExam?.status === 'completed'
                                ? formatScore(diagExam.score)
                                : 'Not done'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Retest score: </span>
                        <span className="font-mono font-semibold text-[#0B2240] tabular-nums">
                          {retestInProgress && retestExam
                            ? `In progress (${retestExam.answers.length}/${retestExam.questions.length})`
                            : req.retestScore !== null && req.retestScore !== undefined
                              ? formatScore(req.retestScore)
                              : retestExam?.status === 'completed'
                                ? formatScore(retestExam.score)
                                : 'Not done'}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {(diagInProgress || retestInProgress || canContinueStudyOrRetest) &&
                        statusLabel !== 'Cancelled' && (
                          <button
                            type="button"
                            onClick={() =>
                              onResumeRequest({
                                request: req,
                                diagExam,
                                retestExam,
                                startStage: continueStage,
                              })
                            }
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
                          >
                            <span>{continueLabel}</span>
                            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        )}

                      {totalAnswered > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setReviewingRequestId(isReviewOpen ? null : req.id)
                          }
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[36px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                        >
                          <span>
                            {isReviewOpen
                              ? 'Hide review'
                              : totalMistakes > 0
                                ? `Review mistakes (${totalMistakes})`
                                : `Review exam (${totalAnswered})`}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {(isBooked || bookingFeedbackByReq[req.id]) && (() => {
                    const matchedBooking = bookingFeedbackByReq[req.id];
                    const liveWhen = matchedBooking
                      ? `${matchedBooking.date} ${matchedBooking.start}-${matchedBooking.end}`
                      : req.when;
                    const liveTutor = matchedBooking?.tutorName || req.tutor;

                    return (
                      <div className="pt-3 border-t border-slate-100 space-y-2.5 text-xs text-blue-900 bg-blue-50/60 border border-blue-100 rounded-lg px-3.5 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                            {liveTutor && (
                              <span className="inline-flex items-center gap-1.5 font-medium">
                                <UserCheck className="w-4 h-4 text-blue-700" aria-hidden="true" />
                                <span>Tutor: {liveTutor}</span>
                              </span>
                            )}
                            {liveWhen && (
                              <span className="inline-flex items-center gap-1.5 font-mono tabular-nums font-medium">
                                <Calendar className="w-4 h-4 text-blue-700" aria-hidden="true" />
                                <span>{liveWhen}</span>
                              </span>
                            )}
                          </div>
                          {matchedBooking && matchedBooking.status === 'booked' && (
                            <button
                              type="button"
                              onClick={() => void openRescheduleDialog(matchedBooking)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#0B2240] bg-white border border-blue-200 rounded-md hover:bg-blue-50 cursor-pointer"
                            >
                              <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>
                                {matchedBooking.rescheduleStatus === 'requested'
                                  ? 'Reschedule requested'
                                  : 'Request reschedule'}
                              </span>
                            </button>
                          )}
                        </div>
                        {matchedBooking?.rescheduleStatus === 'requested' && (
                          <div className="p-2 rounded-md bg-amber-50 border border-amber-200 text-amber-950">
                            <span className="font-semibold">Reschedule pending: </span>
                            <span>{matchedBooking.rescheduleReason}</span>
                          </div>
                        )}
                        {matchedBooking?.tutorFeedback && (
                          <div className="p-2.5 rounded-md bg-white border border-blue-200 text-slate-800">
                            <span className="font-semibold text-[#0B2240]">Tutor Feedback: </span>
                            <span dir="auto" className="whitespace-pre-wrap">
                              {matchedBooking.tutorFeedback}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {isReviewOpen && (diagExam || retestExam) && (
                    <div className="pt-2">
                      <ExamReviewPanel
                        course={req.course}
                        topic={req.topic}
                        diagExam={diagExam}
                        retestExam={retestExam}
                        initialFilter={totalMistakes > 0 ? 'mistakes' : 'all'}
                        onContinueExam={(stage) =>
                          onResumeRequest({
                            request: req,
                            diagExam,
                            retestExam,
                            startStage: stage,
                          })
                        }
                        onClose={() => setReviewingRequestId(null)}
                      />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Request Reschedule Modal */}
      {rescheduleBooking && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="student-reschedule-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleSubmitReschedule}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3
                  id="student-reschedule-title"
                  className="font-display text-lg font-bold text-[#0B2240]"
                >
                  Request a reschedule
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Current session with {rescheduleBooking.tutorName} on{' '}
                  <span className="font-mono font-medium text-slate-700">
                    {rescheduleBooking.date} · {rescheduleBooking.start}–{rescheduleBooking.end}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRescheduleBooking(null)}
                aria-label="Close modal"
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="reschedule-reason-input"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Reason for rescheduling <span className="text-red-600">*</span>
                </label>
                <textarea
                  id="reschedule-reason-input"
                  rows={3}
                  dir="auto"
                  required
                  value={rescheduleReason}
                  onChange={(e) => setRescheduleReason(e.target.value)}
                  placeholder="Explain why you need to move this session (e.g., exam clash, lab schedule)..."
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
                />
              </div>

              <div>
                <label
                  htmlFor="reschedule-preferred-slot"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Preferred available time slot (optional)
                </label>
                {isLoadingRescheduleSlots ? (
                  <p className="text-xs text-slate-500 py-2">Loading available time slots...</p>
                ) : (
                  <select
                    id="reschedule-preferred-slot"
                    value={reschedulePreferredSlotId}
                    onChange={(e) => setReschedulePreferredSlotId(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
                  >
                    <option value="">No specific slot — let tutor suggest a time</option>
                    {openSlotsForReschedule
                      .slice()
                      .sort((a, b) => {
                        const aSame = a.tutorUid === rescheduleBooking.tutorUid ? 0 : 1;
                        const bSame = b.tutorUid === rescheduleBooking.tutorUid ? 0 : 1;
                        if (aSame !== bSame) return aSame - bSame;
                        return `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`);
                      })
                      .slice(0, 30)
                      .map((slot) => (
                        <option key={slot.id} value={slot.id}>
                          {slot.date} · {slot.start} – {slot.end} ({slot.tutorName} · {slot.campus})
                        </option>
                      ))}
                  </select>
                )}
              </div>
            </div>

            {rescheduleError && (
              <p role="alert" className="text-xs text-red-700 font-medium">
                {rescheduleError}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isSubmittingReschedule}
                onClick={() => setRescheduleBooking(null)}
                className="px-4 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingReschedule}
                className="px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
              >
                {isSubmittingReschedule ? 'Submitting...' : 'Submit request'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
