import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Building2,
  Calendar,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Edit3,
  Eye,
  FileText,
  History,
  Image as ImageIcon,
  MessageSquare,
  Paperclip,
  PhoneCall,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {
  createTutorNote,
  createTutorSlot,
  deleteTutorNote,
  fetchCourses,
  fetchMaterialExtractedNotes,
  fetchMaterialPdfBlobUrl,
  fetchPublishedMaterials,
  fetchTutorHandledStudents,
  fetchTutorNoteAttachmentBlobUrl,
  fetchTutorSentNotes,
  fetchTutorSessions,
  fetchTutorWeeklySchedule,
  markSessionComplete,
  MAX_ATTACHMENT_FILES,
  replyToTutorNote,
  respondToRescheduleRequest,
  saveTutorSessionFeedback,
  saveTutorWeeklySchedule,
  updateTutorCourses,
  updateTutorNote,
  updateTutorSlot,
  uploadTutorNoteAttachments,
  validateAttachmentFile,
} from '../api';
import { compareTopicTitles, deriveTopicTitleFromFileName, formatCourse } from '../courses';
import { formatUserError } from '../firebase';
import {
  STANDARD_TIME_SLOTS,
  TUTOR_T1_SAMPLE_SCHEDULE,
  WEEKDAY_CODES,
  WEEKDAY_LABELS,
} from '../seedData';
import type {
  FirestoreMaterial,
  MaterialNotePageGroup,
  TutorHandledStudent,
  TutorNoteAttachment,
  TutorNoteAudience,
  TutorNoteItem,
  TutorSession,
  WeekdayCode,
} from '../types';
import { AttachmentList } from './AttachmentList';
import { FormattedText } from './FormattedText';
import { Spinner } from './Spinner';

interface TutorWorkspaceProps {
  tutorUid: string;
  tutorRefId: string;
  tutorName: string;
  tutorCampus?: string;
  tutorSubjects?: string;
  onSubjectsUpdated?: (subjects: string) => void;
  onOpenHumanSupport: () => void;
}

function getSlotStatusBadge(status: TutorSession['status']): string {
  switch (status) {
    case 'booked':
      return 'bg-blue-50 text-blue-800 border-blue-200';
    case 'completed':
      return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    case 'open':
      return 'bg-slate-100 text-slate-800 border-slate-200';
    case 'inactive':
    case 'cancelled':
      return 'bg-amber-50 text-amber-800 border-amber-200';
  }
}

function parseSubjectsList(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

export const TutorWorkspace: React.FC<TutorWorkspaceProps> = ({
  tutorUid,
  tutorRefId,
  tutorName,
  tutorCampus,
  tutorSubjects,
  onSubjectsUpdated,
  onOpenHumanSupport,
}) => {
  const [activeTab, setActiveTab] = useState<'sessions' | 'materials' | 'notes'>('sessions');
  const [sessions, setSessions] = useState<TutorSession[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  // Read-only course materials state
  const [materials, setMaterials] = useState<FirestoreMaterial[]>([]);
  const [isLoadingMaterials, setIsLoadingMaterials] = useState(false);
  const [materialsError, setMaterialsError] = useState<string | null>(null);
  const [matSearch, setMatSearch] = useState('');
  const [matCourseFilter, setMatCourseFilter] = useState('all');
  const [expandedCourses, setExpandedCourses] = useState<Record<string, boolean>>({});
  const [loadingPdfId, setLoadingPdfId] = useState<string | null>(null);
  const [downloadingMatId, setDownloadingMatId] = useState<string | null>(null);
  const [viewingPdf, setViewingPdf] = useState<{
    id: string;
    fileName: string;
    courseCode: string;
    url: string;
  } | null>(null);
  const [loadingNotesMatId, setLoadingNotesMatId] = useState<string | null>(null);
  const [viewingExtractedNotes, setViewingExtractedNotes] = useState<{
    material: FirestoreMaterial;
    pages: MaterialNotePageGroup[];
  } | null>(null);

  // Send to students (Tutor Notes) state
  const [sentNotes, setSentNotes] = useState<TutorNoteItem[]>([]);
  const [handledStudents, setHandledStudents] = useState<TutorHandledStudent[]>([]);
  const [isLoadingSentNotes, setIsLoadingSentNotes] = useState(false);
  const [sentNotesError, setSentNotesError] = useState<string | null>(null);
  const [noteBanner, setNoteBanner] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteCourseCode, setNoteCourseCode] = useState('');
  const [noteAudience, setNoteAudience] = useState<TutorNoteAudience>('course');
  const [noteStudentId, setNoteStudentId] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [noteExistingAttachments, setNoteExistingAttachments] = useState<TutorNoteAttachment[]>([]);
  const [noteRemovedAttachmentIds, setNoteRemovedAttachmentIds] = useState<string[]>([]);
  const [noteQueuedFiles, setNoteQueuedFiles] = useState<File[]>([]);
  const [noteFormError, setNoteFormError] = useState<string | null>(null);
  const [isSubmittingNote, setIsSubmittingNote] = useState(false);
  const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState<string | null>(null);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [tutorReplyDrafts, setTutorReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReplyNoteId, setSendingReplyNoteId] = useState<string | null>(null);
  const [noteAttachmentBusyId, setNoteAttachmentBusyId] = useState<string | null>(null);
  const [previewNoteAttachment, setPreviewNoteAttachment] = useState<{
    fileName: string;
    mimeType: string;
    url: string;
  } | null>(null);

  // Approved courses management state
  const [catalogCourses, setCatalogCourses] = useState<string[]>([]);
  const [approvedCourses, setApprovedCourses] = useState<string[]>(() =>
    parseSubjectsList(tutorSubjects)
  );
  const [isEditingCourses, setIsEditingCourses] = useState(false);
  const [draftCourses, setDraftCourses] = useState<string[]>([]);
  const [isSavingCourses, setIsSavingCourses] = useState(false);
  const [courseBanner, setCourseBanner] = useState<string | null>(null);

  // Session notes & student feedback editor state
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null);
  const [draftTutorNotes, setDraftTutorNotes] = useState('');
  const [draftTutorFeedback, setDraftTutorFeedback] = useState('');
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);

  // Add slot state
  const [showAddSlot, setShowAddSlot] = useState(false);
  const [newDate, setNewDate] = useState(() =>
    new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  );
  const [newStart, setNewStart] = useState('10:00');
  const [newEnd, setNewEnd] = useState('10:30');
  const [isCreatingSlot, setIsCreatingSlot] = useState(false);
  const [slotActionError, setSlotActionError] = useState<string | null>(null);

  // Edit slot state
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [editStatus, setEditStatus] = useState<'open' | 'inactive'>('open');
  const [isSavingSlot, setIsSavingSlot] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);

  // Weekly availability schedule state (Day|Start|End keys)
  const [selectedWeeklySlots, setSelectedWeeklySlots] = useState<string[]>([]);
  const [isSavingWeeklySchedule, setIsSavingWeeklySchedule] = useState(false);
  const [weeklyScheduleBanner, setWeeklyScheduleBanner] = useState<string | null>(null);
  const [weeklyScheduleError, setWeeklyScheduleError] = useState<string | null>(null);

  // Reschedule request response state
  const [respondingRescheduleId, setRespondingRescheduleId] = useState<string | null>(null);
  const [rescheduleTargetSlotId, setRescheduleTargetSlotId] = useState<string>('');
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleStart, setRescheduleStart] = useState('');
  const [rescheduleEnd, setRescheduleEnd] = useState('');
  const [rescheduleNote, setRescheduleNote] = useState('');
  const [isSubmittingRescheduleResponse, setIsSubmittingRescheduleResponse] = useState(false);

  useEffect(() => {
    setApprovedCourses(parseSubjectsList(tutorSubjects));
  }, [tutorSubjects]);

  const loadSessions = async () => {
    setIsLoadingSessions(true);
    setSessionsError(null);
    try {
      const [list, catalog, weekly] = await Promise.all([
        fetchTutorSessions(tutorUid),
        fetchCourses().catch(() => [] as string[]),
        fetchTutorWeeklySchedule(tutorUid).catch(() => null),
      ]);
      setSessions(list);
      if (catalog.length > 0) {
        setCatalogCourses(catalog);
      }
      if (weekly) {
        setSelectedWeeklySlots(weekly.scheduleSlots);
      }
    } catch (err) {
      setSessionsError(
        formatUserError(err, 'Could not reach Sanad right now. Please try again.')
      );
    } finally {
      setIsLoadingSessions(false);
    }
  };

  useEffect(() => {
    return () => {
      if (viewingPdf?.url) {
        URL.revokeObjectURL(viewingPdf.url);
      }
      if (previewNoteAttachment?.url) {
        URL.revokeObjectURL(previewNoteAttachment.url);
      }
    };
  }, [viewingPdf, previewNoteAttachment]);

  const loadMaterials = async () => {
    setIsLoadingMaterials(true);
    setMaterialsError(null);
    try {
      const [mats, catalog] = await Promise.all([
        fetchPublishedMaterials(),
        fetchCourses().catch(() => [] as string[]),
      ]);
      setMaterials(mats);
      if (catalog.length > 0) {
        setCatalogCourses(catalog);
      }
    } catch (err) {
      setMaterialsError(
        formatUserError(err, 'Could not load course materials right now.')
      );
    } finally {
      setIsLoadingMaterials(false);
    }
  };

  const loadSentNotes = async () => {
    setIsLoadingSentNotes(true);
    setSentNotesError(null);
    try {
      const [notesList, studentsList, catalog] = await Promise.all([
        fetchTutorSentNotes(tutorUid),
        fetchTutorHandledStudents(tutorUid),
        catalogCourses.length > 0 ? Promise.resolve(catalogCourses) : fetchCourses().catch(() => [] as string[]),
      ]);
      setSentNotes(notesList);
      setHandledStudents(studentsList);
      if (catalog.length > 0 && catalogCourses.length === 0) {
        setCatalogCourses(catalog);
      }
      if (!noteCourseCode) {
        const defaultCourse = approvedCourses[0] || catalog[0] || '';
        if (defaultCourse) setNoteCourseCode(defaultCourse);
      }
      if (!noteStudentId && studentsList.length > 0) {
        setNoteStudentId(studentsList[0].uid);
      }
    } catch (err) {
      setSentNotesError(
        formatUserError(err, 'Could not load sent notes right now.')
      );
    } finally {
      setIsLoadingSentNotes(false);
    }
  };

  useEffect(() => {
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tutorUid]);

  useEffect(() => {
    if (activeTab === 'materials' && materials.length === 0 && !isLoadingMaterials) {
      void loadMaterials();
    }
    if (activeTab === 'notes' && !isLoadingSentNotes) {
      void loadSentNotes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleViewPdf = async (mat: FirestoreMaterial) => {
    if (viewingPdf?.id === mat.id) {
      URL.revokeObjectURL(viewingPdf.url);
      setViewingPdf(null);
      return;
    }
    setLoadingPdfId(mat.id);
    setMaterialsError(null);
    try {
      const blobUrl = await fetchMaterialPdfBlobUrl(mat);
      if (viewingPdf?.url) {
        URL.revokeObjectURL(viewingPdf.url);
      }
      setViewingPdf({
        id: mat.id,
        fileName: mat.fileName,
        courseCode: mat.courseCode,
        url: blobUrl,
      });
    } catch (err) {
      setMaterialsError(formatUserError(err, 'Could not open PDF preview.'));
    } finally {
      setLoadingPdfId(null);
    }
  };

  const handleDownloadPdf = async (mat: FirestoreMaterial) => {
    setDownloadingMatId(mat.id);
    setMaterialsError(null);
    try {
      const blobUrl = await fetchMaterialPdfBlobUrl(mat);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = mat.fileName || `${mat.courseCode}-material.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    } catch (err) {
      setMaterialsError(formatUserError(err, 'Could not download PDF.'));
    } finally {
      setDownloadingMatId(null);
    }
  };

  const handleViewExtractedNotes = async (mat: FirestoreMaterial) => {
    setLoadingNotesMatId(mat.id);
    setMaterialsError(null);
    try {
      const pages = await fetchMaterialExtractedNotes(mat.id);
      setViewingExtractedNotes({ material: mat, pages });
    } catch (err) {
      setMaterialsError(formatUserError(err, 'Could not open study notes.'));
    } finally {
      setLoadingNotesMatId(null);
    }
  };

  const resetNoteForm = () => {
    setEditingNoteId(null);
    setNoteAudience('course');
    setNoteCourseCode(approvedCourses[0] || catalogCourses[0] || '');
    setNoteStudentId(handledStudents[0]?.uid || '');
    setNoteTitle('');
    setNoteBody('');
    setNoteExistingAttachments([]);
    setNoteRemovedAttachmentIds([]);
    setNoteQueuedFiles([]);
    setNoteFormError(null);
  };

  const startEditNote = (note: TutorNoteItem) => {
    setEditingNoteId(note.id);
    setNoteCourseCode(note.courseCode);
    setNoteAudience(note.audience);
    setNoteStudentId(note.studentId || handledStudents[0]?.uid || '');
    setNoteTitle(note.title);
    setNoteBody(note.body);
    setNoteExistingAttachments(note.attachments || []);
    setNoteRemovedAttachmentIds([]);
    setNoteQueuedFiles([]);
    setNoteFormError(null);
    setNoteBanner(null);
  };

  const handleAddNoteFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const totalCount = noteExistingAttachments.length + noteQueuedFiles.length;
    const nextFiles = [...noteQueuedFiles];
    for (const file of Array.from(fileList)) {
      if (totalCount + (nextFiles.length - noteQueuedFiles.length) >= MAX_ATTACHMENT_FILES) {
        setNoteFormError(`You can attach up to ${MAX_ATTACHMENT_FILES} files per post.`);
        break;
      }
      const err = validateAttachmentFile(file);
      if (err) {
        setNoteFormError(err);
        continue;
      }
      nextFiles.push(file);
    }
    setNoteQueuedFiles(nextFiles);
  };

  const handleSaveTutorNote = async (e: React.FormEvent) => {
    e.preventDefault();
    const course = noteCourseCode.trim();
    if (!course) {
      setNoteFormError('Please select a course.');
      return;
    }
    if (!noteTitle.trim()) {
      setNoteFormError('Please enter a title.');
      return;
    }
    if (!noteBody.trim()) {
      setNoteFormError('Please enter a message.');
      return;
    }
    const targetStudent =
      noteAudience === 'student'
        ? handledStudents.find((s) => s.uid === noteStudentId)
        : undefined;
    if (noteAudience === 'student' && !targetStudent) {
      setNoteFormError('Please pick a student you have tutored.');
      return;
    }

    setIsSubmittingNote(true);
    setNoteFormError(null);
    setNoteBanner(null);
    try {
      let uploadedNew: TutorNoteAttachment[] = [];
      if (noteQueuedFiles.length > 0) {
        uploadedNew = await uploadTutorNoteAttachments(noteQueuedFiles);
      }
      const mergedAttachments = [...noteExistingAttachments, ...uploadedNew].slice(
        0,
        MAX_ATTACHMENT_FILES
      );

      if (editingNoteId) {
        await updateTutorNote({
          noteId: editingNoteId,
          courseCode: course,
          audience: noteAudience,
          studentId: targetStudent?.uid,
          studentName: targetStudent?.name,
          title: noteTitle,
          body: noteBody,
          attachments: mergedAttachments,
          removedAttachmentIds: noteRemovedAttachmentIds,
        });
        setNoteBanner('Note updated successfully.');
      } else {
        await createTutorNote({
          tutorId: tutorUid,
          tutorName,
          courseCode: course,
          audience: noteAudience,
          studentId: targetStudent?.uid,
          studentName: targetStudent?.name,
          title: noteTitle,
          body: noteBody,
          attachments: mergedAttachments,
        });
        setNoteBanner(
          noteAudience === 'student'
            ? `Note sent to ${targetStudent?.name || 'student'}.`
            : `Note posted for ${formatCourse(course)}.`
        );
      }

      resetNoteForm();
      await loadSentNotes();
    } catch (err) {
      setNoteFormError(formatUserError(err, 'Could not save tutor note.'));
    } finally {
      setIsSubmittingNote(false);
    }
  };

  const handleDeleteTutorNote = async (note: TutorNoteItem) => {
    setDeletingNoteId(note.id);
    setSentNotesError(null);
    try {
      await deleteTutorNote(note.id, note.attachments);
      setConfirmDeleteNoteId(null);
      if (editingNoteId === note.id) {
        resetNoteForm();
      }
      setSentNotes((prev) => prev.filter((item) => item.id !== note.id));
    } catch (err) {
      setSentNotesError(formatUserError(err, 'Could not delete note.'));
    } finally {
      setDeletingNoteId(null);
    }
  };

  const handleViewNoteAttachment = async (noteId: string, att: TutorNoteAttachment) => {
    setNoteAttachmentBusyId(att.id);
    try {
      const url = await fetchTutorNoteAttachmentBlobUrl(noteId, att.id, false);
      if (previewNoteAttachment?.url) {
        URL.revokeObjectURL(previewNoteAttachment.url);
      }
      setPreviewNoteAttachment({ fileName: att.fileName, mimeType: att.mimeType, url });
    } catch (err) {
      setSentNotesError(formatUserError(err, 'Could not open attachment.'));
    } finally {
      setNoteAttachmentBusyId(null);
    }
  };

  const handleDownloadNoteAttachment = async (noteId: string, att: TutorNoteAttachment) => {
    setNoteAttachmentBusyId(att.id);
    try {
      const url = await fetchTutorNoteAttachmentBlobUrl(noteId, att.id, true);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.fileName || 'attachment';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      setSentNotesError(formatUserError(err, 'Could not download attachment.'));
    } finally {
      setNoteAttachmentBusyId(null);
    }
  };

  const handleTutorReply = async (note: TutorNoteItem) => {
    const draft = (tutorReplyDrafts[note.id] || '').trim();
    if (!draft || !note.studentId) return;
    setSendingReplyNoteId(note.id);
    try {
      const reply = await replyToTutorNote({
        noteId: note.id,
        studentUid: note.studentId,
        authorUid: tutorUid,
        authorName: tutorName,
        authorRole: 'tutor',
        text: draft,
      });
      setSentNotes((prev) =>
        prev.map((item) =>
          item.id === note.id ? { ...item, replies: [...(item.replies || []), reply] } : item
        )
      );
      setTutorReplyDrafts((prev) => ({ ...prev, [note.id]: '' }));
    } catch (err) {
      setSentNotesError(formatUserError(err, 'Could not send reply.'));
    } finally {
      setSendingReplyNoteId(null);
    }
  };

  const handleOpenEditCourses = () => {
    setDraftCourses(approvedCourses);
    setIsEditingCourses(true);
    setCourseBanner(null);
    setSlotActionError(null);
  };

  const toggleDraftCourse = (code: string) => {
    setDraftCourses((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const handleSaveCourses = async () => {
    setIsSavingCourses(true);
    setSlotActionError(null);
    try {
      const nextSubjects = await updateTutorCourses(tutorUid, draftCourses);
      const nextList = parseSubjectsList(nextSubjects);
      setApprovedCourses(nextList);
      setIsEditingCourses(false);
      setCourseBanner('Approved courses updated successfully.');
      onSubjectsUpdated?.(nextSubjects);
    } catch (err) {
      setSlotActionError(formatUserError(err, 'Failed to update approved courses.'));
    } finally {
      setIsSavingCourses(false);
    }
  };

  const startEditingFeedback = (session: TutorSession) => {
    setEditingFeedbackId(session.id);
    setDraftTutorNotes(session.tutorNotes || '');
    setDraftTutorFeedback(session.tutorFeedback || '');
    setFeedbackBanner(null);
    setSlotActionError(null);
  };

  const handleSaveFeedback = async (session: TutorSession) => {
    setIsSavingFeedback(true);
    setSlotActionError(null);
    try {
      await saveTutorSessionFeedback({
        bookingId: session.id,
        tutorUid,
        requestId: session.requestId || undefined,
        tutorNotes: draftTutorNotes,
        tutorFeedback: draftTutorFeedback,
      });
      setEditingFeedbackId(null);
      setFeedbackBanner(`Saved session notes & feedback for ${session.student || 'session'}.`);
      await loadSessions();
    } catch (err) {
      setSlotActionError(
        formatUserError(err, 'Failed to save session notes and feedback.')
      );
    } finally {
      setIsSavingFeedback(false);
    }
  };

  const handleCreateSlot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDate || !newStart || !newEnd) {
      setSlotActionError('Please enter date, start time, and end time.');
      return;
    }
    setIsCreatingSlot(true);
    setSlotActionError(null);
    try {
      await createTutorSlot({
        tutorUid,
        tutorId: tutorRefId,
        tutorName,
        campus: tutorCampus || 'Fujairah',
        date: newDate,
        start: newStart,
        end: newEnd,
      });
      setShowAddSlot(false);
      await loadSessions();
    } catch (err) {
      setSlotActionError(formatUserError(err, 'Failed to create slot.'));
    } finally {
      setIsCreatingSlot(false);
    }
  };

  const startEditingSlot = (slot: TutorSession) => {
    setEditingSlotId(slot.id);
    setEditDate(slot.date);
    setEditStart(slot.start);
    setEditEnd(slot.end);
    setEditStatus(slot.status === 'inactive' ? 'inactive' : 'open');
    setSlotActionError(null);
  };

  const handleSaveSlot = async (slotId: string) => {
    setIsSavingSlot(true);
    setSlotActionError(null);
    try {
      await updateTutorSlot({
        bookingId: slotId,
        date: editDate,
        start: editStart,
        end: editEnd,
        status: editStatus,
      });
      setEditingSlotId(null);
      await loadSessions();
    } catch (err) {
      setSlotActionError(formatUserError(err, 'Failed to update slot.'));
    } finally {
      setIsSavingSlot(false);
    }
  };

  const handleMarkComplete = async (bookingId: string) => {
    setCompletingId(bookingId);
    setSlotActionError(null);
    try {
      await markSessionComplete(bookingId, tutorUid);
      await loadSessions();
    } catch (err) {
      setSlotActionError(formatUserError(err, 'Failed to mark session complete.'));
    } finally {
      setCompletingId(null);
    }
  };

  const toggleWeeklyCell = (day: WeekdayCode, start: string, end: string) => {
    const key = `${day}|${start}|${end}`;
    setWeeklyScheduleBanner(null);
    setWeeklyScheduleError(null);
    setSelectedWeeklySlots((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    );
  };

  const toggleWholeDay = (day: WeekdayCode) => {
    setWeeklyScheduleBanner(null);
    setWeeklyScheduleError(null);
    const dayPrefix = `${day}|`;
    const hasAnyForDay = selectedWeeklySlots.some((s) => s.startsWith(dayPrefix));
    if (hasAnyForDay) {
      setSelectedWeeklySlots((prev) => prev.filter((s) => !s.startsWith(dayPrefix)));
    } else {
      const defaultsForDay = [
        `${day}|09:00|09:30`,
        `${day}|10:00|10:30`,
        `${day}|11:00|11:30`,
        `${day}|13:00|13:30`,
        `${day}|14:00|14:30`,
      ];
      setSelectedWeeklySlots((prev) => Array.from(new Set([...prev, ...defaultsForDay])));
    }
  };

  const toggleTimeAcrossActiveDays = (start: string, end: string) => {
    setWeeklyScheduleBanner(null);
    setWeeklyScheduleError(null);
    const activeDays = Array.from(
      new Set(
        selectedWeeklySlots
          .map((s) => s.split('|')[0] as WeekdayCode)
          .filter((d) => WEEKDAY_CODES.includes(d))
      )
    );
    const targetDays: WeekdayCode[] =
      activeDays.length > 0 ? activeDays : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'];
    const targetKeys = targetDays.map((d) => `${d}|${start}|${end}`);
    const allSelected = targetKeys.every((k) => selectedWeeklySlots.includes(k));
    if (allSelected) {
      setSelectedWeeklySlots((prev) => prev.filter((k) => !targetKeys.includes(k)));
    } else {
      setSelectedWeeklySlots((prev) => Array.from(new Set([...prev, ...targetKeys])));
    }
  };

  const handleSaveWeeklySchedule = async () => {
    setIsSavingWeeklySchedule(true);
    setWeeklyScheduleError(null);
    setWeeklyScheduleBanner(null);
    try {
      const result = await saveTutorWeeklySchedule({
        tutorUid,
        tutorId: tutorRefId,
        tutorName,
        campus: tutorCampus || 'Fujairah',
        scheduleSlots: selectedWeeklySlots,
        horizonDays: 14,
      });
      setSelectedWeeklySlots(result.schedule.scheduleSlots);
      setWeeklyScheduleBanner(
        result.schedule.scheduleSlots.length > 0
          ? `Weekly schedule saved (${result.schedule.scheduleSlots.length} recurring slots across ${result.schedule.days.length} day${result.schedule.days.length === 1 ? '' : 's'}). Student booking slots for the next 2 weeks are now updated.`
          : 'Weekly schedule cleared. Future unbooked slots were removed while keeping booked sessions.'
      );
      await loadSessions();
    } catch (err) {
      setWeeklyScheduleError(
        formatUserError(err, 'Could not save your weekly schedule. Please try again.')
      );
    } finally {
      setIsSavingWeeklySchedule(false);
    }
  };

  const openReschedulePanel = (session: TutorSession) => {
    setRespondingRescheduleId(session.id);
    setRescheduleNote('');
    setSlotActionError(null);

    const openOwnSlots = sessions.filter((s) => s.status === 'open');
    const matchedPreferred = session.reschedulePreferredSlotId
      ? openOwnSlots.find((s) => s.id === session.reschedulePreferredSlotId)
      : undefined;

    if (matchedPreferred) {
      setRescheduleTargetSlotId(matchedPreferred.id);
      setRescheduleDate(matchedPreferred.date);
      setRescheduleStart(matchedPreferred.start);
      setRescheduleEnd(matchedPreferred.end);
    } else {
      setRescheduleTargetSlotId('');
      setRescheduleDate(session.date);
      setRescheduleStart(session.start);
      setRescheduleEnd(session.end);
    }
  };

  const handleRespondReschedule = async (
    session: TutorSession,
    action: 'approve' | 'decline'
  ) => {
    setIsSubmittingRescheduleResponse(true);
    setSlotActionError(null);
    try {
      await respondToRescheduleRequest({
        bookingId: session.id,
        tutorUid,
        action,
        newDate: action === 'approve' ? rescheduleDate : undefined,
        newStart: action === 'approve' ? rescheduleStart : undefined,
        newEnd: action === 'approve' ? rescheduleEnd : undefined,
        targetOpenSlotId:
          action === 'approve' && rescheduleTargetSlotId ? rescheduleTargetSlotId : undefined,
        responseNote: rescheduleNote,
      });
      setRespondingRescheduleId(null);
      setFeedbackBanner(
        action === 'approve'
          ? `Rescheduled ${session.student || 'student'} to ${rescheduleDate} (${rescheduleStart} – ${rescheduleEnd}).`
          : `Declined reschedule request from ${session.student || 'student'}.`
      );
      await loadSessions();
    } catch (err) {
      setSlotActionError(
        formatUserError(err, 'Could not update this reschedule request. Please try again.')
      );
    } finally {
      setIsSubmittingRescheduleResponse(false);
    }
  };

  const upcomingSessions = sessions.filter((s) => s.status === 'booked');
  const pastSessions = sessions
    .filter((s) => s.status === 'completed' || s.status === 'cancelled')
    .slice()
    .sort((a, b) => `${b.date} ${b.start}`.localeCompare(`${a.date} ${a.start}`));
  const availabilitySlots = sessions.filter(
    (s) => s.status === 'open' || s.status === 'inactive'
  );
  const openSlotsForSwap = sessions.filter((s) => s.status === 'open');
  const selectedDaysCount = Array.from(
    new Set(selectedWeeklySlots.map((s) => s.split('|')[0]).filter(Boolean))
  ).length;

  const renderSessionCard = (session: TutorSession) => {
    const isEditingNotes = editingFeedbackId === session.id;
    return (
      <article
        key={session.id}
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium text-[#0B2240]">
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <Calendar className="w-4 h-4 text-slate-500" aria-hidden="true" />
              <span>{session.date || '—'}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <Clock className="w-4 h-4 text-slate-500" aria-hidden="true" />
              <span>
                {session.start || '—'}
                {session.end ? ` – ${session.end}` : ''}
              </span>
            </span>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-md border text-xs font-semibold capitalize ${getSlotStatusBadge(
                session.status
              )}`}
            >
              {session.status}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              <span className="font-mono font-semibold text-[#0B2240]">
                {session.course ? formatCourse(session.course) : 'ASC'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{session.campus}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                isEditingNotes ? setEditingFeedbackId(null) : startEditingFeedback(session)
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                {isEditingNotes
                  ? 'Close notes'
                  : session.tutorNotes || session.tutorFeedback
                    ? 'Edit notes & feedback'
                    : 'Add notes & feedback'}
              </span>
            </button>
            {session.status === 'booked' && (
              <button
                type="button"
                disabled={completingId === session.id}
                onClick={() => void handleMarkComplete(session.id)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 min-h-[36px] text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {completingId === session.id ? 'Updating...' : 'Mark complete'}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-xs font-medium text-slate-500">Student</span>
            <p className="mt-0.5 font-medium text-slate-900">{session.student || '—'}</p>
          </div>
          <div>
            <span className="text-xs font-medium text-slate-500">Topic</span>
            <p className="mt-0.5 font-medium text-slate-900">{session.topic || '—'}</p>
          </div>
        </div>

        {/* Student Reschedule Request Notice & Response Panel */}
        {session.rescheduleStatus === 'requested' && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
              <div className="space-y-1">
                <span className="inline-flex items-center px-2 py-0.5 rounded border border-amber-300 bg-amber-100 text-amber-900 text-[11px] font-semibold">
                  Reschedule requested
                </span>
                <p className="text-sm text-amber-950 font-medium">
                  Reason: <span className="font-normal">{session.rescheduleReason || 'Not specified'}</span>
                </p>
                {session.reschedulePreferredWhen && (
                  <p className="text-xs text-amber-900">
                    Preferred time: <span className="font-mono font-semibold">{session.reschedulePreferredWhen}</span>
                  </p>
                )}
              </div>
              {session.status === 'booked' && respondingRescheduleId !== session.id && (
                <button
                  type="button"
                  onClick={() => openReschedulePanel(session)}
                  className="px-3.5 py-2 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] shrink-0 cursor-pointer"
                >
                  Respond to request
                </button>
              )}
            </div>

            {respondingRescheduleId === session.id && (
              <div className="pt-3 border-t border-amber-200 space-y-3">
                {openSlotsForSwap.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-amber-950 mb-1">
                      Move to one of your open slots (optional)
                    </label>
                    <select
                      value={rescheduleTargetSlotId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setRescheduleTargetSlotId(val);
                        const chosen = openSlotsForSwap.find((s) => s.id === val);
                        if (chosen) {
                          setRescheduleDate(chosen.date);
                          setRescheduleStart(chosen.start);
                          setRescheduleEnd(chosen.end);
                        }
                      }}
                      className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-white border border-amber-300 rounded-lg"
                    >
                      <option value="">Custom date &amp; time below...</option>
                      {openSlotsForSwap.slice(0, 30).map((slot) => (
                        <option key={slot.id} value={slot.id}>
                          {slot.date} · {slot.start} – {slot.end}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-amber-950 mb-1">New date</label>
                    <input
                      type="date"
                      value={rescheduleDate}
                      onChange={(e) => {
                        setRescheduleDate(e.target.value);
                        setRescheduleTargetSlotId('');
                      }}
                      className="w-full min-h-[36px] px-2.5 py-1.5 text-xs bg-white border border-amber-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-amber-950 mb-1">Start</label>
                    <input
                      type="time"
                      value={rescheduleStart}
                      onChange={(e) => {
                        setRescheduleStart(e.target.value);
                        setRescheduleTargetSlotId('');
                      }}
                      className="w-full min-h-[36px] px-2.5 py-1.5 text-xs bg-white border border-amber-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-amber-950 mb-1">End</label>
                    <input
                      type="time"
                      value={rescheduleEnd}
                      onChange={(e) => {
                        setRescheduleEnd(e.target.value);
                        setRescheduleTargetSlotId('');
                      }}
                      className="w-full min-h-[36px] px-2.5 py-1.5 text-xs bg-white border border-amber-300 rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-amber-950 mb-1">
                    Note to student (optional)
                  </label>
                  <input
                    type="text"
                    value={rescheduleNote}
                    onChange={(e) => setRescheduleNote(e.target.value)}
                    placeholder="e.g., Moved to Tuesday morning as requested."
                    className="w-full min-h-[36px] px-3 py-1.5 text-xs bg-white border border-amber-300 rounded-lg"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isSubmittingRescheduleResponse}
                    onClick={() => void handleRespondReschedule(session, 'approve')}
                    className="px-3.5 py-2 min-h-[36px] text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                  >
                    {isSubmittingRescheduleResponse ? 'Saving...' : 'Approve & reschedule'}
                  </button>
                  <button
                    type="button"
                    disabled={isSubmittingRescheduleResponse}
                    onClick={() => void handleRespondReschedule(session, 'decline')}
                    className="px-3.5 py-2 min-h-[36px] text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                  >
                    Decline request
                  </button>
                  <button
                    type="button"
                    disabled={isSubmittingRescheduleResponse}
                    onClick={() => setRespondingRescheduleId(null)}
                    className="px-3 py-2 min-h-[36px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {session.rescheduleStatus === 'approved' && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-xs text-emerald-900">
            <span className="font-semibold">Rescheduled</span>
            {session.rescheduleResponseNote ? ` — ${session.rescheduleResponseNote}` : ' as requested by student.'}
          </div>
        )}

        {session.problem && (
          <div>
            <span className="text-xs font-medium text-slate-500">
              Student&apos;s problem
            </span>
            <p
              dir="auto"
              className="mt-1 text-sm text-slate-800 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-3.5"
            >
              {session.problem}
            </p>
          </div>
        )}

        {session.attachments && session.attachments.length > 0 && (
          <AttachmentList attachments={session.attachments} />
        )}

        {session.brief && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <span className="text-xs font-medium text-slate-500">
                Tutor session brief
              </span>
              <span className="text-xs font-medium text-slate-500">
                AI-generated – please check
              </span>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
              <FormattedText text={session.brief} />
            </div>
          </div>
        )}

        {(session.tutorNotes || session.tutorFeedback) && !isEditingNotes && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
            {session.tutorNotes && (
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3.5 space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Tutor Session Notes (Internal)
                </span>
                <p dir="auto" className="text-xs text-slate-800 leading-relaxed whitespace-pre-wrap">
                  {session.tutorNotes}
                </p>
              </div>
            )}
            {session.tutorFeedback && (
              <div className="rounded-lg bg-emerald-50/70 border border-emerald-200 p-3.5 space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-800">
                  Student Feedback (Shared)
                </span>
                <p dir="auto" className="text-xs text-emerald-950 leading-relaxed whitespace-pre-wrap">
                  {session.tutorFeedback}
                </p>
              </div>
            )}
          </div>
        )}

        {isEditingNotes && (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-[#0B2240] mb-1">
                Tutor Session Notes &amp; Follow-up Comments (Internal)
              </label>
              <textarea
                rows={3}
                dir="auto"
                value={draftTutorNotes}
                onChange={(e) => setDraftTutorNotes(e.target.value)}
                placeholder="Record topics covered, student progress, or follow-up observations..."
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#0B2240] mb-1">
                Feedback for Student (Visible on student&apos;s request card)
              </label>
              <textarea
                rows={3}
                dir="auto"
                value={draftTutorFeedback}
                onChange={(e) => setDraftTutorFeedback(e.target.value)}
                placeholder="Write encouraging feedback and next practice steps for the student..."
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isSavingFeedback}
                onClick={() => void handleSaveFeedback(session)}
                className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isSavingFeedback ? 'Saving...' : 'Save notes & feedback'}</span>
              </button>
              <button
                type="button"
                disabled={isSavingFeedback}
                onClick={() => setEditingFeedbackId(null)}
                className="px-4 py-2 min-h-[38px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="space-y-8">
      {/* Header & Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-500">
            HCT Academic Success Center · Tutor Portal
          </p>
          <h1 className="font-display text-2xl font-bold text-[#0B2240]">
            My sessions, courses &amp; slots
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 pt-0.5">
            <span className="font-medium text-slate-800">{tutorName}</span>
            {tutorCampus && (
              <span className="inline-flex items-center gap-1">
                <Building2 className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                <span>{tutorCampus}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1 font-mono">
              <BookOpen className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span>
                {approvedCourses.length > 0
                  ? approvedCourses.map(formatCourse).join(', ')
                  : 'No courses selected'}
              </span>
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            disabled={
              activeTab === 'sessions'
                ? isLoadingSessions
                : activeTab === 'materials'
                  ? isLoadingMaterials
                  : isLoadingSentNotes
            }
            onClick={() =>
              void (activeTab === 'sessions'
                ? loadSessions()
                : activeTab === 'materials'
                  ? loadMaterials()
                  : loadSentNotes())
            }
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RefreshCw
              className={`w-4 h-4 ${
                (activeTab === 'sessions'
                  ? isLoadingSessions
                  : activeTab === 'materials'
                    ? isLoadingMaterials
                    : isLoadingSentNotes)
                  ? 'animate-spin'
                  : ''
              }`}
              aria-hidden="true"
            />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={onOpenHumanSupport}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
            <span>Talk to a human</span>
          </button>
        </div>
      </div>

      {/* Tutor Workspace Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl p-1.5 inline-flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('sessions')}
          className={`inline-flex items-center gap-2 px-4 py-2 min-h-[40px] rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
            activeTab === 'sessions'
              ? 'bg-[#0B2240] text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Calendar className="w-4 h-4" aria-hidden="true" />
          <span>Sessions &amp; Availability</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('notes')}
          className={`inline-flex items-center gap-2 px-4 py-2 min-h-[40px] rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
            activeTab === 'notes'
              ? 'bg-[#0B2240] text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Send className="w-4 h-4" aria-hidden="true" />
          <span>Send to students</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('materials')}
          className={`inline-flex items-center gap-2 px-4 py-2 min-h-[40px] rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
            activeTab === 'materials'
              ? 'bg-[#0B2240] text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <BookOpen className="w-4 h-4" aria-hidden="true" />
          <span>Course Materials</span>
        </button>
      </div>

      {activeTab === 'notes' ? (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                  {editingNoteId ? 'Edit note for students' : 'Send to students'}
                </h2>
                <p className="text-xs text-slate-500">
                  Share practice advice, session follow-ups, or study files with one student or all students in a course.
                </p>
              </div>
              {editingNoteId && (
                <button
                  type="button"
                  onClick={resetNoteForm}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel edit
                </button>
              )}
            </div>

            {noteBanner && (
              <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>{noteBanner}</span>
              </div>
            )}

            {noteFormError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{noteFormError}</span>
              </div>
            )}

            <form onSubmit={handleSaveTutorNote} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="tutor-note-course"
                    className="block text-xs font-semibold text-[#0B2240] mb-1.5"
                  >
                    Course
                  </label>
                  <select
                    id="tutor-note-course"
                    value={noteCourseCode}
                    onChange={(e) => setNoteCourseCode(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900"
                  >
                    {Array.from(new Set([...approvedCourses, ...catalogCourses])).map((code) => (
                      <option key={code} value={code}>
                        {formatCourse(code)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <span className="block text-xs font-semibold text-[#0B2240] mb-1.5">
                    Audience
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setNoteAudience('course')}
                      className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg border text-xs font-medium cursor-pointer ${
                        noteAudience === 'course'
                          ? 'bg-[#0B2240] text-white border-[#0B2240]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <Users className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>All in course</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNoteAudience('student')}
                      className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg border text-xs font-medium cursor-pointer ${
                        noteAudience === 'student'
                          ? 'bg-[#0B2240] text-white border-[#0B2240]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>One student</span>
                    </button>
                  </div>
                </div>
              </div>

              {noteAudience === 'student' && (
                <div>
                  <label
                    htmlFor="tutor-note-student"
                    className="block text-xs font-semibold text-[#0B2240] mb-1.5"
                  >
                    Student
                  </label>
                  {handledStudents.length === 0 ? (
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      No students from your tutoring bookings yet. Choose &ldquo;All in course&rdquo; to post a course-wide note.
                    </p>
                  ) : (
                    <select
                      id="tutor-note-student"
                      value={noteStudentId}
                      onChange={(e) => {
                        const nextUid = e.target.value;
                        setNoteStudentId(nextUid);
                        const match = handledStudents.find((s) => s.uid === nextUid);
                        if (match?.courses[0]) {
                          setNoteCourseCode(match.courses[0]);
                        }
                      }}
                      className="w-full min-h-[40px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900"
                    >
                      {handledStudents.map((stu) => (
                        <option key={stu.uid} value={stu.uid}>
                          {stu.name}
                          {stu.courses.length > 0 ? ` (${stu.courses.join(', ')})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              <div>
                <label
                  htmlFor="tutor-note-title"
                  className="block text-xs font-semibold text-[#0B2240] mb-1.5"
                >
                  Title
                </label>
                <input
                  id="tutor-note-title"
                  type="text"
                  dir="auto"
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder="e.g. Quick review sheet before Week 4 quiz"
                  className="w-full min-h-[40px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="tutor-note-body"
                  className="block text-xs font-semibold text-[#0B2240] mb-1.5"
                >
                  Message
                </label>
                <textarea
                  id="tutor-note-body"
                  rows={4}
                  dir="auto"
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  placeholder="Write clear explanations, reminders, or practice steps..."
                  className="w-full px-3 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900"
                />
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#0B2240]">
                    Attachments (optional)
                  </span>
                  <span className="text-xs text-slate-500">
                    PDF, PNG, or JPG · Max {MAX_ATTACHMENT_FILES} files, 10 MB each
                  </span>
                </div>

                <label className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[38px] text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer">
                  <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Attach files</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,application/pdf,.png,.jpg,.jpeg,.pdf"
                    multiple
                    disabled={
                      isSubmittingNote ||
                      noteExistingAttachments.length + noteQueuedFiles.length >= MAX_ATTACHMENT_FILES
                    }
                    onChange={(e) => {
                      handleAddNoteFiles(e.target.files);
                      e.target.value = '';
                    }}
                    className="sr-only"
                  />
                </label>

                {(noteExistingAttachments.length > 0 || noteQueuedFiles.length > 0) && (
                  <ul className="space-y-1.5 pt-1">
                    {noteExistingAttachments.map((att) => (
                      <li
                        key={att.id}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                      >
                        <span className="truncate font-medium text-slate-800">{att.fileName}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setNoteExistingAttachments((prev) =>
                              prev.filter((item) => item.id !== att.id)
                            );
                            setNoteRemovedAttachmentIds((prev) => [...prev, att.id]);
                          }}
                          className="text-red-700 hover:underline shrink-0 cursor-pointer"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                    {noteQueuedFiles.map((file, idx) => (
                      <li
                        key={`${file.name}-${idx}`}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-blue-50/50 border border-blue-200 text-xs"
                      >
                        <span className="truncate font-medium text-slate-800">
                          {file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setNoteQueuedFiles((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="text-red-700 hover:underline shrink-0 cursor-pointer"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={
                    isSubmittingNote || (noteAudience === 'student' && handledStudents.length === 0)
                  }
                  className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                >
                  <Send className="w-4 h-4" aria-hidden="true" />
                  <span>
                    {isSubmittingNote
                      ? 'Sending...'
                      : editingNoteId
                        ? 'Save changes'
                        : 'Send note'}
                  </span>
                </button>
              </div>
            </form>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Sent notes ({sentNotes.length})
              </h2>
            </div>

            {sentNotesError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800"
              >
                {sentNotesError}
              </div>
            )}

            {isLoadingSentNotes ? (
              <div className="bg-white border border-slate-200 rounded-xl p-6">
                <Spinner label="Loading sent notes..." />
              </div>
            ) : sentNotes.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                You have not sent any notes to students yet.
              </div>
            ) : (
              <div className="space-y-3">
                {sentNotes.map((note) => (
                  <article
                    key={note.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-[#0B2240]">
                            {formatCourse(note.courseCode)}
                          </span>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium">
                            {note.audience === 'student' ? (
                              <>
                                <UserCheck className="w-3 h-3" aria-hidden="true" />
                                <span>To: {note.studentName || 'Student'}</span>
                              </>
                            ) : (
                              <>
                                <Users className="w-3 h-3" aria-hidden="true" />
                                <span>All enrolled students</span>
                              </>
                            )}
                          </span>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold tabular-nums">
                            <Eye className="w-3 h-3" aria-hidden="true" />
                            <span>{note.readCount ?? 0} read</span>
                          </span>
                        </div>
                        <h3 className="text-base font-semibold text-slate-900">{note.title}</h3>
                        <p className="text-xs text-slate-500">
                          {new Date(note.createdAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditNote(note)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[34px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Edit</span>
                        </button>
                        {confirmDeleteNoteId === note.id ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={deletingNoteId === note.id}
                              onClick={() => void handleDeleteTutorNote(note)}
                              className="px-2.5 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 cursor-pointer disabled:opacity-50"
                            >
                              {deletingNoteId === note.id ? 'Deleting...' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteNoteId(null)}
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteNoteId(note.id)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[34px] text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <p dir="auto" className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                      {note.body}
                    </p>

                    {(note.attachments?.length || 0) > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {note.attachments!.map((att) => (
                          <div
                            key={att.id}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs"
                          >
                            {att.mimeType === 'application/pdf' ? (
                              <FileText className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
                            ) : (
                              <ImageIcon className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                            )}
                            <span className="font-medium text-slate-800 max-w-[180px] truncate">
                              {att.fileName}
                            </span>
                            <button
                              type="button"
                              disabled={noteAttachmentBusyId === att.id}
                              onClick={() => void handleViewNoteAttachment(note.id, att)}
                              className="text-[#0B2240] font-semibold hover:underline cursor-pointer"
                            >
                              View
                            </button>
                            <button
                              type="button"
                              disabled={noteAttachmentBusyId === att.id}
                              onClick={() => void handleDownloadNoteAttachment(note.id, att)}
                              className="text-slate-600 hover:underline cursor-pointer"
                            >
                              Download
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {note.audience === 'student' && (
                      <div className="pt-3 border-t border-slate-100 space-y-2.5">
                        <p className="text-xs font-semibold text-slate-600">
                          Student Replies ({note.replies?.length || 0})
                        </p>
                        {(note.replies?.length || 0) > 0 && (
                          <div className="space-y-2">
                            {note.replies!.map((rep) => (
                              <div
                                key={rep.id}
                                className={`p-2.5 rounded-lg text-xs border ${
                                  rep.authorRole === 'tutor'
                                    ? 'bg-blue-50/50 border-blue-200'
                                    : 'bg-slate-50 border-slate-200'
                                }`}
                              >
                                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-0.5">
                                  <span className="font-semibold text-slate-800">
                                    {rep.authorName}
                                  </span>
                                  <span>
                                    {new Date(rep.createdAt).toLocaleDateString(undefined, {
                                      month: 'short',
                                      day: 'numeric',
                                    })}
                                  </span>
                                </div>
                                <p dir="auto" className="text-slate-800 whitespace-pre-wrap">
                                  {rep.text}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <input
                            type="text"
                            dir="auto"
                            value={tutorReplyDrafts[note.id] || ''}
                            onChange={(e) =>
                              setTutorReplyDrafts((prev) => ({
                                ...prev,
                                [note.id]: e.target.value,
                              }))
                            }
                            placeholder={`Reply to ${note.studentName || 'student'}...`}
                            className="flex-1 min-h-[36px] px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                          />
                          <button
                            type="button"
                            disabled={
                              sendingReplyNoteId === note.id ||
                              !(tutorReplyDrafts[note.id] || '').trim()
                            }
                            onClick={() => void handleTutorReply(note)}
                            className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer disabled:opacity-50"
                          >
                            {sendingReplyNoteId === note.id ? 'Sending...' : 'Reply'}
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : activeTab === 'materials' ? (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Course Materials
              </h2>
              <p className="text-xs text-slate-500">
                View and download official course slides, notes, and handouts for your sessions.
              </p>
            </div>
          </div>

          {viewingPdf && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs">
                  <FileText className="w-4 h-4 text-[#0B2240]" aria-hidden="true" />
                  <span className="font-semibold text-[#0B2240]">{viewingPdf.fileName}</span>
                  <span className="text-slate-500">({formatCourse(viewingPdf.courseCode)})</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    URL.revokeObjectURL(viewingPdf.url);
                    setViewingPdf(null);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Close preview</span>
                </button>
              </div>
              <iframe
                src={viewingPdf.url}
                title={`PDF preview of ${viewingPdf.fileName}`}
                className="w-full h-[520px] rounded-lg border border-slate-200 bg-slate-50"
              />
            </div>
          )}

          {!isLoadingMaterials && !materialsError && (
            <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search
                  className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={matSearch}
                  onChange={(e) => setMatSearch(e.target.value)}
                  placeholder="Search materials by file name, topic, or course..."
                  aria-label="Search course materials"
                  className="w-full min-h-[40px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
                />
              </div>
              <select
                value={matCourseFilter}
                onChange={(e) => setMatCourseFilter(e.target.value)}
                aria-label="Filter materials by course"
                className="sm:w-72 min-h-[40px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
              >
                <option value="all">All courses</option>
                {Array.from(
                  new Set([...catalogCourses, ...materials.map((m) => m.courseCode)])
                ).map((code) => (
                  <option key={code} value={code}>
                    {formatCourse(code)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {isLoadingMaterials && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading course materials..." />
            </div>
          )}

          {materialsError && !isLoadingMaterials && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
              <span>{materialsError}</span>
              <button
                type="button"
                onClick={() => void loadMaterials()}
                className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoadingMaterials && !materialsError && (() => {
            const needle = matSearch.trim().toLowerCase();
            const allCodes = Array.from(
              new Set([...catalogCourses, ...materials.map((m) => m.courseCode)])
            );
            const targetCodes =
              matCourseFilter === 'all' ? allCodes : allCodes.filter((c) => c === matCourseFilter);

            const sections = targetCodes
              .map((code) => {
                const courseTitle = formatCourse(code);
                const allForCourse = materials.filter((m) => m.courseCode === code);
                const filtered = needle
                  ? allForCourse.filter((m) => {
                      const topicLabel = (
                        m.topicTitle || deriveTopicTitleFromFileName(m.fileName)
                      ).toLowerCase();
                      return (
                        m.fileName.toLowerCase().includes(needle) ||
                        topicLabel.includes(needle) ||
                        code.toLowerCase().includes(needle) ||
                        courseTitle.toLowerCase().includes(needle)
                      );
                    })
                  : allForCourse;

                const groupsMap = new Map<string, { label: string; items: FirestoreMaterial[] }>();
                filtered.forEach((mat) => {
                  const label =
                    (mat.topicTitle || deriveTopicTitleFromFileName(mat.fileName)).trim() ||
                    'General';
                  const key = label.toLowerCase();
                  const existing = groupsMap.get(key);
                  if (existing) {
                    existing.items.push(mat);
                  } else {
                    groupsMap.set(key, { label, items: [mat] });
                  }
                });

                const topicGroups = Array.from(groupsMap.values())
                  .sort((a, b) => compareTopicTitles(a.label, b.label))
                  .map((group) => ({
                    ...group,
                    items: group.items.slice().sort((a, b) =>
                      a.fileName.localeCompare(b.fileName, undefined, {
                        numeric: true,
                        sensitivity: 'base',
                      })
                    ),
                  }));

                return {
                  code,
                  courseTitle,
                  filteredCount: filtered.length,
                  topicGroups,
                };
              })
              .filter((s) => (needle ? s.filteredCount > 0 : true));

            if (sections.length === 0) {
              return (
                <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                  No materials match your search.
                </div>
              );
            }

            return (
              <div className="space-y-3">
                {sections.map((section) => {
                  const isExpanded = Boolean(expandedCourses[section.code]);
                  return (
                    <section
                      key={section.code}
                      aria-label={section.courseTitle}
                      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
                    >
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() =>
                          setExpandedCourses((prev) => ({
                            ...prev,
                            [section.code]: !prev[section.code],
                          }))
                        }
                        className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-[#0B2240] shrink-0" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                          )}
                          <h3 className="font-display text-sm sm:text-base font-semibold text-[#0B2240] truncate">
                            {section.courseTitle}
                          </h3>
                        </div>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0">
                          {section.filteredCount} {section.filteredCount === 1 ? 'file' : 'files'}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="border-t border-slate-200">
                          {section.filteredCount === 0 ? (
                            <p className="px-5 py-6 text-sm text-slate-500 text-center">
                              No materials yet
                            </p>
                          ) : (
                            <div className="divide-y divide-slate-200">
                              {section.topicGroups.map((group) => (
                                <div key={group.label}>
                                  <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100">
                                    <h4 className="text-xs font-semibold text-[#0B2240]">
                                      {group.label}
                                    </h4>
                                  </div>
                                  <div className="divide-y divide-slate-100 bg-white">
                                    {group.items.map((mat) => {
                                      const isViewingThis = viewingPdf?.id === mat.id;
                                      const hasPdfBinary =
                                        mat.storageMode === 'firestore_parts' &&
                                        (mat.partCount ?? 0) > 0;
                                      const topicLabel =
                                        mat.topicTitle || deriveTopicTitleFromFileName(mat.fileName);
                                      return (
                                        <div
                                          key={mat.id}
                                          className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                                        >
                                          <div className="min-w-0 space-y-0.5">
                                            <div className="flex items-center gap-2">
                                              <FileText className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                                              <span className="text-sm font-semibold text-slate-900 truncate">
                                                {mat.fileName}
                                              </span>
                                            </div>
                                            <div className="text-xs text-slate-500 pl-6 flex flex-wrap gap-x-3">
                                              <span className="font-medium text-slate-700">{topicLabel}</span>
                                              {mat.uploadedAt && (
                                                <span>
                                                  {new Date(mat.uploadedAt).toLocaleDateString(undefined, {
                                                    month: 'short',
                                                    day: 'numeric',
                                                    year: 'numeric',
                                                  })}
                                                </span>
                                              )}
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-2 pl-6 sm:pl-0 shrink-0">
                                            {hasPdfBinary ? (
                                              <>
                                                <button
                                                  type="button"
                                                  disabled={loadingPdfId === mat.id}
                                                  onClick={() => void handleViewPdf(mat)}
                                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium rounded-lg border cursor-pointer disabled:opacity-50 ${
                                                    isViewingThis
                                                      ? 'bg-[#0B2240] text-white border-[#0B2240]'
                                                      : 'bg-white text-[#0B2240] border-slate-300 hover:bg-slate-50'
                                                  }`}
                                                >
                                                  <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                                                  <span>
                                                    {loadingPdfId === mat.id
                                                      ? 'Loading...'
                                                      : isViewingThis
                                                        ? 'Hide PDF'
                                                        : 'View'}
                                                  </span>
                                                </button>
                                                <button
                                                  type="button"
                                                  disabled={downloadingMatId === mat.id}
                                                  onClick={() => void handleDownloadPdf(mat)}
                                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer disabled:opacity-50"
                                                >
                                                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                                                  <span>
                                                    {downloadingMatId === mat.id ? 'Preparing...' : 'Download'}
                                                  </span>
                                                </button>
                                              </>
                                            ) : (
                                              <button
                                                type="button"
                                                disabled={loadingNotesMatId === mat.id}
                                                onClick={() => void handleViewExtractedNotes(mat)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer disabled:opacity-50"
                                              >
                                                <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                                                <span>
                                                  {loadingNotesMatId === mat.id ? 'Opening...' : 'View notes'}
                                                </span>
                                              </button>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : (
        <>

      {/* Manage Approved Courses */}
      <section aria-label="My approved courses" className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-[#0B2240]">
              My Approved Courses
            </h2>
            <p className="text-xs text-slate-500">
              Select the HCT courses you actively tutor in the Academic Success Center
            </p>
          </div>
          {!isEditingCourses && (
            <button
              type="button"
              onClick={handleOpenEditCourses}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Manage courses</span>
            </button>
          )}
        </div>

        {courseBanner && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
            <span>{courseBanner}</span>
          </div>
        )}

        {isEditingCourses ? (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {Array.from(new Set([...catalogCourses, ...approvedCourses])).map((code) => {
                const checked = draftCourses.includes(code);
                return (
                  <label
                    key={code}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono font-semibold cursor-pointer ${
                      checked
                        ? 'border-[#0B2240] bg-[#0B2240]/5 text-[#0B2240]'
                        : 'border-slate-200 text-slate-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDraftCourse(code)}
                      className="h-4 w-4 accent-[#0B2240]"
                    />
                    <span>{formatCourse(code)}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isSavingCourses}
                onClick={() => void handleSaveCourses()}
                className="px-4 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
              >
                {isSavingCourses ? 'Saving...' : 'Save courses'}
              </button>
              <button
                type="button"
                disabled={isSavingCourses}
                onClick={() => setIsEditingCourses(false)}
                className="px-4 py-2 min-h-[38px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {approvedCourses.length > 0 ? (
              approvedCourses.map((code) => (
                <span
                  key={code}
                  className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-[#0B2240] bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg"
                >
                  <BookOpen className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  <span>{formatCourse(code)}</span>
                </span>
              ))
            ) : (
              <p className="text-xs text-slate-500">
                No courses assigned yet. Click &ldquo;Manage courses&rdquo; to select your courses.
              </p>
            )}
          </div>
        )}
      </section>

      {feedbackBanner && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
          <span>{feedbackBanner}</span>
        </div>
      )}

      {slotActionError && (
        <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{slotActionError}</span>
        </div>
      )}

      {isLoadingSessions && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <Spinner label="Loading sessions and availability slots..." />
        </div>
      )}

      {sessionsError && !isLoadingSessions && (
        <div
          role="alert"
          className="p-5 rounded-xl bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-sm text-red-800">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{sessionsError}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadSessions()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {!isLoadingSessions && !sessionsError && (
        <>
          {/* Upcoming Sessions */}
          <section aria-label="Upcoming sessions" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Upcoming sessions ({upcomingSessions.length})
              </h2>
            </div>

            {upcomingSessions.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
                <p className="font-display text-base font-semibold text-[#0B2240]">
                  No sessions booked yet.
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  When a student books one of your open slots, their problem and AI brief will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-4">{upcomingSessions.map(renderSessionCard)}</div>
            )}
          </section>

          {/* Past / Completed Sessions */}
          <section aria-label="Past sessions" className="space-y-4">
            <h2 className="font-display text-lg font-semibold text-[#0B2240] flex items-center gap-2">
              <History className="w-5 h-5 text-slate-500" aria-hidden="true" />
              <span>Past &amp; completed sessions ({pastSessions.length})</span>
            </h2>

            {pastSessions.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-500">
                No completed or past tutoring sessions yet.
              </div>
            ) : (
              <div className="space-y-4">{pastSessions.map(renderSessionCard)}</div>
            )}
          </section>

          {/* Weekly Availability Schedule */}
          <section aria-label="Weekly availability schedule" className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                  Weekly availability schedule
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Choose the days and 30-minute time slots you are regularly available. Saving automatically updates your open booking slots for the next 2 weeks.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setWeeklyScheduleBanner(null);
                    setWeeklyScheduleError(null);
                    setSelectedWeeklySlots(TUTOR_T1_SAMPLE_SCHEDULE.scheduleSlots);
                  }}
                  className="px-3 py-2 min-h-[38px] text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
                >
                  Sun–Thu preset
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWeeklyScheduleBanner(null);
                    setWeeklyScheduleError(null);
                    setSelectedWeeklySlots([]);
                  }}
                  className="px-3 py-2 min-h-[38px] text-xs font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Clear all
                </button>
              </div>
            </div>

            {weeklyScheduleBanner && (
              <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>{weeklyScheduleBanner}</span>
              </div>
            )}

            {weeklyScheduleError && (
              <div role="alert" className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{weeklyScheduleError}</span>
              </div>
            )}

            {/* Quick Day Toggles */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-600">
                Select available days (click a day to toggle its default hours, or fine-tune slots below):
              </p>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_CODES.map((day) => {
                  const count = selectedWeeklySlots.filter((s) => s.startsWith(`${day}|`)).length;
                  const active = count > 0;
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleWholeDay(day)}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                        active
                          ? 'bg-[#0B2240] text-white border-[#0B2240]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <span>{WEEKDAY_LABELS[day]}</span>
                      {count > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-white/20 text-[10px] font-semibold tabular-nums">
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Days x Time Slots Grid */}
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="py-2.5 px-3 text-left font-semibold text-slate-600 whitespace-nowrap">
                      Time slot
                    </th>
                    {WEEKDAY_CODES.map((day) => (
                      <th
                        key={day}
                        className="py-2.5 px-2 text-center font-semibold text-[#0B2240] whitespace-nowrap"
                      >
                        {day}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {STANDARD_TIME_SLOTS.map((slot) => (
                    <tr key={slot.key} className="hover:bg-slate-50/70">
                      <td className="py-2 px-3 font-mono text-slate-700 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => toggleTimeAcrossActiveDays(slot.start, slot.end)}
                          title="Toggle this time slot across all selected days"
                          className="text-left hover:text-[#0B2240] hover:underline cursor-pointer"
                        >
                          {slot.label}
                        </button>
                      </td>
                      {WEEKDAY_CODES.map((day) => {
                        const key = `${day}|${slot.start}|${slot.end}`;
                        const checked = selectedWeeklySlots.includes(key);
                        return (
                          <td key={key} className="py-1.5 px-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => toggleWeeklyCell(day, slot.start, slot.end)}
                              aria-label={`${WEEKDAY_LABELS[day]} ${slot.label}`}
                              aria-pressed={checked}
                              className={`w-full min-w-[44px] h-8 rounded-md border text-[11px] font-medium transition-colors cursor-pointer ${
                                checked
                                  ? 'bg-[#0B2240] text-white border-[#0B2240]'
                                  : 'bg-white text-slate-400 border-slate-200 hover:border-slate-400 hover:text-slate-600'
                              }`}
                            >
                              {checked ? 'Open' : '—'}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
              <p className="text-xs text-slate-600 tabular-nums">
                <strong className="font-semibold text-[#0B2240]">{selectedWeeklySlots.length}</strong>{' '}
                weekly time slot{selectedWeeklySlots.length === 1 ? '' : 's'} selected across{' '}
                <strong className="font-semibold text-[#0B2240]">{selectedDaysCount}</strong>{' '}
                day{selectedDaysCount === 1 ? '' : 's'}.
              </p>
              <button
                type="button"
                disabled={isSavingWeeklySchedule}
                onClick={() => void handleSaveWeeklySchedule()}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Save className="w-4 h-4" aria-hidden="true" />
                <span>
                  {isSavingWeeklySchedule ? 'Saving & syncing slots...' : 'Save weekly schedule'}
                </span>
              </button>
            </div>
          </section>

          {/* Tutor Availability Slots */}
          <section aria-label="My availability slots" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                  Upcoming open slots ({availabilitySlots.length})
                </h2>
                <p className="text-xs text-slate-500">
                  Generated from your weekly schedule, or add a one-off custom slot
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddSlot((prev) => !prev)}
                className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors cursor-pointer"
              >
                <CalendarPlus className="w-4 h-4" aria-hidden="true" />
                <span>{showAddSlot ? 'Close form' : 'Add custom slot'}</span>
              </button>
            </div>

            {showAddSlot && (
              <form
                onSubmit={handleCreateSlot}
                className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
              >
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Start</label>
                  <input
                    type="time"
                    value={newStart}
                    onChange={(e) => setNewStart(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">End</label>
                  <input
                    type="time"
                    value={newEnd}
                    onChange={(e) => setNewEnd(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isCreatingSlot}
                  className="min-h-[40px] px-4 py-2 text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                >
                  {isCreatingSlot ? 'Saving...' : 'Create slot'}
                </button>
              </form>
            )}

            {availabilitySlots.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-500">
                No open availability slots yet. Add a slot so students can book sessions with you.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {availabilitySlots.map((slot) => {
                  const isEditing = editingSlotId === slot.id;
                  return (
                    <div
                      key={slot.id}
                      className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
                    >
                      {isEditing ? (
                        <div className="space-y-3">
                          <div className="grid grid-cols-3 gap-2">
                            <input
                              type="date"
                              value={editDate}
                              onChange={(e) => setEditDate(e.target.value)}
                              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                            />
                            <input
                              type="time"
                              value={editStart}
                              onChange={(e) => setEditStart(e.target.value)}
                              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                            />
                            <input
                              type="time"
                              value={editEnd}
                              onChange={(e) => setEditEnd(e.target.value)}
                              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <select
                              value={editStatus}
                              onChange={(e) =>
                                setEditStatus(e.target.value === 'inactive' ? 'inactive' : 'open')
                              }
                              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                            >
                              <option value="open">Open</option>
                              <option value="inactive">Inactive</option>
                            </select>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={isSavingSlot}
                                onClick={() => void handleSaveSlot(slot.id)}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-[#0B2240] rounded-md cursor-pointer"
                              >
                                {isSavingSlot ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSlotId(null)}
                                className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-md cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 text-sm font-mono font-medium text-[#0B2240] tabular-nums">
                              <span>{slot.date}</span>
                              <span>·</span>
                              <span>
                                {slot.start} – {slot.end}
                              </span>
                            </div>
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold capitalize ${getSlotStatusBadge(
                                slot.status
                              )}`}
                            >
                              {slot.status}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => startEditingSlot(slot)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Edit slot</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
        </>
      )}

      {/* Extracted Course Notes Modal */}
      {viewingExtractedNotes && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Course notes for ${viewingExtractedNotes.material.fileName}`}
          className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl border border-slate-200 max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#0B2240]">
                  {formatCourse(viewingExtractedNotes.material.courseCode)}
                </p>
                <h3 className="text-sm font-bold text-slate-900 truncate">
                  {viewingExtractedNotes.material.topicTitle || viewingExtractedNotes.material.fileName}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setViewingExtractedNotes(null)}
                aria-label="Close notes"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50">
              {viewingExtractedNotes.pages.length === 0 ? (
                <p className="text-sm text-slate-600 text-center py-8">
                  No readable course notes were found for this file.
                </p>
              ) : (
                viewingExtractedNotes.pages.map((page) => (
                  <div
                    key={page.pageLabel}
                    className="bg-white border border-slate-200 rounded-lg p-4 space-y-2"
                  >
                    <p className="text-xs font-semibold text-[#0B2240] uppercase tracking-wide">
                      {page.pageLabel}
                    </p>
                    <p dir="auto" className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                      {page.text}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tutor Note Attachment Preview Modal */}
      {previewNoteAttachment && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={previewNoteAttachment.fileName}
          className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl border border-slate-200 max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[#0B2240] truncate">
                {previewNoteAttachment.fileName}
              </p>
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(previewNoteAttachment.url);
                  setPreviewNoteAttachment(null);
                }}
                aria-label="Close preview"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-50 flex items-center justify-center">
              {previewNoteAttachment.mimeType === 'application/pdf' ? (
                <iframe
                  src={previewNoteAttachment.url}
                  title={previewNoteAttachment.fileName}
                  className="w-full h-[72vh] rounded-lg border border-slate-200 bg-white"
                />
              ) : (
                <img
                  src={previewNoteAttachment.url}
                  alt={previewNoteAttachment.fileName}
                  className="max-w-full max-h-[72vh] rounded-lg border border-slate-200 object-contain"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
