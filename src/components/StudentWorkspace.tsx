import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpen,
  Calendar,
  CalendarPlus,
  CheckCircle2,
  Clock,
  FileText,
  Home,
  Image as ImageIcon,
  MapPin,
  Paperclip,
  PhoneCall,
  RefreshCw,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  AIError,
  bookTutorSession,
  buildAttachmentContext,
  createBookmark,
  createHelpRequest,
  DatabaseError,
  diagnoseWithGemini,
  EncryptionError,
  extractAttachmentsOnServer,
  fetchAvailableBookingSlots,
  fetchCourses,
  fetchRetestQuestions,
  fetchStudyPack,
  generateTutorBrief,
  MAX_ATTACHMENT_FILES,
  saveDiagnosticResult,
  saveExamProgress,
  saveRetestResult,
  saveStudyPackToExam,
  submitFeedback,
  submitStudentRescheduleRequest,
  validateAttachmentFile,
} from '../api';
import { formatCourse, normalizeCourseCode } from '../courses';
import { formatUserError } from '../firebase';
import type {
  BookingItem,
  BookTutorResponse,
  CourseCode,
  DiagnosticItemPayload,
  DiagnosticQuestion,
  DiagnosticResponse,
  FeedbackRating,
  RequestAttachment,
  StoredExamRecord,
  Student,
  StudentResumeContext,
  StudyPackResponse,
  WrongAnswerDetail,
} from '../types';
import { ExamReviewPanel } from './ExamReviewPanel';
import { FormattedText } from './FormattedText';
import { QuestionCard, type QuestionAttemptResult } from './QuestionCard';
import { Spinner } from './Spinner';

interface StudentWorkspaceProps {
  student: Student;
  resumeContext?: StudentResumeContext | null;
  onBackToHome: () => void;
  onOpenHumanSupport: () => void;
}

function getProblemPlaceholder(courseCode: string): string {
  switch (normalizeCourseCode(courseCode)) {
    case 'CIS1813':
      return "Example: I don't understand the difference between supervised and unsupervised machine learning... أو اكتب سؤالك بالعربية";
    case 'CIS2113':
      return "Example: I don't understand how use case diagrams relate to class diagrams... أو اكتب سؤالك بالعربية";
    case 'CIS2213':
      return "Example: I don't understand how client-side state works with API requests... أو اكتب سؤالك بالعربية";
    case 'CIS2903':
      return "Example: I don't understand how CPU scheduling calculates waiting and turnaround time... أو اكتب سؤالك بالعربية";
    case 'CYB2423':
      return "Example: I don't understand the difference between symmetric encryption and hashing... أو اكتب سؤالك بالعربية";
    case 'CYB3513':
      return "Example: I don't understand how to find the broadcast address in /26 subnetting... أو اكتب سؤالك بالعربية";
    case 'CYB3633':
      return "Example: I don't understand how security logs help detect suspicious login activity... أو اكتب سؤالك بالعربية";
    default:
      return "Example: Explain the concept or problem step you are stuck on in this course... أو اكتب سؤالك بالعربية";
  }
}

type WorkflowStep =
  | 'form'
  | 'offTopic'
  | 'quiz'
  | 'summary'
  | 'studyPack'
  | 'retest'
  | 'retestResult';

function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

const HELP_FLOW_STEPS = [
  { num: 1, label: '1 Ask' },
  { num: 2, label: '2 Diagnostic' },
  { num: 3, label: '3 Study pack' },
  { num: 4, label: '4 Retest' },
  { num: 5, label: '5 Result' },
];

function getStepNumber(step: WorkflowStep): number {
  switch (step) {
    case 'form':
      return 1;
    case 'quiz':
    case 'summary':
    case 'offTopic':
      return 2;
    case 'studyPack':
      return 3;
    case 'retest':
      return 4;
    case 'retestResult':
      return 5;
  }
}

export const StudentWorkspace: React.FC<StudentWorkspaceProps> = ({
  student,
  resumeContext,
  onBackToHome,
  onOpenHumanSupport,
}) => {
  // Courses loaded from GET ?action=courses
  const [courses, setCourses] = useState<string[]>([]);
  const [isLoadingCourses, setIsLoadingCourses] = useState(true);
  const [coursesError, setCoursesError] = useState<string | null>(null);
  const [course, setCourse] = useState<CourseCode>(
    normalizeCourseCode(resumeContext?.request.course) || ''
  );

  const [problemText, setProblemText] = useState(resumeContext?.request.text || '');
  const [studentNote, setStudentNote] = useState(resumeContext?.request.studentNote || '');
  const [validationError, setValidationError] = useState<string | null>(null);

  const [step, setStep] = useState<WorkflowStep>('form');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('Working...');

  const [dbError, setDbError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Preserved intermediate state for clean retries & resume
  const [requestId, setRequestId] = useState<string | null>(resumeContext?.request.id || null);
  const [sheetRequestId, setSheetRequestId] = useState<string | undefined>(
    resumeContext?.request.sheetRequestId
  );
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [extractedAttachments, setExtractedAttachments] = useState<RequestAttachment[]>(
    resumeContext?.request.attachments || []
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [aiResult, setAiResult] = useState<DiagnosticResponse | null>(null);
  const [resumedBanner, setResumedBanner] = useState<string | null>(null);
  const [progressSaveNote, setProgressSaveNote] = useState<string | null>(null);

  // Diagnostic Quiz state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentAttempt, setCurrentAttempt] = useState<QuestionAttemptResult | null>(null);
  const [answeredItems, setAnsweredItems] = useState<DiagnosticItemPayload[]>([]);

  // Save diagnostic state
  const [isSavingDiagnostic, setIsSavingDiagnostic] = useState(false);
  const [saveDiagnosticError, setSaveDiagnosticError] = useState<string | null>(null);
  const [diagnosticSaved, setDiagnosticSaved] = useState(false);
  const [showDiagReview, setShowDiagReview] = useState(false);

  // Study pack state
  const [studyPack, setStudyPack] = useState<StudyPackResponse | null>(null);
  const [isLoadingStudyPack, setIsLoadingStudyPack] = useState(false);
  const [studyPackError, setStudyPackError] = useState<string | null>(null);
  const [practiceAttempts, setPracticeAttempts] = useState<Record<number, QuestionAttemptResult>>(
    {}
  );
  const [feedbackRating, setFeedbackRating] = useState<FeedbackRating | null>(null);
  const [pendingRating, setPendingRating] = useState<FeedbackRating | null>(null);
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Study pack & AI answer bookmark state
  const [bookmarkNote, setBookmarkNote] = useState('');
  const [isSavingBookmark, setIsSavingBookmark] = useState(false);
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const [savedAnswerKeys, setSavedAnswerKeys] = useState<Record<string, boolean>>({});
  const [savingAnswerKey, setSavingAnswerKey] = useState<string | null>(null);

  // Retest state
  const [retestQuestions, setRetestQuestions] = useState<DiagnosticQuestion[]>([]);
  const [isLoadingRetest, setIsLoadingRetest] = useState(false);
  const [retestLoadError, setRetestLoadError] = useState<string | null>(null);
  const [retestIndex, setRetestIndex] = useState(0);
  const [retestAttempt, setRetestAttempt] = useState<QuestionAttemptResult | null>(null);
  const [retestItems, setRetestItems] = useState<DiagnosticItemPayload[]>([]);
  const [isSavingRetest, setIsSavingRetest] = useState(false);
  const [saveRetestError, setSaveRetestError] = useState<string | null>(null);
  const [retestStatus, setRetestStatus] = useState<string | null>(null);
  const [showRetestReview, setShowRetestReview] = useState(false);

  // Wrong answer tracking (for tutor brief) & booking state
  const [wrongAnswers, setWrongAnswers] = useState<WrongAnswerDetail[]>([]);
  const [tutorBrief, setTutorBrief] = useState<string | null>(
    resumeContext?.request.brief || null
  );
  const [isBookingTutor, setIsBookingTutor] = useState(false);
  const [bookingLoadingLabel, setBookingLoadingLabel] = useState('Preparing your tutor brief...');
  const [bookingResult, setBookingResult] = useState<BookTutorResponse | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);

  // Available tutor time slots & reschedule request state
  const [availableSlots, setAvailableSlots] = useState<BookingItem[]>([]);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [slotsLoadError, setSlotsLoadError] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string>('');
  const [showAllCampusesSlots, setShowAllCampusesSlots] = useState(false);

  const [showPostBookingReschedule, setShowPostBookingReschedule] = useState(false);
  const [postRescheduleReason, setPostRescheduleReason] = useState('');
  const [postReschedulePreferredId, setPostReschedulePreferredId] = useState('');
  const [isSubmittingPostReschedule, setIsSubmittingPostReschedule] = useState(false);
  const [postRescheduleError, setPostRescheduleError] = useState<string | null>(null);
  const [postRescheduleSent, setPostRescheduleSent] = useState(false);

  // Auto-launch retest flag when student clicks "Start Retest" from Pending Topics
  const [shouldAutoStartRetest, setShouldAutoStartRetest] = useState(false);

  const loadCourses = async () => {
    setIsLoadingCourses(true);
    setCoursesError(null);
    try {
      const list = await fetchCourses();
      setCourses(list);
      const normalizedCurrent = normalizeCourseCode(course);
      if (list.length > 0 && (!normalizedCurrent || !list.includes(normalizedCurrent))) {
        setCourse(list[0]);
      } else if (normalizedCurrent && normalizedCurrent !== course) {
        setCourse(normalizedCurrent);
      }
    } catch (err) {
      setCoursesError(
        formatUserError(err, 'Could not reach the Sanad database. Please try again.')
      );
    } finally {
      setIsLoadingCourses(false);
    }
  };

  useEffect(() => {
    void loadCourses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!resumeContext) return;
    const { request, diagExam, retestExam, startStage } = resumeContext;
    setRequestId(request.id);
    setSheetRequestId(request.sheetRequestId);
    setCourse(normalizeCourseCode(request.course) || request.course);
    setProblemText(request.text);
    setStudentNote(request.studentNote || '');
    setExtractedAttachments(request.attachments || []);
    setTutorBrief(request.brief || null);

    const reconstructedWrong: WrongAnswerDetail[] = [];
    if (diagExam) {
      diagExam.answers
        .filter((a) => !a.correct)
        .forEach((a) =>
          reconstructedWrong.push({
            stage: 'diagnostic',
            question: a.question,
            subtopic: a.subtopic,
            studentAnswer: a.studentAnswer || '',
            correctAnswer: a.correctAnswer || '',
          })
        );
      setAiResult({
        onTopic: true,
        topic: diagExam.topic || request.topic || 'Course Topic',
        diagnosis: diagExam.diagnosis || '',
        questions: diagExam.questions,
      });
      setAnsweredItems(diagExam.answers);
      if (diagExam.studyPack) {
        setStudyPack(diagExam.studyPack);
      }
      if (diagExam.status === 'completed') {
        setDiagnosticSaved(true);
      }
    }

    if (retestExam) {
      retestExam.answers
        .filter((a) => !a.correct)
        .forEach((a) =>
          reconstructedWrong.push({
            stage: 'retest',
            question: a.question,
            subtopic: a.subtopic,
            studentAnswer: a.studentAnswer || '',
            correctAnswer: a.correctAnswer || '',
          })
        );
      setRetestQuestions(retestExam.questions);
      setRetestItems(retestExam.answers);
      if (retestExam.status === 'completed') {
        setRetestStatus(
          request.status === 'Resolved by AI' || request.status === 'Booked with tutor' || request.status === 'Waitlist'
            ? request.status
            : retestExam.score >= 0.7
              ? 'Resolved by AI'
              : 'Escalated to tutor'
        );
      }
    }
    setWrongAnswers(reconstructedWrong);

    if (startStage === 'retestResult' && retestExam && retestExam.status === 'completed') {
      setStep('retestResult');
      setResumedBanner(null);
    } else if (
      (startStage === 'retest' || (!startStage && retestExam?.status === 'in_progress')) &&
      retestExam &&
      retestExam.questions.length > 0
    ) {
      const nextIdx = Math.min(retestExam.answers.length, retestExam.questions.length - 1);
      setRetestIndex(nextIdx);
      setRetestAttempt(null);
      setStep(retestExam.answers.length >= retestExam.questions.length ? 'retestResult' : 'retest');
      setResumedBanner(
        `Resumed retest at Question ${nextIdx + 1} of ${retestExam.questions.length} (${retestExam.answers.length} previously answered).`
      );
    } else if (startStage === 'retest' && diagExam) {
      setStep(diagExam.studyPack ? 'studyPack' : 'summary');
      setShouldAutoStartRetest(true);
      setResumedBanner('Generating your retest questions now...');
    } else if (
      retestExam &&
      retestExam.status === 'completed' &&
      !startStage
    ) {
      setStep('retestResult');
      setResumedBanner(null);
    } else if (startStage === 'studyPack' && diagExam?.studyPack) {
      setStep('studyPack');
      setResumedBanner('Resumed your saved study pack.');
    } else if (
      diagExam &&
      diagExam.status === 'in_progress' &&
      diagExam.questions.length > 0
    ) {
      const nextIdx = Math.min(diagExam.answers.length, diagExam.questions.length - 1);
      setCurrentIndex(nextIdx);
      setCurrentAttempt(null);
      setStep(diagExam.answers.length >= diagExam.questions.length ? 'summary' : 'quiz');
      setResumedBanner(
        `Resumed diagnostic at Question ${nextIdx + 1} of ${diagExam.questions.length} (${diagExam.answers.length} previously answered).`
      );
    } else if (diagExam?.studyPack) {
      setStep('studyPack');
      setResumedBanner('Resumed your saved study pack.');
    } else if (diagExam) {
      setStep('summary');
      setResumedBanner(null);
    }
  }, [resumeContext]);

  const loadAvailableSlots = async () => {
    setIsLoadingSlots(true);
    setSlotsLoadError(null);
    try {
      const slots = await fetchAvailableBookingSlots();
      setAvailableSlots(slots);
      const campusMatches = slots.filter(
        (s) => s.campus.toLowerCase() === student.campus.toLowerCase()
      );
      if (campusMatches.length === 0 && slots.length > 0) {
        setShowAllCampusesSlots(true);
      }
      setSelectedSlotId((prev) => {
        if (prev && slots.some((s) => s.id === prev)) return prev;
        return (campusMatches[0] || slots[0])?.id || '';
      });
    } catch (err) {
      setSlotsLoadError(
        formatUserError(err, 'Could not load available tutor time slots. Please try again.')
      );
    } finally {
      setIsLoadingSlots(false);
    }
  };

  useEffect(() => {
    if (
      step === 'retestResult' &&
      retestStatus &&
      retestStatus !== 'Resolved by AI' &&
      !bookingResult?.tutor &&
      !bookingResult?.waitlist
    ) {
      void loadAvailableSlots();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, retestStatus]);

  useEffect(() => {
    if (shouldAutoStartRetest && aiResult && !isLoadingRetest) {
      setShouldAutoStartRetest(false);
      void handleStartRetest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoStartRetest, aiResult]);

  const handleAddFiles = (incomingList: FileList | File[]) => {
    const incoming = Array.from(incomingList);
    if (incoming.length === 0) return;

    setAttachmentError(null);
    const nextFiles = [...attachedFiles];
    const errors: string[] = [];

    for (const file of incoming) {
      if (nextFiles.length >= MAX_ATTACHMENT_FILES) {
        errors.push(`You can attach up to ${MAX_ATTACHMENT_FILES} files per request.`);
        break;
      }
      const err = validateAttachmentFile(file);
      if (err) {
        errors.push(err);
        continue;
      }
      const alreadyAdded = nextFiles.some(
        (existing) => existing.name === file.name && existing.size === file.size
      );
      if (!alreadyAdded) {
        nextFiles.push(file);
      }
    }

    setAttachedFiles(nextFiles);
    setExtractedAttachments([]);
    if (errors.length > 0) {
      setAttachmentError(errors[0]);
    }
  };

  const handleRemoveAttachedFile = (idx: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));
    setExtractedAttachments([]);
    setAttachmentError(null);
  };

  const handlePasteOnForm = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items || []);
    const pastedImages: File[] = [];

    for (const item of items) {
      if (item.kind === 'file' && (item.type === 'image/png' || item.type === 'image/jpeg')) {
        const blob = item.getAsFile();
        if (blob) {
          const ext = item.type === 'image/jpeg' ? 'jpg' : 'png';
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const named = new File([blob], `pasted-screenshot-${stamp}.${ext}`, {
            type: item.type,
          });
          pastedImages.push(named);
        }
      }
    }

    if (pastedImages.length > 0) {
      e.preventDefault();
      handleAddFiles(pastedImages);
    }
  };

  const runDiagnosisPipeline = async (opts?: { reuseExisting?: boolean }) => {
    const trimmed = problemText.trim();
    if (!course) return;
    setDbError(null);
    setAiError(null);
    setAttachmentError(null);
    setIsLoading(true);

    let activeRequestId = opts?.reuseExisting ? requestId : null;
    let activeAttachments = extractedAttachments;

    try {
      if (!activeRequestId) {
        if (attachedFiles.length > 0 && activeAttachments.length !== attachedFiles.length) {
          setLoadingMessage('Reading text from your attached files...');
          activeAttachments = await extractAttachmentsOnServer(attachedFiles);
          setExtractedAttachments(activeAttachments);
        }

        setLoadingMessage('Saving your request...');
        const created = await createHelpRequest({
          studentUid: student.id,
          studentEmail: student.email,
          sheetEmail: student.sheetEmail,
          studentName: student.name,
          campus: student.campus,
          course,
          text: trimmed,
          studentNote: studentNote.trim() || undefined,
          attachments: activeAttachments.length > 0 ? activeAttachments : undefined,
        });
        activeRequestId = created.requestId;
        setRequestId(created.requestId);
        setSheetRequestId(created.sheetRequestId);
      }

      const attachmentContext = buildAttachmentContext(studentNote, activeAttachments);

      setLoadingMessage('Analyzing your question with Sanad AI...');
      const diagnosis = await diagnoseWithGemini({
        course,
        studentText: trimmed,
        attachmentContext: attachmentContext || undefined,
      });

      setAiResult(diagnosis);
      setCurrentIndex(0);
      setCurrentAttempt(null);
      setAnsweredItems([]);
      setWrongAnswers([]);
      setDiagnosticSaved(false);
      setSaveDiagnosticError(null);
      setResumedBanner(null);

      if (!diagnosis.onTopic) {
        setStep('offTopic');
      } else {
        if (activeRequestId) {
          void saveExamProgress({
            studentUid: student.id,
            requestId: activeRequestId,
            stage: 'diagnostic',
            course,
            topic: diagnosis.topic,
            status: 'in_progress',
            currentIndex: 0,
            questions: diagnosis.questions,
            diagnosis: diagnosis.diagnosis,
            items: [],
          })
            .then(() => setProgressSaveNote('Exam questions & progress saved automatically'))
            .catch(() => undefined);
        }
        setStep('quiz');
      }
    } catch (err) {
      if (err instanceof AIError) {
        setAiError(err.message);
      } else if (err instanceof EncryptionError) {
        setDbError(err.message);
      } else if (err instanceof DatabaseError) {
        setDbError('Could not reach the Sanad database. Please try again.');
      } else {
        setDbError(formatUserError(err, 'Could not reach the Sanad database. Please try again.'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = problemText.trim();
    if (trimmed.length < 10) {
      setValidationError('Please describe your problem in a sentence.');
      return;
    }
    if (!course) return;
    setValidationError(null);
    setRequestId(null);
    setSheetRequestId(undefined);
    setExtractedAttachments([]);
    void runDiagnosisPipeline({ reuseExisting: false });
  };

  const handleDiagnosticAttempt = (result: QuestionAttemptResult) => {
    if (!aiResult || currentAttempt !== null) return;
    const q = aiResult.questions[currentIndex];
    const newItem: DiagnosticItemPayload = {
      question: q.question,
      subtopic: q.subtopic,
      correct: result.correct,
      questionType: q.type,
      studentAnswer: result.studentAnswerText,
      correctAnswer: result.correctAnswerText,
      feedback: result.feedbackText,
    };
    const nextItems = [...answeredItems, newItem];
    setCurrentAttempt(result);
    setAnsweredItems(nextItems);
    if (!result.correct) {
      setWrongAnswers((prev) => [
        ...prev,
        {
          stage: 'diagnostic',
          question: q.question,
          subtopic: q.subtopic,
          studentAnswer: result.studentAnswerText,
          correctAnswer: result.correctAnswerText,
        },
      ]);
    }
    if (requestId) {
      void saveExamProgress({
        studentUid: student.id,
        requestId,
        stage: 'diagnostic',
        course,
        topic: aiResult.topic,
        status: 'in_progress',
        currentIndex: Math.min(nextItems.length, aiResult.questions.length),
        questions: aiResult.questions,
        diagnosis: aiResult.diagnosis,
        items: nextItems,
      })
        .then(() =>
          setProgressSaveNote(
            `Progress saved (${nextItems.length} of ${aiResult.questions.length} answered)`
          )
        )
        .catch(() => undefined);
    }
  };

  const submitDiagnosticSummary = async (finalItems: DiagnosticItemPayload[]) => {
    if (!requestId || !aiResult) return;
    setIsSavingDiagnostic(true);
    setSaveDiagnosticError(null);
    const correctCount = finalItems.filter((item) => item.correct).length;
    const scoreRatio = finalItems.length > 0 ? correctCount / finalItems.length : 0;
    const computedWeak = Array.from(
      new Set(finalItems.filter((i) => !i.correct).map((i) => i.subtopic))
    );

    try {
      await saveDiagnosticResult({
        studentUid: student.id,
        requestId,
        sheetRequestId,
        course,
        topic: aiResult.topic,
        score: Number(scoreRatio.toFixed(2)),
        items: finalItems,
        weakSubtopics: computedWeak,
        questions: aiResult.questions,
        diagnosis: aiResult.diagnosis,
      });
      setDiagnosticSaved(true);
    } catch (err) {
      setSaveDiagnosticError(
        err instanceof EncryptionError
          ? err.message
          : formatUserError(err, 'Could not save your diagnostic results. Please try again.')
      );
    } finally {
      setIsSavingDiagnostic(false);
    }
  };

  const handleNextQuestion = () => {
    if (!aiResult) return;
    setResumedBanner(null);
    if (currentIndex < aiResult.questions.length - 1) {
      setCurrentIndex((prev) => prev + 1);
      setCurrentAttempt(null);
    } else {
      setStep('summary');
      void submitDiagnosticSummary(answeredItems);
    }
  };

  const handleReset = () => {
    setStep('form');
    setProblemText('');
    setStudentNote('');
    setAttachedFiles([]);
    setExtractedAttachments([]);
    setAttachmentError(null);
    setIsDraggingFiles(false);
    setValidationError(null);
    setDbError(null);
    setAiError(null);
    setRequestId(null);
    setSheetRequestId(undefined);
    setAiResult(null);
    setResumedBanner(null);
    setProgressSaveNote(null);
    setShowDiagReview(false);
    setShowRetestReview(false);
    setCurrentIndex(0);
    setCurrentAttempt(null);
    setAnsweredItems([]);
    setDiagnosticSaved(false);
    setSaveDiagnosticError(null);
    setStudyPack(null);
    setIsLoadingStudyPack(false);
    setStudyPackError(null);
    setPracticeAttempts({});
    setFeedbackRating(null);
    setPendingRating(null);
    setIsSendingFeedback(false);
    setFeedbackError(null);
    setBookmarkNote('');
    setBookmarkSaved(false);
    setBookmarkError(null);
    setSavedAnswerKeys({});
    setSavingAnswerKey(null);
    setRetestQuestions([]);
    setIsLoadingRetest(false);
    setRetestLoadError(null);
    setRetestIndex(0);
    setRetestAttempt(null);
    setRetestItems([]);
    setIsSavingRetest(false);
    setSaveRetestError(null);
    setRetestStatus(null);
    setWrongAnswers([]);
    setTutorBrief(null);
    setIsBookingTutor(false);
    setBookingResult(null);
    setBookingError(null);
  };

  const handleLoadStudyPack = async () => {
    if (!aiResult) return;
    const attachmentContext = buildAttachmentContext(studentNote, extractedAttachments);
    setIsLoadingStudyPack(true);
    setStudyPackError(null);
    try {
      const pack = await fetchStudyPack({
        course,
        topic: aiResult.topic,
        studentText: problemText.trim(),
        attachmentContext: attachmentContext || undefined,
        weakSubtopics,
      });
      setStudyPack(pack);
      setPracticeAttempts({});
      setFeedbackRating(null);
      setPendingRating(null);
      setFeedbackError(null);
      setBookmarkSaved(false);
      setBookmarkError(null);
      if (requestId) {
        void saveStudyPackToExam({ requestId, studyPack: pack }).catch(() => undefined);
      }
      setStep('studyPack');
    } catch (err) {
      setStudyPackError(
        err instanceof AIError
          ? err.message
          : formatUserError(err, "Sanad's AI is busy. Please try again.")
      );
    } finally {
      setIsLoadingStudyPack(false);
    }
  };

  const handleFeedback = async (rating: FeedbackRating) => {
    if (!requestId || isSendingFeedback) return;
    setPendingRating(rating);
    setIsSendingFeedback(true);
    setFeedbackError(null);
    try {
      await submitFeedback({
        studentUid: student.id,
        requestId,
        sheetRequestId,
        part: 'study pack',
        rating,
      });
      setFeedbackRating(rating);
    } catch {
      setFeedbackError('Could not reach the Sanad database. Please try again.');
    } finally {
      setIsSendingFeedback(false);
    }
  };

  const handleSaveBookmark = async () => {
    if (!aiResult || isSavingBookmark) return;
    setIsSavingBookmark(true);
    setBookmarkError(null);
    try {
      await createBookmark({
        studentUid: student.id,
        course,
        topic: aiResult.topic,
        title: `${formatCourse(course)} – ${aiResult.topic} (Personal note)`,
        note: bookmarkNote.trim() || studyPack?.explanation.slice(0, 200) || problemText.trim(),
        requestId: requestId || undefined,
      });
      setBookmarkSaved(true);
    } catch (err) {
      setBookmarkError(formatUserError(err, 'Failed to save answer. Please try again.'));
    } finally {
      setIsSavingBookmark(false);
    }
  };

  const handleBookmarkAiAnswer = async (key: string, title: string, noteBody: string) => {
    if (!aiResult) return;
    setSavingAnswerKey(key);
    try {
      await createBookmark({
        studentUid: student.id,
        course,
        topic: aiResult.topic,
        title,
        note: noteBody,
        requestId: requestId || undefined,
      });
      setSavedAnswerKeys((prev) => ({ ...prev, [key]: true }));
    } catch (err) {
      setBookmarkError(formatUserError(err, 'Could not save this answer. Please try again.'));
    } finally {
      setSavingAnswerKey(null);
    }
  };

  const handlePracticeAttempt = (qIdx: number, result: QuestionAttemptResult) => {
    setPracticeAttempts((prev) => ({
      ...prev,
      [qIdx]: result,
    }));
  };

  const handleStartRetest = async () => {
    if (!aiResult) return;
    const attachmentContext = buildAttachmentContext(studentNote, extractedAttachments);
    setIsLoadingRetest(true);
    setRetestLoadError(null);

    const priorQuestions = [
      ...aiResult.questions.map((q) => q.question),
      ...(studyPack?.practice.map((q) => q.question) ?? []),
    ];

    try {
      const res = await fetchRetestQuestions({
        course,
        topic: aiResult.topic,
        studentText: problemText.trim(),
        attachmentContext: attachmentContext || undefined,
        weakSubtopics,
        previousQuestions: priorQuestions,
      });
      setRetestQuestions(res.questions);
      setRetestIndex(0);
      setRetestAttempt(null);
      setRetestItems([]);
      setRetestStatus(null);
      setSaveRetestError(null);
      setTutorBrief(null);
      setBookingResult(null);
      setBookingError(null);
      setResumedBanner(null);
      setWrongAnswers((prev) => prev.filter((item) => item.stage === 'diagnostic'));
      if (requestId) {
        void saveExamProgress({
          studentUid: student.id,
          requestId,
          stage: 'retest',
          course,
          topic: aiResult.topic,
          status: 'in_progress',
          currentIndex: 0,
          questions: res.questions,
          items: [],
          weakSubtopics,
        })
          .then(() => setProgressSaveNote('Retest questions & progress saved automatically'))
          .catch(() => undefined);
      }
      setStep('retest');
    } catch (err) {
      setRetestLoadError(
        err instanceof AIError
          ? err.message
          : formatUserError(err, "Sanad's AI is busy. Please try again.")
      );
    } finally {
      setIsLoadingRetest(false);
    }
  };

  const handleRetestAttempt = (result: QuestionAttemptResult) => {
    if (retestAttempt !== null) return;
    const q = retestQuestions[retestIndex];
    if (!q) return;
    const newItem: DiagnosticItemPayload = {
      question: q.question,
      subtopic: q.subtopic,
      correct: result.correct,
      questionType: q.type,
      studentAnswer: result.studentAnswerText,
      correctAnswer: result.correctAnswerText,
      feedback: result.feedbackText,
    };
    const nextRetestItems = [...retestItems, newItem];
    setRetestAttempt(result);
    setRetestItems(nextRetestItems);
    if (!result.correct) {
      setWrongAnswers((prev) => [
        ...prev,
        {
          stage: 'retest',
          question: q.question,
          subtopic: q.subtopic,
          studentAnswer: result.studentAnswerText,
          correctAnswer: result.correctAnswerText,
        },
      ]);
    }
    if (requestId && aiResult) {
      void saveExamProgress({
        studentUid: student.id,
        requestId,
        stage: 'retest',
        course,
        topic: aiResult.topic,
        status: 'in_progress',
        currentIndex: Math.min(nextRetestItems.length, retestQuestions.length),
        questions: retestQuestions,
        items: nextRetestItems,
        weakSubtopics,
      })
        .then(() =>
          setProgressSaveNote(
            `Retest progress saved (${nextRetestItems.length} of ${retestQuestions.length} answered)`
          )
        )
        .catch(() => undefined);
    }
  };

  const handleBookTutor = async () => {
    if (!requestId || !aiResult || isBookingTutor) return;
    if (bookingResult?.tutor || bookingResult?.waitlist) return;

    setIsBookingTutor(true);
    setBookingError(null);

    try {
      let activeBrief = tutorBrief;
      if (!activeBrief) {
        setBookingLoadingLabel('Preparing a 30-minute brief for your tutor...');
        const attachmentContext = buildAttachmentContext(studentNote, extractedAttachments);
        activeBrief = await generateTutorBrief({
          studentText: problemText.trim(),
          attachmentContext: attachmentContext || undefined,
          topic: aiResult.topic,
          weakSubtopics,
          wrongAnswers,
        });
        setTutorBrief(activeBrief);
      }

      setBookingLoadingLabel('Confirming your selected tutoring time slot...');
      const response = await bookTutorSession({
        studentUid: student.id,
        studentName: student.name,
        studentEmail: student.email,
        campus: student.campus,
        requestId,
        sheetRequestId,
        course,
        topic: aiResult.topic,
        problemText: problemText.trim(),
        brief: activeBrief,
        attachments: extractedAttachments.length > 0 ? extractedAttachments : undefined,
        selectedSlotId: selectedSlotId || undefined,
      });

      if (response.ok === false) {
        setBookingError(response.error || 'Could not complete your booking. Please try again.');
        void loadAvailableSlots();
        return;
      }

      if ((response.tutor && response.when) || response.waitlist) {
        setBookingResult(response);
        setAvailableSlots((prev) => prev.filter((s) => s.id !== response.bookingId));
      } else {
        setBookingError(response.error || 'Could not complete your booking. Please try again.');
      }
    } catch (err) {
      if (err instanceof AIError || err instanceof EncryptionError) {
        setBookingError(err.message);
      } else {
        setBookingError(formatUserError(err, 'Could not complete your booking. Please try again.'));
      }
    } finally {
      setIsBookingTutor(false);
    }
  };

  const handleSubmitPostBookingReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookingResult?.bookingId) return;
    if (postRescheduleReason.trim().length < 3) {
      setPostRescheduleError('Please enter a short reason for rescheduling.');
      return;
    }
    setIsSubmittingPostReschedule(true);
    setPostRescheduleError(null);
    try {
      const preferred = availableSlots.find((s) => s.id === postReschedulePreferredId);
      await submitStudentRescheduleRequest({
        bookingId: bookingResult.bookingId,
        studentUid: student.id,
        reason: postRescheduleReason.trim(),
        preferredSlotId: preferred?.id,
        preferredWhen: preferred
          ? `${preferred.date} ${preferred.start}-${preferred.end}`
          : undefined,
      });
      setPostRescheduleSent(true);
      setShowPostBookingReschedule(false);
    } catch (err) {
      setPostRescheduleError(
        formatUserError(err, 'Could not send your reschedule request. Please try again.')
      );
    } finally {
      setIsSubmittingPostReschedule(false);
    }
  };

  const submitRetestSummary = async (finalItems: DiagnosticItemPayload[]) => {
    if (!requestId || !aiResult) return;
    setIsSavingRetest(true);
    setSaveRetestError(null);
    const retestCorrectCount = finalItems.filter((item) => item.correct).length;
    const scoreRatio = finalItems.length > 0 ? retestCorrectCount / finalItems.length : 0;

    try {
      const returnedStatus = await saveRetestResult({
        studentUid: student.id,
        requestId,
        sheetRequestId,
        course,
        topic: aiResult.topic,
        score: Number(scoreRatio.toFixed(2)),
        items: finalItems,
        weakSubtopics,
        questions: retestQuestions,
      });
      setRetestStatus(returnedStatus);
    } catch (err) {
      setSaveRetestError(
        err instanceof EncryptionError
          ? err.message
          : formatUserError(err, 'Could not save your retest score. Please try again.')
      );
    } finally {
      setIsSavingRetest(false);
    }
  };

  const handleNextRetestQuestion = () => {
    setResumedBanner(null);
    if (retestIndex < retestQuestions.length - 1) {
      setRetestIndex((prev) => prev + 1);
      setRetestAttempt(null);
    } else {
      setStep('retestResult');
      void submitRetestSummary(retestItems);
    }
  };

  const isArabicContent =
    containsArabic(problemText) ||
    (aiResult?.diagnosis ? containsArabic(aiResult.diagnosis) : false);

  const currentQuestion = aiResult?.questions[currentIndex];
  const correctCount = answeredItems.filter((i) => i.correct).length;
  const weakSubtopics = Array.from(
    new Set(answeredItems.filter((i) => !i.correct).map((i) => i.subtopic))
  );

  const activeStepNumber = getStepNumber(step);

  return (
    <div className="space-y-6">
      {/* 5-Step Flow Indicator */}
      <nav
        aria-label="Help request steps"
        className="bg-white border border-slate-200 rounded-xl px-4 py-3.5 sm:px-6"
      >
        <ol className="flex items-center justify-between gap-2 overflow-x-auto">
          {HELP_FLOW_STEPS.map((item, idx) => {
            const isCurrent = item.num === activeStepNumber;
            const isDone = item.num < activeStepNumber;

            return (
              <React.Fragment key={item.num}>
                <li className="flex items-center gap-2 shrink-0">
                  <span
                    aria-current={isCurrent ? 'step' : undefined}
                    className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
                      isCurrent
                        ? 'bg-[#0B2240] text-white'
                        : isDone
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {item.label}
                  </span>
                </li>
                {idx < HELP_FLOW_STEPS.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={`hidden sm:block h-px flex-1 min-w-[16px] ${
                      isDone ? 'bg-emerald-300' : 'bg-slate-200'
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </ol>
      </nav>

      {/* STEP 1: Ask for Help Form */}
      {step === 'form' && (
        <section
          aria-labelledby="ask-help-heading"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8"
        >
          <div className="max-w-2xl">
            <h1 id="ask-help-heading" className="font-display text-2xl font-bold text-[#0B2240]">
              Ask for help
            </h1>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
              Select your course and explain what you are struggling with in English or Arabic.
            </p>
          </div>

          {isLoadingCourses && (
            <div className="mt-5">
              <Spinner label="Loading courses from Sanad database..." />
            </div>
          )}

          {coursesError && !isLoadingCourses && (
            <div
              role="alert"
              className="mt-5 p-4 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-sm text-red-800">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{coursesError}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadCourses()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {!isLoadingCourses && !coursesError && (
            <form onSubmit={handleFormSubmit} onPaste={handlePasteOnForm} noValidate className="mt-6 space-y-5">
              <div>
                <label
                  htmlFor="course-select"
                  className="block text-sm font-medium text-slate-800 mb-1.5"
                >
                  Course
                </label>
                <select
                  id="course-select"
                  value={course}
                  disabled={isLoading || courses.length === 0}
                  onChange={(e) => setCourse(e.target.value)}
                  className="w-full sm:max-w-md min-h-[44px] px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0B2240] focus:border-[#0B2240] disabled:bg-slate-50"
                >
                  {courses.map((code) => (
                    <option key={code} value={code}>
                      {formatCourse(code)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <label
                    htmlFor="problem-textarea"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Describe what you are stuck on
                  </label>
                  <span className="text-xs text-slate-500">English or Arabic</span>
                </div>
                <textarea
                  id="problem-textarea"
                  rows={4}
                  dir="auto"
                  disabled={isLoading}
                  value={problemText}
                  onChange={(e) => {
                    setProblemText(e.target.value);
                    if (validationError && e.target.value.trim().length >= 10) {
                      setValidationError(null);
                    }
                  }}
                  placeholder={getProblemPlaceholder(course)}
                  className={`w-full px-3.5 py-3 text-sm bg-white border rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B2240] focus:border-[#0B2240] disabled:bg-slate-50 ${
                    validationError ? 'border-red-500' : 'border-slate-300'
                  }`}
                />
                {validationError && (
                  <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-red-700">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{validationError}</span>
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <label
                    htmlFor="student-note-textarea"
                    className="block text-sm font-medium text-slate-800"
                  >
                    Personal study notes (optional)
                  </label>
                  <span className="text-xs text-slate-500">Private to you and your tutor</span>
                </div>
                <textarea
                  id="student-note-textarea"
                  rows={2}
                  dir="auto"
                  disabled={isLoading}
                  value={studentNote}
                  onChange={(e) => setStudentNote(e.target.value)}
                  placeholder="Optional: paste your own summary, steps, or formulas you tried..."
                  className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B2240] focus:border-[#0B2240] disabled:bg-slate-50"
                />
              </div>

              <div className="space-y-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="block text-sm font-medium text-slate-800">
                    Attach screenshots or files (optional)
                  </span>
                  <span className="text-xs text-slate-500">
                    PNG, JPG, or PDF · Up to {MAX_ATTACHMENT_FILES} files, 10 MB each
                  </span>
                </div>

                <label
                  htmlFor="student-attachments-input"
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!isLoading) setIsDraggingFiles(true);
                  }}
                  onDragLeave={() => setIsDraggingFiles(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDraggingFiles(false);
                    if (!isLoading && e.dataTransfer?.files) {
                      handleAddFiles(e.dataTransfer.files);
                    }
                  }}
                  className={`flex flex-col items-center justify-center gap-1.5 px-4 py-5 border-2 border-dashed rounded-xl text-center transition-colors cursor-pointer ${
                    isDraggingFiles
                      ? 'border-[#0B2240] bg-blue-50/70'
                      : 'border-slate-300 bg-slate-50 hover:border-[#0B2240] hover:bg-slate-100/70'
                  } ${isLoading ? 'opacity-50 pointer-events-none' : ''}`}
                >
                  <Upload className="w-5 h-5 text-[#0B2240]" aria-hidden="true" />
                  <p className="text-xs font-semibold text-[#0B2240]">
                    Drag and drop screenshots or PDFs here, click to browse, or paste an image (Ctrl+V / Cmd+V)
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Allowed formats: PNG, JPG, PDF (max 10 MB per file)
                  </p>
                  <input
                    id="student-attachments-input"
                    type="file"
                    multiple
                    disabled={isLoading || attachedFiles.length >= MAX_ATTACHMENT_FILES}
                    accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
                    onChange={(e) => {
                      if (e.target.files) {
                        handleAddFiles(e.target.files);
                        e.target.value = '';
                      }
                    }}
                    className="sr-only"
                  />
                </label>

                {attachmentError && (
                  <p role="alert" className="flex items-center gap-1.5 text-xs text-red-700 font-medium">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{attachmentError}</span>
                  </p>
                )}

                {attachedFiles.length > 0 && (
                  <ul className="space-y-1.5">
                    {attachedFiles.map((file, idx) => {
                      const isPdf =
                        file.type === 'application/pdf' ||
                        file.name.toLowerCase().endsWith('.pdf');
                      const sizeLabel =
                        file.size >= 1024 * 1024
                          ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
                          : `${Math.max(1, Math.round(file.size / 1024))} KB`;
                      return (
                        <li
                          key={`${file.name}-${file.size}-${idx}`}
                          className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {isPdf ? (
                              <FileText className="w-4 h-4 text-[#0B2240] shrink-0" aria-hidden="true" />
                            ) : (
                              <ImageIcon className="w-4 h-4 text-[#0B2240] shrink-0" aria-hidden="true" />
                            )}
                            <span className="font-medium text-slate-900 truncate">{file.name}</span>
                            <span className="text-slate-500 font-mono tabular-nums shrink-0">
                              {sizeLabel}
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={isLoading}
                            onClick={() => handleRemoveAttachedFile(idx)}
                            aria-label={`Remove ${file.name}`}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-red-700 hover:bg-red-50 disabled:opacity-50 cursor-pointer shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Remove</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {attachedFiles.length === 0 && extractedAttachments.length > 0 && (
                  <div className="text-xs text-slate-600 flex items-center gap-1.5">
                    <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {extractedAttachments.length} saved attachment
                      {extractedAttachments.length === 1 ? '' : 's'} included with this request.
                    </span>
                  </div>
                )}
              </div>

              {isLoading && <Spinner label={loadingMessage} />}

              {dbError && !isLoading && (
                <div
                  role="alert"
                  className="p-4 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-start gap-2.5 text-sm text-red-800">
                    <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{dbError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void runDiagnosisPipeline({ reuseExisting: true })}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    <span>Retry</span>
                  </button>
                </div>
              )}

              {aiError && !isLoading && (
                <div
                  role="alert"
                  className="p-4 rounded-lg bg-amber-50 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-start gap-2.5 text-sm text-amber-900">
                    <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{aiError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void runDiagnosisPipeline({ reuseExisting: true })}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    <span>Retry</span>
                  </button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={isLoading || !course}
                  className="inline-flex items-center justify-center gap-2 px-6 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <span>Get Diagnostic Help</span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {/* STEP 2A: Off-Topic Result */}
      {step === 'offTopic' && (
        <section
          aria-labelledby="off-topic-heading"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs font-medium text-slate-500">
              AI-generated · Course Notes Check
            </span>
            <span className="font-mono text-xs text-slate-500">{formatCourse(course)}</span>
          </div>

          <div className="space-y-2">
            <h2 id="off-topic-heading" className="font-display text-xl font-semibold text-[#0B2240]">
              Sanad can only help with topics from your course notes. Talk to a human at the ASC?
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              Your question did not match a topic in the {formatCourse(course)} study notes. An ASC tutor on your{' '}
              <strong className="font-medium text-slate-900">{student.campus}</strong> campus can help you directly.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onBackToHome}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
            >
              <Home className="w-4 h-4" aria-hidden="true" />
              <span>Back to Home</span>
            </button>
            <button
              type="button"
              onClick={onOpenHumanSupport}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <PhoneCall className="w-4 h-4" aria-hidden="true" />
              <span>Talk to a human</span>
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>Ask another question</span>
            </button>
          </div>
        </section>
      )}

      {/* STEP 2B: Diagnosis + Mixed Diagnostic Quiz */}
      {step === 'quiz' && aiResult && currentQuestion && (
        <div className="space-y-6">
          {resumedBanner && (
            <div
              role="status"
              className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-xs font-medium text-blue-900"
            >
              {resumedBanner}
            </div>
          )}

          {aiResult.diagnosis && (
            <section
              aria-labelledby="diagnosis-heading"
              className="bg-white border border-slate-200 rounded-xl p-6 space-y-3"
              dir={isArabicContent ? 'rtl' : 'ltr'}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <span>AI-generated · {aiResult.topic}</span>
                <div className="flex items-center gap-2.5">
                  <span className="font-mono">{formatCourse(course)}</span>
                  <button
                    type="button"
                    disabled={savingAnswerKey === 'diagnosis' || Boolean(savedAnswerKeys.diagnosis)}
                    onClick={() =>
                      void handleBookmarkAiAnswer(
                        'diagnosis',
                        `${aiResult.topic} — Initial Diagnosis`,
                        aiResult.diagnosis
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-300 text-xs font-medium text-[#0B2240] bg-white hover:bg-slate-50 disabled:opacity-70 cursor-pointer"
                  >
                    {savedAnswerKeys.diagnosis ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                        <span>Saved</span>
                      </>
                    ) : (
                      <>
                        <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{savingAnswerKey === 'diagnosis' ? 'Saving...' : 'Save answer'}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
              <h2
                id="diagnosis-heading"
                className="font-display text-lg font-semibold text-[#0B2240]"
              >
                {isArabicContent ? 'التشخيص الأولي' : 'Initial Diagnosis'}
              </h2>
              <p className="text-base text-slate-800 leading-relaxed">
                {aiResult.diagnosis}
              </p>
            </section>
          )}

          <section
            aria-label="Diagnostic question"
            className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>AI-generated · {currentQuestion.subtopic}</span>
              <span className="font-mono tabular-nums font-medium text-[#0B2240]">
                Question {currentIndex + 1} of {aiResult.questions.length}
              </span>
            </div>

            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#0B2240] transition-all duration-200"
                style={{
                  width: `${((currentIndex + (currentAttempt !== null ? 1 : 0)) / aiResult.questions.length) * 100}%`,
                }}
              />
            </div>

            <QuestionCard
              key={`diag-${currentIndex}`}
              question={currentQuestion}
              course={course}
              aiLabel="AI-generated"
              groupName={`diag-q-${currentIndex}`}
              attempt={currentAttempt}
              onComplete={handleDiagnosticAttempt}
              onBookmarkAnswer={
                currentAttempt
                  ? () =>
                      handleBookmarkAiAnswer(
                        `diag-${currentIndex}`,
                        `${currentQuestion.subtopic} — Diagnostic Q&A`,
                        `Question: ${currentQuestion.question}\nCorrect answer: ${currentAttempt.correctAnswerText}\n\nExplanation:\n${currentAttempt.feedbackText}`
                      )
                  : undefined
              }
            />

            <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-400">
                {progressSaveNote || 'Questions & progress auto-save after each attempt'}
              </span>
              {currentAttempt !== null && (
                <button
                  type="button"
                  onClick={handleNextQuestion}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
                >
                  <span>
                    {currentIndex < aiResult.questions.length - 1
                      ? 'Next Question'
                      : 'Finish & See Score'}
                  </span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {/* STEP 3: Final Score & Weak Sub-topics */}
      {step === 'summary' && aiResult && (
        <section
          aria-labelledby="summary-heading"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6"
          dir={isArabicContent ? 'rtl' : 'ltr'}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>AI-generated · Diagnostic Summary</span>
            <span className="font-mono">
              {formatCourse(course)} · {aiResult.topic}
            </span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 border-b border-slate-200">
            <div>
              <h2 id="summary-heading" className="font-display text-2xl font-bold text-[#0B2240]">
                {isArabicContent ? 'نتيجة التشخيص' : 'Diagnostic Complete'}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {isArabicContent
                  ? `ملخص أدائك في الأسئلة (${answeredItems.length}):`
                  : `Here is how you performed across the ${answeredItems.length} diagnostic questions.`}
              </p>
            </div>
            <div className="text-left sm:text-right">
              <div className="text-xs text-slate-500">Score</div>
              <div className="font-mono text-3xl font-semibold text-[#0B2240] tabular-nums">
                {correctCount} / {answeredItems.length}
                <span className="ml-2 text-base font-normal text-slate-500">
                  ({Math.round((correctCount / Math.max(1, answeredItems.length)) * 100)}%)
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-display text-base font-semibold text-slate-900">
              {isArabicContent ? 'الموضوعات الفرعية التي تحتاج إلى مراجعة' : 'Weak Sub-topics'}
            </h3>

            {weakSubtopics.length > 0 ? (
              <ul className="space-y-2">
                {weakSubtopics.map((subtopic) => (
                  <li
                    key={subtopic}
                    className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-800"
                  >
                    <span className="flex items-center gap-2.5 text-sm font-medium text-red-700">
                      <XCircle className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                      <span>{subtopic}</span>
                    </span>
                    <span className="text-xs font-medium text-red-700 shrink-0">
                      Needs review
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2.5 px-4 py-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm font-medium text-emerald-800">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>
                  {isArabicContent
                    ? 'لم يتم رصد نقاط ضعف — أحسنت!'
                    : 'No weak sub-topics detected. You answered every question correctly.'}
                </span>
              </div>
            )}
          </div>

          {isSavingDiagnostic && (
            <Spinner label="Saving your diagnostic result to Sanad database..." />
          )}

          {saveDiagnosticError && !isSavingDiagnostic && (
            <div
              role="alert"
              className="p-4 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-sm text-red-800">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{saveDiagnosticError}</span>
              </div>
              <button
                type="button"
                onClick={() => void submitDiagnosticSummary(answeredItems)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {diagnosticSaved && !isSavingDiagnostic && (
            <p className="text-xs text-slate-500">
              Diagnostic session saved
            </p>
          )}

          {isLoadingStudyPack && (
            <Spinner label="Generating your personalized study pack..." />
          )}

          {studyPackError && !isLoadingStudyPack && (
            <div
              role="alert"
              className="p-4 rounded-lg bg-amber-50 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-sm text-amber-900">
                <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{studyPackError}</span>
              </div>
              <button
                type="button"
                onClick={() => void handleLoadStudyPack()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>Retry</span>
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              disabled={isLoadingStudyPack}
              onClick={() => void handleLoadStudyPack()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors cursor-pointer"
            >
              <BookOpen className="w-4 h-4" aria-hidden="true" />
              <span>{isArabicContent ? 'عرض حزمة الدراسة' : 'Open your study pack'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowDiagReview((prev) => !prev)}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <span>{showDiagReview ? 'Hide review' : 'Review answers & mistakes'}</span>
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>Ask another question</span>
            </button>
            <button
              type="button"
              onClick={onOpenHumanSupport}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <PhoneCall className="w-4 h-4" aria-hidden="true" />
              <span>Talk to a human</span>
            </button>
          </div>

          {showDiagReview && (
            <ExamReviewPanel
              course={course}
              topic={aiResult.topic}
              initialStage="diagnostic"
              initialFilter="mistakes"
              diagExam={{
                id: `${requestId || 'current'}_diagnostic`,
                requestId: requestId || 'current',
                stage: 'diagnostic',
                course,
                topic: aiResult.topic,
                status: 'completed',
                currentIndex: answeredItems.length,
                score: answeredItems.length > 0 ? correctCount / answeredItems.length : 0,
                totalQuestions: aiResult.questions.length,
                correctCount,
                weakSubtopics,
                diagnosis: aiResult.diagnosis,
                questions: aiResult.questions,
                answers: answeredItems,
              }}
              onClose={() => setShowDiagReview(false)}
            />
          )}
        </section>
      )}

      {/* STEP 4: Your Study Pack */}
      {step === 'studyPack' && aiResult && studyPack && (
        <div className="space-y-6" dir={isArabicContent ? 'rtl' : 'ltr'}>
          <section
            aria-labelledby="study-pack-heading"
            className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>AI-generated from your course notes</span>
              <span className="font-mono">
                {formatCourse(course)} · {aiResult.topic}
              </span>
            </div>

            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 id="study-pack-heading" className="font-display text-2xl font-bold text-[#0B2240]">
                  {isArabicContent ? 'حزمة الدراسة الخاصة بك' : 'Your study pack'}
                </h1>
                {weakSubtopics.length > 0 && (
                  <p className="mt-1 text-sm text-slate-600">
                    Focused on: {weakSubtopics.join(' · ')}
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={savingAnswerKey === 'studyPack' || Boolean(savedAnswerKeys.studyPack)}
                onClick={() =>
                  void handleBookmarkAiAnswer(
                    'studyPack',
                    `${aiResult.topic} — Complete Study Pack`,
                    `${studyPack.explanation}\n\n---\nWorked Example:\n${studyPack.workedExample}`
                  )
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-70 transition-colors shrink-0 cursor-pointer"
              >
                {savedAnswerKeys.studyPack ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                    <span>Study pack saved</span>
                  </>
                ) : (
                  <>
                    <Bookmark className="w-4 h-4" aria-hidden="true" />
                    <span>
                      {savingAnswerKey === 'studyPack' ? 'Saving...' : 'Save study pack'}
                    </span>
                  </>
                )}
              </button>
            </div>

            <div className="pt-2 border-t border-slate-200 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                  {isArabicContent ? 'الشرح المبسط' : 'Simple Explanation'}
                </h2>
                <span className="text-xs text-slate-500">AI-generated from your course notes</span>
              </div>
              <p className="text-base text-slate-800 leading-relaxed whitespace-pre-line">
                {studyPack.explanation}
              </p>

              <div className="pt-3 flex flex-wrap items-center gap-3">
                <span className="text-xs font-medium text-slate-600">
                  {isArabicContent ? 'هل كان هذا الشرح مفيداً؟' : 'Was this explanation helpful?'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSendingFeedback}
                    onClick={() => void handleFeedback('up')}
                    aria-label="Thumbs up"
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
                      feedbackRating === 'up'
                        ? 'bg-emerald-50 border-emerald-600 text-emerald-800'
                        : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <ThumbsUp className="w-4 h-4" aria-hidden="true" />
                    <span>Helpful</span>
                  </button>
                  <button
                    type="button"
                    disabled={isSendingFeedback}
                    onClick={() => void handleFeedback('down')}
                    aria-label="Thumbs down"
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
                      feedbackRating === 'down'
                        ? 'bg-red-50 border-red-600 text-red-800'
                        : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <ThumbsDown className="w-4 h-4" aria-hidden="true" />
                    <span>Needs work</span>
                  </button>
                </div>
                {feedbackRating && !isSendingFeedback && !feedbackError && (
                  <span className="text-xs text-emerald-700 font-medium">
                    Feedback recorded
                  </span>
                )}
              </div>

              {isSendingFeedback && <Spinner label="Saving feedback..." />}

              {feedbackError && !isSendingFeedback && pendingRating && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 text-xs text-red-800">
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                    <span>{feedbackError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleFeedback(pendingRating)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Retry</span>
                  </button>
                </div>
              )}
            </div>
          </section>

          <section
            aria-labelledby="worked-example-heading"
            className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id="worked-example-heading" className="font-display text-lg font-semibold text-[#0B2240]">
                {isArabicContent ? 'مثال محلول خطوة بخطوة' : 'Worked Example'}
              </h2>
              <span className="text-xs text-slate-500">AI-generated from your course notes</span>
            </div>
            <div className="p-4 sm:p-5 rounded-lg bg-slate-50 border border-slate-200">
              <FormattedText text={studyPack.workedExample} />
            </div>

            <div className="pt-4 border-t border-slate-200 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold text-[#0B2240] flex items-center gap-1.5">
                  <Bookmark className="w-4 h-4" aria-hidden="true" />
                  <span>Save a personal takeaway</span>
                </h3>
                <span className="text-xs text-slate-500">Private study note</span>
              </div>
              <textarea
                rows={2}
                dir="auto"
                value={bookmarkNote}
                onChange={(e) => {
                  setBookmarkNote(e.target.value);
                  if (bookmarkSaved) setBookmarkSaved(false);
                }}
                placeholder="Write a quick reminder or takeaway to save with this topic..."
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
              />
              {bookmarkError && (
                <p role="alert" className="text-xs text-red-700 font-medium">
                  {bookmarkError}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={isSavingBookmark}
                  onClick={() => void handleSaveBookmark()}
                  className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                >
                  <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{isSavingBookmark ? 'Saving...' : 'Save to Saved answers'}</span>
                </button>
                {bookmarkSaved && (
                  <span className="text-xs font-medium text-emerald-700 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    <span>Saved to Saved answers</span>
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* Mixed-type Practice Questions */}
          <section
            aria-labelledby="practice-heading"
            className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 id="practice-heading" className="font-display text-lg font-semibold text-[#0B2240]">
                  {isArabicContent ? 'أسئلة تدريبية' : 'Practice Questions'}
                </h2>
                <p className="text-sm text-slate-600">
                  {isArabicContent
                    ? 'أجب عن كل سؤال للحصول على تصحيح فوري.'
                    : 'Answer each question for instant feedback.'}
                </p>
              </div>
              <span className="text-xs text-slate-500">AI-generated from your course notes</span>
            </div>

            <div className="divide-y divide-slate-200">
              {studyPack.practice.map((pq, qIdx) => {
                const attempt = practiceAttempts[qIdx] ?? null;
                return (
                  <div key={qIdx} className="py-6 first:pt-0 last:pb-0 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <span>AI-generated from your course notes · {pq.subtopic}</span>
                      <span className="font-mono tabular-nums font-medium text-[#0B2240]">
                        Question {qIdx + 1} of {studyPack.practice.length}
                      </span>
                    </div>

                    <QuestionCard
                      key={`practice-${qIdx}`}
                      question={pq}
                      course={course}
                      aiLabel="AI-generated from your course notes"
                      groupName={`practice-q-${qIdx}`}
                      attempt={attempt}
                      onComplete={(res) => handlePracticeAttempt(qIdx, res)}
                      onBookmarkAnswer={
                        attempt
                          ? () =>
                              handleBookmarkAiAnswer(
                                `practice-${qIdx}`,
                                `${pq.subtopic} — Practice Q&A`,
                                `Question: ${pq.question}\nCorrect answer: ${attempt.correctAnswerText}\n\nExplanation:\n${attempt.feedbackText}`
                              )
                          : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            {isLoadingRetest && (
              <Spinner label="Generating new retest questions..." />
            )}

            {retestLoadError && !isLoadingRetest && (
              <div
                role="alert"
                className="p-4 rounded-lg bg-amber-50 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex items-start gap-2.5 text-sm text-amber-900">
                  <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{retestLoadError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleStartRetest()}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  <span>Retry</span>
                </button>
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                  {isArabicContent ? 'هل أنت مستعد للاختبار الجديد؟' : 'Ready to check your progress?'}
                </h2>
                <p className="text-sm text-slate-600">
                  {isArabicContent
                    ? 'سنختبرك بأسئلة جديدة حول نقاط الضعف السابقة.'
                    : 'Take a retest with new questions on the same sub-topics.'}
                </p>
              </div>
              <button
                type="button"
                disabled={isLoadingRetest}
                onClick={() => void handleStartRetest()}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
              >
                <span>I&apos;m ready – retest me</span>
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </section>
        </div>
      )}

      {/* STEP 5: Retest Quiz (Mixed types, one at a time) */}
      {step === 'retest' && retestQuestions[retestIndex] && (
        <section
          aria-label="Retest question"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5"
        >
          {resumedBanner && (
            <div
              role="status"
              className="p-3.5 rounded-lg bg-blue-50 border border-blue-200 text-xs font-medium text-blue-900"
            >
              {resumedBanner}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              AI-generated · Retest · {retestQuestions[retestIndex].subtopic}
            </span>
            <span className="font-mono tabular-nums font-medium text-[#0B2240]">
              Question {retestIndex + 1} of {retestQuestions.length}
            </span>
          </div>

          <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#0B2240] transition-all duration-200"
              style={{
                width: `${((retestIndex + (retestAttempt !== null ? 1 : 0)) / retestQuestions.length) * 100}%`,
              }}
            />
          </div>

          <QuestionCard
            key={`retest-${retestIndex}`}
            question={retestQuestions[retestIndex]}
            course={course}
            aiLabel="AI-generated"
            groupName={`retest-q-${retestIndex}`}
            attempt={retestAttempt}
            onComplete={handleRetestAttempt}
            onBookmarkAnswer={
              retestAttempt
                ? () =>
                    handleBookmarkAiAnswer(
                      `retest-${retestIndex}`,
                      `${retestQuestions[retestIndex].subtopic} — Retest Q&A`,
                      `Question: ${retestQuestions[retestIndex].question}\nCorrect answer: ${retestAttempt.correctAnswerText}\n\nExplanation:\n${retestAttempt.feedbackText}`
                    )
                : undefined
            }
          />

          <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-400">
              {progressSaveNote || 'Retest progress auto-saves after each attempt'}
            </span>
            {retestAttempt !== null && (
              <button
                type="button"
                onClick={handleNextRetestQuestion}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
              >
                <span>
                  {retestIndex < retestQuestions.length - 1
                    ? 'Next Question'
                    : 'Finish & Submit Retest'}
                </span>
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </section>
      )}

      {/* STEP 6: Retest Result Screen */}
      {step === 'retestResult' && (
        <section
          aria-labelledby="retest-result-heading"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6"
          dir={isArabicContent ? 'rtl' : 'ltr'}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>AI-generated · Retest Outcome</span>
            <span className="font-mono">
              {formatCourse(course)} · {aiResult?.topic}
            </span>
          </div>

          {isSavingRetest && (
            <Spinner label="Saving your retest score to Sanad database..." />
          )}

          {saveRetestError && !isSavingRetest && (
            <div
              role="alert"
              className="p-4 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-sm text-red-800">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{saveRetestError}</span>
              </div>
              <button
                type="button"
                onClick={() => void submitRetestSummary(retestItems)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {!isSavingRetest && !saveRetestError && retestStatus && (
            <>
              {retestStatus === 'Resolved by AI' ? (
                <div className="p-6 sm:p-8 rounded-xl bg-emerald-50 border border-emerald-200 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <CheckCircle2
                        className="w-7 h-7 text-emerald-700 shrink-0 mt-0.5"
                        aria-hidden="true"
                      />
                      <div>
                        <h2
                          id="retest-result-heading"
                          className="font-display text-2xl font-bold text-emerald-950"
                        >
                          Great – resolved! No tutor needed.
                        </h2>
                        <p className="mt-1 text-sm text-emerald-800">
                          Status: {retestStatus}
                        </p>
                      </div>
                    </div>
                    <div className="font-mono text-2xl font-semibold text-emerald-900 tabular-nums shrink-0">
                      {retestItems.filter((i) => i.correct).length} / {retestItems.length} (
                      {Math.round(
                        (retestItems.filter((i) => i.correct).length /
                          Math.max(1, retestItems.length)) *
                          100
                      )}
                      %)
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-6 sm:p-8 rounded-xl bg-slate-50 border border-slate-200 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <p className="text-xs font-medium text-slate-500">
                        Status: {retestStatus}
                      </p>
                      <h2
                        id="retest-result-heading"
                        className="mt-1 font-display text-2xl font-bold text-[#0B2240]"
                      >
                        Let&apos;s get you a human tutor
                      </h2>
                      <p className="mt-1 text-sm text-slate-600">
                        A peer or ASC tutor at <strong className="font-medium text-slate-900">{student.campus}</strong> can walk through the remaining gaps with you.
                      </p>
                    </div>
                    <div className="font-mono text-2xl font-semibold text-[#0B2240] tabular-nums shrink-0">
                      {retestItems.filter((i) => i.correct).length} / {retestItems.length} (
                      {Math.round(
                        (retestItems.filter((i) => i.correct).length /
                          Math.max(1, retestItems.length)) *
                          100
                      )}
                      %)
                    </div>
                  </div>

                  {!(bookingResult?.tutor && bookingResult?.when) && !bookingResult?.waitlist && (
                    <div className="space-y-4">
                      {/* Available Time Slots Picker */}
                      <div className="rounded-xl bg-white border border-slate-200 p-4 sm:p-5 space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div>
                            <h3 className="font-display text-sm font-semibold text-[#0B2240] flex items-center gap-1.5">
                              <Calendar className="w-4 h-4" aria-hidden="true" />
                              <span>Available tutor time slots</span>
                            </h3>
                            <p className="text-xs text-slate-500 mt-0.5">
                              Select a day and time that works best for you before confirming.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => setShowAllCampusesSlots((prev) => !prev)}
                              className="px-2.5 py-1.5 text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-md hover:bg-slate-100 cursor-pointer"
                            >
                              {showAllCampusesSlots
                                ? `Filter to ${student.campus}`
                                : 'Show all campuses'}
                            </button>
                            <button
                              type="button"
                              disabled={isLoadingSlots}
                              onClick={() => void loadAvailableSlots()}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                            >
                              <RefreshCw
                                className={`w-3.5 h-3.5 ${isLoadingSlots ? 'animate-spin' : ''}`}
                                aria-hidden="true"
                              />
                              <span>Refresh</span>
                            </button>
                          </div>
                        </div>

                        {isLoadingSlots && <Spinner label="Loading available tutor time slots..." />}

                        {slotsLoadError && !isLoadingSlots && (
                          <div
                            role="alert"
                            className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-center justify-between gap-2"
                          >
                            <span>{slotsLoadError}</span>
                            <button
                              type="button"
                              onClick={() => void loadAvailableSlots()}
                              className="px-2.5 py-1 rounded bg-[#0B2240] text-white font-medium cursor-pointer shrink-0"
                            >
                              Retry
                            </button>
                          </div>
                        )}

                        {!isLoadingSlots && !slotsLoadError && (() => {
                          const visibleSlots = showAllCampusesSlots
                            ? availableSlots
                            : availableSlots.filter(
                                (s) => s.campus.toLowerCase() === student.campus.toLowerCase()
                              );

                          if (visibleSlots.length === 0) {
                            return (
                              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-2">
                                <p className="font-medium text-slate-800">
                                  No open slots are listed{showAllCampusesSlots ? '' : ` at ${student.campus}`} right now.
                                </p>
                                {!showAllCampusesSlots && availableSlots.length > 0 ? (
                                  <button
                                    type="button"
                                    onClick={() => setShowAllCampusesSlots(true)}
                                    className="text-[#0B2240] font-semibold underline cursor-pointer"
                                  >
                                    View {availableSlots.length} open slot{availableSlots.length === 1 ? '' : 's'} at other campuses
                                  </button>
                                ) : (
                                  <p>You can still click below to join the waitlist and the ASC will schedule a tutor for you.</p>
                                )}
                              </div>
                            );
                          }

                          const groupedByDate: Array<[string, BookingItem[]]> = [];
                          const map = new Map<string, BookingItem[]>();
                          visibleSlots.slice(0, 36).forEach((slot) => {
                            const arr = map.get(slot.date) || [];
                            arr.push(slot);
                            map.set(slot.date, arr);
                          });
                          map.forEach((items, dateKey) => groupedByDate.push([dateKey, items]));

                          return (
                            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                              {groupedByDate.map(([dateKey, daySlots]) => {
                                const [yy, mm, dd] = dateKey.split('-').map(Number);
                                const formattedDay =
                                  yy && mm && dd
                                    ? new Date(yy, mm - 1, dd).toLocaleDateString(undefined, {
                                        weekday: 'short',
                                        month: 'short',
                                        day: 'numeric',
                                      })
                                    : dateKey;

                                return (
                                  <div key={dateKey} className="space-y-1.5">
                                    <p className="text-xs font-semibold text-slate-600">
                                      {formattedDay} <span className="font-mono font-normal text-slate-400">({dateKey})</span>
                                    </p>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                                      {daySlots.map((slot) => {
                                        const isSelected = selectedSlotId === slot.id;
                                        return (
                                          <button
                                            key={slot.id}
                                            type="button"
                                            onClick={() => setSelectedSlotId(slot.id)}
                                            aria-pressed={isSelected}
                                            className={`text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                                              isSelected
                                                ? 'bg-[#0B2240] text-white border-[#0B2240]'
                                                : 'bg-slate-50 text-slate-800 border-slate-200 hover:border-[#0B2240]/50 hover:bg-white'
                                            }`}
                                          >
                                            <div className="flex items-center gap-1.5 font-mono text-xs font-semibold tabular-nums">
                                              <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                              <span>
                                                {slot.start} – {slot.end}
                                              </span>
                                            </div>
                                            <p
                                              className={`mt-1 text-xs font-medium truncate ${
                                                isSelected ? 'text-blue-100' : 'text-slate-700'
                                              }`}
                                            >
                                              {slot.tutorName}
                                            </p>
                                            <p
                                              className={`text-[11px] flex items-center gap-1 truncate ${
                                                isSelected ? 'text-slate-300' : 'text-slate-500'
                                              }`}
                                            >
                                              <MapPin className="w-3 h-3 shrink-0" aria-hidden="true" />
                                              <span>{slot.campus}</span>
                                            </p>
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        {(() => {
                          const chosenSlot = availableSlots.find((s) => s.id === selectedSlotId);
                          return (
                            <button
                              type="button"
                              disabled={isBookingTutor}
                              onClick={() => void handleBookTutor()}
                              className="inline-flex items-center justify-center gap-2 px-6 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                            >
                              <CalendarPlus className="w-4 h-4" aria-hidden="true" />
                              <span>
                                {isBookingTutor
                                  ? 'Booking...'
                                  : chosenSlot
                                    ? `Confirm slot (${chosenSlot.date} · ${chosenSlot.start})`
                                    : 'Join tutor waitlist'}
                              </span>
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {isBookingTutor && <Spinner label={bookingLoadingLabel} />}

                  {tutorBrief && (
                    <div className="p-4 sm:p-5 rounded-lg bg-white border border-slate-200 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
                        <h3 className="font-display text-sm font-semibold text-[#0B2240]">
                          Sanad will send this to your tutor
                        </h3>
                        <span className="text-xs text-slate-500">AI-generated</span>
                      </div>
                      <FormattedText text={tutorBrief} />
                    </div>
                  )}

                  {bookingError && !isBookingTutor && (
                    <div
                      role="alert"
                      className="p-4 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-2.5 text-sm text-red-800">
                        <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>{bookingError}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleBookTutor()}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
                      >
                        <RefreshCw className="w-4 h-4" aria-hidden="true" />
                        <span>Retry</span>
                      </button>
                    </div>
                  )}

                  {bookingResult?.tutor && bookingResult?.when && (
                    <div
                      role="status"
                      className="p-5 rounded-xl bg-emerald-50 border border-emerald-200 space-y-3 text-emerald-950"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <CheckCircle2 className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" aria-hidden="true" />
                          <div className="space-y-1">
                            <p className="font-display text-base font-semibold">
                              Booked with {bookingResult.tutor} on {bookingResult.when} at the {student.campus} ASC.
                            </p>
                            {postRescheduleSent && (
                              <p className="text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 inline-block">
                                Reschedule request sent to your tutor. You can track it on your Home page.
                              </p>
                            )}
                          </div>
                        </div>

                        {bookingResult.bookingId && !postRescheduleSent && (
                          <button
                            type="button"
                            onClick={() => setShowPostBookingReschedule((prev) => !prev)}
                            className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-[#0B2240] bg-white border border-emerald-300 rounded-lg hover:bg-emerald-100/50 shrink-0 cursor-pointer"
                          >
                            {showPostBookingReschedule ? 'Cancel reschedule' : 'Need a different time?'}
                          </button>
                        )}
                      </div>

                      {showPostBookingReschedule && bookingResult.bookingId && (
                        <form
                          onSubmit={handleSubmitPostBookingReschedule}
                          className="pt-3 border-t border-emerald-200 space-y-3 bg-white/80 rounded-lg p-3.5"
                        >
                          <div>
                            <label className="block text-xs font-medium text-slate-800 mb-1">
                              Reason for rescheduling <span className="text-red-600">*</span>
                            </label>
                            <textarea
                              rows={2}
                              value={postRescheduleReason}
                              onChange={(e) => setPostRescheduleReason(e.target.value)}
                              placeholder="e.g., I have a lab exam during this time..."
                              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                            />
                          </div>

                          {availableSlots.length > 0 && (
                            <div>
                              <label className="block text-xs font-medium text-slate-800 mb-1">
                                Preferred alternative slot (optional)
                              </label>
                              <select
                                value={postReschedulePreferredId}
                                onChange={(e) => setPostReschedulePreferredId(e.target.value)}
                                className="w-full min-h-[36px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                              >
                                <option value="">Let tutor suggest a new time</option>
                                {availableSlots.slice(0, 24).map((slot) => (
                                  <option key={slot.id} value={slot.id}>
                                    {slot.date} · {slot.start} – {slot.end} ({slot.tutorName})
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          {postRescheduleError && (
                            <p role="alert" className="text-xs text-red-700 font-medium">
                              {postRescheduleError}
                            </p>
                          )}

                          <button
                            type="submit"
                            disabled={isSubmittingPostReschedule}
                            className="px-4 py-2 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                          >
                            {isSubmittingPostReschedule ? 'Sending...' : 'Submit reschedule request'}
                          </button>
                        </form>
                      )}
                    </div>
                  )}

                  {bookingResult?.waitlist && (
                    <div
                      role="status"
                      className="p-5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3 text-amber-950"
                    >
                      <AlertCircle className="w-6 h-6 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="space-y-1">
                        <p className="font-display text-base font-semibold">
                          No tutor is free on your campus this week. You are on the waitlist and the ASC will contact you.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRetestReview((prev) => !prev)}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <span>{showRetestReview ? 'Hide review' : 'Review answers & mistakes'}</span>
                </button>
                <button
                  type="button"
                  onClick={onBackToHome}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                  <span>Back to Home</span>
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" aria-hidden="true" />
                  <span>Ask another question</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenHumanSupport}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <PhoneCall className="w-4 h-4" aria-hidden="true" />
                  <span>Talk to a human</span>
                </button>
              </div>

              {showRetestReview && (
                <ExamReviewPanel
                  course={course}
                  topic={aiResult?.topic}
                  initialStage="retest"
                  initialFilter="mistakes"
                  diagExam={
                    aiResult && answeredItems.length > 0
                      ? {
                          id: `${requestId || 'current'}_diagnostic`,
                          requestId: requestId || 'current',
                          stage: 'diagnostic',
                          course,
                          topic: aiResult.topic,
                          status: 'completed',
                          currentIndex: answeredItems.length,
                          score: answeredItems.length > 0 ? correctCount / answeredItems.length : 0,
                          totalQuestions: aiResult.questions.length,
                          correctCount,
                          weakSubtopics,
                          diagnosis: aiResult.diagnosis,
                          questions: aiResult.questions,
                          answers: answeredItems,
                        }
                      : undefined
                  }
                  retestExam={{
                    id: `${requestId || 'current'}_retest`,
                    requestId: requestId || 'current',
                    stage: 'retest',
                    course,
                    topic: aiResult?.topic || '',
                    status: 'completed',
                    currentIndex: retestItems.length,
                    score:
                      retestItems.length > 0
                        ? retestItems.filter((i) => i.correct).length / retestItems.length
                        : 0,
                    totalQuestions: retestQuestions.length,
                    correctCount: retestItems.filter((i) => i.correct).length,
                    weakSubtopics,
                    questions: retestQuestions,
                    answers: retestItems,
                  }}
                  onClose={() => setShowRetestReview(false)}
                />
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
};
