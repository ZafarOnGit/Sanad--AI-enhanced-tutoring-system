import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Download,
  Eye,
  FileText,
  Image as ImageIcon,
  Mail,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {
  fetchStudentTutorNotes,
  fetchTutorNoteAttachmentBlobUrl,
  markTutorNoteRead,
  replyToTutorNote,
} from '../api';
import { formatCourse, normalizeCourseCode } from '../courses';
import { formatUserError } from '../firebase';
import type { TutorNoteAttachment, TutorNoteItem } from '../types';
import { Spinner } from './Spinner';

interface StudentTutorNotesPageProps {
  studentUid: string;
  studentName: string;
  enrolledCourses: string[];
  onBackToHome: () => void;
  onUnreadCountChange: (unreadCount: number) => void;
}

function formatShortDate(iso?: string): string {
  if (!iso) return 'Recent';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Recent';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const StudentTutorNotesPage: React.FC<StudentTutorNotesPageProps> = ({
  studentUid,
  studentName,
  enrolledCourses,
  onBackToHome,
  onUnreadCountChange,
}) => {
  const [notes, setNotes] = useState<TutorNoteItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [courseFilter, setCourseFilter] = useState('ALL');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const [attachmentLoadingId, setAttachmentLoadingId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<{
    fileName: string;
    mimeType: string;
    url: string;
  } | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const closePreview = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewAttachment(null);
  };

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  const loadNotes = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await fetchStudentTutorNotes(studentUid, enrolledCourses);
      setNotes(list);
      onUnreadCountChange(list.filter((n) => !n.isRead).length);
    } catch (err) {
      setError(formatUserError(err, 'Could not load tutor notes.'));
    } finally {
      setIsLoading(false);
    }
  }, [studentUid, enrolledCourses, onUnreadCountChange]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const courseOptions = useMemo(() => {
    return Array.from(
      new Set([
        ...enrolledCourses.map((c) => normalizeCourseCode(c)).filter(Boolean),
        ...notes.map((n) => normalizeCourseCode(n.courseCode)).filter(Boolean),
      ])
    ).sort((a, b) => a.localeCompare(b));
  }, [enrolledCourses, notes]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return notes.filter((note) => {
      if (courseFilter !== 'ALL' && normalizeCourseCode(note.courseCode) !== courseFilter) {
        return false;
      }
      if (!q) return true;
      return (
        note.title.toLowerCase().includes(q) ||
        note.body.toLowerCase().includes(q) ||
        note.tutorName.toLowerCase().includes(q) ||
        formatCourse(note.courseCode).toLowerCase().includes(q)
      );
    });
  }, [notes, courseFilter, searchQuery]);

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedNoteId) || null,
    [notes, selectedNoteId]
  );

  const handleOpenNote = async (note: TutorNoteItem) => {
    setSelectedNoteId(note.id);
    setReplyText('');
    setReplyError(null);
    setAttachmentError(null);

    if (!note.isRead) {
      const updatedList = notes.map((item) =>
        item.id === note.id ? { ...item, isRead: true } : item
      );
      setNotes(updatedList);
      onUnreadCountChange(updatedList.filter((item) => !item.isRead).length);
      await markTutorNoteRead(note.id, studentUid, studentName);
    }
  };

  const handleViewAttachment = async (noteId: string, att: TutorNoteAttachment) => {
    setAttachmentLoadingId(att.id);
    setAttachmentError(null);
    try {
      const url = await fetchTutorNoteAttachmentBlobUrl(noteId, att.id, false);
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewUrlRef.current = url;
      setPreviewAttachment({
        fileName: att.fileName,
        mimeType: att.mimeType,
        url,
      });
    } catch (err) {
      setAttachmentError(formatUserError(err, 'Could not open attachment.'));
    } finally {
      setAttachmentLoadingId(null);
    }
  };

  const handleDownloadAttachment = async (noteId: string, att: TutorNoteAttachment) => {
    setAttachmentLoadingId(att.id);
    setAttachmentError(null);
    try {
      const url = await fetchTutorNoteAttachmentBlobUrl(noteId, att.id, true);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = att.fileName || 'attachment';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      setAttachmentError(formatUserError(err, 'Could not download attachment.'));
    } finally {
      setAttachmentLoadingId(null);
    }
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNote) return;
    if (!replyText.trim()) {
      setReplyError('Please enter a short reply.');
      return;
    }

    setIsSendingReply(true);
    setReplyError(null);
    try {
      const newReply = await replyToTutorNote({
        noteId: selectedNote.id,
        studentUid,
        authorUid: studentUid,
        authorName: studentName,
        authorRole: 'student',
        text: replyText,
      });
      setNotes((prev) =>
        prev.map((item) =>
          item.id === selectedNote.id
            ? { ...item, replies: [...(item.replies || []), newReply] }
            : item
        )
      );
      setReplyText('');
    } catch (err) {
      setReplyError(formatUserError(err, 'Could not send reply.'));
    } finally {
      setIsSendingReply(false);
    }
  };

  const unreadCount = notes.filter((n) => !n.isRead).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={onBackToHome}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[#0B2240] hover:underline mb-2 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span>Back to Home</span>
          </button>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#0B2240] tracking-tight flex items-center gap-2.5">
            <Mail className="w-6 h-6" aria-hidden="true" />
            <span>Tutor Notes</span>
            {unreadCount > 0 && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-200 tabular-nums">
                {unreadCount} new
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Messages, study tips, and shared files from your Academic Success Center tutors.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadNotes()}
          disabled={isLoading}
          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[40px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer shrink-0 disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Filters */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search
              className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title, tutor name, course, or message..."
              aria-label="Search tutor notes"
              className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
            />
          </div>
          <select
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
            aria-label="Filter by course"
            className="sm:w-72 min-h-[42px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
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

      {error && (
        <div
          role="alert"
          className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800 flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {isLoading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 flex items-center justify-center">
          <Spinner label="Loading tutor notes..." />
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
          <Mail className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
          <p className="text-base font-medium text-[#0B2240]">
            {notes.length === 0 ? 'No tutor notes yet' : 'No matching tutor notes'}
          </p>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            {notes.length === 0
              ? 'When your tutors share course updates, practice sheets, or personal study notes, they will appear here.'
              : 'Try clearing your search or selecting a different course.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Notes list */}
          <div className="lg:col-span-5 space-y-3">
            {filteredNotes.map((note) => {
              const isSelected = note.id === selectedNoteId;
              const isUnread = !note.isRead;
              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => void handleOpenNote(note)}
                  className={`w-full text-left p-4 rounded-xl border transition-colors cursor-pointer space-y-2 ${
                    isSelected
                      ? 'bg-slate-50 border-[#0B2240] ring-1 ring-[#0B2240]'
                      : isUnread
                        ? 'bg-amber-50/40 border-amber-300 hover:bg-amber-50/70'
                        : 'bg-white border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-[#0B2240]">
                      {formatCourse(note.courseCode)}
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        isUnread
                          ? 'bg-amber-500 text-white'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {isUnread ? 'New' : 'Read'}
                    </span>
                  </div>

                  <h2 className="text-sm font-semibold text-slate-900 line-clamp-2">{note.title}</h2>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="inline-flex items-center gap-1">
                      {note.audience === 'student' ? (
                        <UserCheck className="w-3.5 h-3.5 text-[#0B2240]" aria-hidden="true" />
                      ) : (
                        <Users className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                      )}
                      <span>{note.tutorName}</span>
                    </span>
                    <div className="flex items-center gap-2">
                      {(note.attachments?.length || 0) > 0 && (
                        <span className="inline-flex items-center gap-1 text-slate-600">
                          <Paperclip className="w-3 h-3" aria-hidden="true" />
                          <span>{note.attachments!.length}</span>
                        </span>
                      )}
                      <span>{formatShortDate(note.createdAt)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detail view */}
          <div className="lg:col-span-7">
            {!selectedNote ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                Select a note on the left to read the full message and open any attachments.
              </div>
            ) : (
              <article className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
                <div className="space-y-2 border-b border-slate-200 pb-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#0B2240] uppercase tracking-wide">
                      {formatCourse(selectedNote.courseCode)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                      {selectedNote.audience === 'student' ? (
                        <>
                          <UserCheck className="w-3.5 h-3.5 text-[#0B2240]" aria-hidden="true" />
                          <span>Direct message</span>
                        </>
                      ) : (
                        <>
                          <Users className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                          <span>Course note</span>
                        </>
                      )}
                    </span>
                  </div>
                  <h2 className="font-display text-xl font-bold text-[#0B2240]">
                    {selectedNote.title}
                  </h2>
                  <p className="text-xs text-slate-500">
                    From <strong className="text-slate-700">{selectedNote.tutorName}</strong> ·{' '}
                    {formatShortDate(selectedNote.createdAt)}
                  </p>
                </div>

                <div
                  dir="auto"
                  className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed"
                >
                  {selectedNote.body}
                </div>

                {(selectedNote.attachments?.length || 0) > 0 && (
                  <div className="space-y-2.5 pt-2 border-t border-slate-200">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                      <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Attachments</span>
                    </h3>
                    {attachmentError && (
                      <p role="alert" className="text-xs text-red-700">
                        {attachmentError}
                      </p>
                    )}
                    <ul className="space-y-2">
                      {selectedNote.attachments!.map((att) => {
                        const isPdf = att.mimeType === 'application/pdf';
                        const isBusy = attachmentLoadingId === att.id;
                        return (
                          <li
                            key={att.id}
                            className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              {isPdf ? (
                                <FileText className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                              ) : (
                                <ImageIcon className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                              )}
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-900 truncate">
                                  {att.fileName}
                                </p>
                                <p className="text-xs text-slate-500">
                                  {isPdf ? 'PDF' : 'Image'}
                                  {att.size > 0 ? ` · ${formatBytes(att.size)}` : ''}
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleViewAttachment(selectedNote.id, att)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer disabled:opacity-60"
                              >
                                <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>{isBusy ? 'Opening...' : 'View'}</span>
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleDownloadAttachment(selectedNote.id, att)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer disabled:opacity-60"
                              >
                                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>Download</span>
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {selectedNote.audience === 'student' && (
                  <div className="space-y-3 pt-4 border-t border-slate-200">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                      <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Replies</span>
                    </h3>

                    {(selectedNote.replies?.length || 0) === 0 ? (
                      <p className="text-xs text-slate-500">
                        Have a follow-up question on this note? Send a short reply to {selectedNote.tutorName}.
                      </p>
                    ) : (
                      <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                        {selectedNote.replies!.map((rep) => (
                          <div
                            key={rep.id}
                            className={`p-3 rounded-lg text-sm border ${
                              rep.authorRole === 'student'
                                ? 'bg-slate-50 border-slate-200 ml-4'
                                : 'bg-blue-50/50 border-blue-200 mr-4'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 text-xs text-slate-500 mb-1">
                              <span className="font-semibold text-slate-800">{rep.authorName}</span>
                              <span>{formatShortDate(rep.createdAt)}</span>
                            </div>
                            <p dir="auto" className="text-slate-800 whitespace-pre-wrap">
                              {rep.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    <form onSubmit={handleSendReply} className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        dir="auto"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={`Reply to ${selectedNote.tutorName}...`}
                        className="flex-1 min-h-[42px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
                      />
                      <button
                        type="submit"
                        disabled={isSendingReply || !replyText.trim()}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[42px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer disabled:opacity-60"
                      >
                        <Send className="w-4 h-4" aria-hidden="true" />
                        <span>{isSendingReply ? 'Sending...' : 'Reply'}</span>
                      </button>
                    </form>
                    {replyError && (
                      <p role="alert" className="text-xs text-red-700">
                        {replyError}
                      </p>
                    )}
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      )}

      {/* Attachment preview modal */}
      {previewAttachment && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={previewAttachment.fileName}
          className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl border border-slate-200 max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[#0B2240] truncate">
                {previewAttachment.fileName}
              </p>
              <button
                type="button"
                onClick={closePreview}
                aria-label="Close preview"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-50 flex items-center justify-center">
              {previewAttachment.mimeType === 'application/pdf' ? (
                <iframe
                  src={previewAttachment.url}
                  title={previewAttachment.fileName}
                  className="w-full h-[72vh] rounded-lg border border-slate-200 bg-white"
                />
              ) : (
                <img
                  src={previewAttachment.url}
                  alt={previewAttachment.fileName}
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
