export type AuthRole = 'student' | 'tutor' | 'admin' | 'applicant';

export type ApplicantType = 'student' | 'faculty';

export type CourseCode = string;

export interface EncryptedBlob {
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface Student {
  id: string;
  name: string;
  campus: string;
  email: string;
  sheetEmail?: string;
}

export interface Tutor {
  id: string;
  name: string;
  subjects: string;
  campus: string;
  rating?: number;
  email?: string;
}

export type UserAccountStatus = 'pending' | 'approved' | 'rejected' | 'disabled';

export interface AuthProfile {
  id?: string;
  uid?: string;
  name?: string;
  campus?: string;
  email?: string;
  sheetEmail?: string;
  subjects?: string;
  applicantType?: ApplicantType;
  rating?: number;
  active?: boolean;
  status?: UserAccountStatus;
}

export interface AuthSession {
  uid: string;
  role: AuthRole;
  applicantType?: ApplicantType;
  username: string;
  email: string;
  name: string;
  refId: string;
  campus: string;
  profile: AuthProfile;
}

export interface FirestoreUser {
  uid: string;
  email: string;
  name: string;
  role: AuthRole;
  applicantType?: ApplicantType;
  campus: string;
  refId: string;
  active: boolean;
  status?: UserAccountStatus;
  subjects?: string;
  sheetEmail?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface FirestoreCourse {
  id: string;
  code: string;
  title: string;
  department?: string;
  campus?: string;
  active: boolean;
}

export type MaterialStatus = 'uploading' | 'indexing' | 'indexed' | 'failed';

export interface FirestoreMaterial {
  id: string;
  fileName: string;
  topicTitle?: string;
  courseCode: string;
  courseName: string;
  fileUrl?: string;
  storagePath?: string;
  storageMode?: 'storage' | 'firestore_parts' | 'text_only';
  partCount?: number;
  uploadedAt?: string;
  uploadedBy: string;
  status: MaterialStatus;
  chunkCount: number;
  size: number;
  errorMessage?: string;
}

export interface MaterialFilePart {
  id: string;
  materialId: string;
  partIndex: number;
  totalParts: number;
  data: string;
}

export interface FirestoreChunk {
  id: string;
  materialId: string;
  courseCode: string;
  courseName: string;
  fileName: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  embeddingModel?: string;
  embeddingDim?: number;
  createdAt?: string;
}

export interface MaterialNotePageGroup {
  pageLabel: string;
  pageNumber: number | null;
  text: string;
}

export type AttachmentMimeType = 'image/png' | 'image/jpeg' | 'application/pdf';

export interface RequestAttachment {
  fileName: string;
  mimeType: AttachmentMimeType;
  size: number;
  extractedText: string;
}

export interface StudentRequestItem {
  id: string;
  studentUid: string;
  studentName?: string;
  studentEmail?: string;
  campus?: string;
  time?: string;
  course: string;
  topic?: string;
  text: string;
  studentNote?: string;
  attachments?: RequestAttachment[];
  brief?: string;
  diagScore?: number | null;
  retestScore?: number | null;
  status: string;
  tutor?: string;
  when?: string;
  sheetRequestId?: string;
}

export interface BookmarkItem {
  id: string;
  studentUid: string;
  course: string;
  topic: string;
  title: string;
  note: string;
  requestId?: string;
  createdAt?: string;
}

export interface ProgressItem {
  id: string;
  studentUid: string;
  course: string;
  topic: string;
  attempts: number;
  bestScore: number;
  latestScore?: number;
  previousScore?: number;
  lastStatus: string;
  updatedAt?: string;
}

export type WeekdayCode = 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';

export type RescheduleStatus = 'none' | 'requested' | 'approved' | 'declined';

export interface TutorWeeklySchedule {
  tutorUid: string;
  tutorId: string;
  tutorName: string;
  campus: string;
  days: WeekdayCode[];
  timeSlots: string[];
  scheduleSlots: string[];
  updatedAt?: string;
}

export interface BookingItem {
  id: string;
  tutorUid: string;
  tutorId: string;
  tutorName: string;
  campus: string;
  date: string;
  start: string;
  end: string;
  status: 'open' | 'booked' | 'completed' | 'cancelled' | 'inactive';
  studentUid?: string;
  studentName?: string;
  studentEmail?: string;
  requestId?: string;
  course?: string;
  topic?: string;
  problem?: string;
  brief?: string;
  attachments?: RequestAttachment[];
  tutorNotes?: string;
  tutorFeedback?: string;
  rescheduleStatus?: RescheduleStatus;
  rescheduleReason?: string;
  reschedulePreferredSlotId?: string;
  reschedulePreferredWhen?: string;
  rescheduleRequestedAt?: string;
  rescheduleResponseNote?: string;
}

export interface UsageLogItem {
  id: string;
  actorUid: string;
  actorRole: AuthRole;
  action: string;
  course?: string;
  requestId?: string;
  detail: string;
  createdAt?: string;
}

export interface TutorSession {
  id: string;
  requestId: string;
  student: string;
  campus: string;
  course: string;
  topic: string;
  problem: string;
  date: string;
  start: string;
  end: string;
  brief: string;
  attachments?: RequestAttachment[];
  tutorNotes?: string;
  tutorFeedback?: string;
  status: 'open' | 'booked' | 'completed' | 'cancelled' | 'inactive';
  rescheduleStatus?: RescheduleStatus;
  rescheduleReason?: string;
  reschedulePreferredSlotId?: string;
  reschedulePreferredWhen?: string;
  rescheduleRequestedAt?: string;
  rescheduleResponseNote?: string;
}

export interface ExtractedCourse {
  code: string;
  title: string;
  grade: string;
  credits?: number;
  passed: boolean;
}

export interface ParsedTranscriptResult {
  cumulativeGpa: number;
  gpaFound: boolean;
  completedSemesters: number;
  completedCredits: number;
  hasCompletedFirstSemester: boolean;
  extractedCourses: ExtractedCourse[];
  matchedCourses: string[];
  eligible: boolean;
  autoRejected: boolean;
  screeningReason: string;
  summary: string;
}

export type TutorApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface TutorOnboardingSettings {
  minGpa: number;
  requireFirstSemesterCompleted: boolean;
  requireFacultyDocs: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export interface TutorApplicationItem {
  id: string;
  applicantUid: string;
  applicantEmail: string;
  applicantName: string;
  campus: string;
  applicantType: ApplicantType;
  status: TutorApplicationStatus;
  autoScreened: boolean;
  screeningReason?: string;
  gpa?: number;
  completedSemesters?: number;
  completedCredits?: number;
  matchedCourses: string[];
  requestedCourses: string[];
  approvedCourses: string[];
  documentFileName?: string;
  documentMimeType?: string;
  documentBase64?: string;
  parsedTranscript?: ParsedTranscriptResult;
  adminNotes?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  emailNotificationStatus?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CourseNote {
  course: string;
  topic: string;
  text: string;
  fileName?: string;
  chunkIndex?: number;
}

export type QuestionType = 'single' | 'multiple' | 'written';

export interface DiagnosticQuestion {
  type: QuestionType;
  question: string;
  options: string[];
  correctIndexes: number[];
  modelAnswer: string;
  explanation: string;
  subtopic: string;
}

export interface GradeWrittenResponse {
  correct: boolean;
  feedback: string;
}

export interface DiagnosticResponse {
  onTopic: boolean;
  topic: string;
  diagnosis: string;
  questions: DiagnosticQuestion[];
}

export interface DiagnosticItemPayload {
  question: string;
  subtopic: string;
  correct: boolean;
  questionType?: QuestionType;
  studentAnswer?: string;
  correctAnswer?: string;
  feedback?: string;
}

export interface StoredExamRecord {
  id: string;
  requestId: string;
  stage: 'diagnostic' | 'retest';
  course: string;
  topic: string;
  status: 'in_progress' | 'completed';
  currentIndex: number;
  score: number;
  totalQuestions: number;
  correctCount: number;
  weakSubtopics: string[];
  diagnosis?: string;
  questions: DiagnosticQuestion[];
  answers: DiagnosticItemPayload[];
  studyPack?: StudyPackResponse;
  createdAt?: string;
  updatedAt?: string;
}

export interface StudentResumeContext {
  request: StudentRequestItem;
  diagExam?: StoredExamRecord;
  retestExam?: StoredExamRecord;
  startStage?: 'diagnostic' | 'studyPack' | 'retest' | 'retestResult';
}

export interface StudyPackResponse {
  explanation: string;
  workedExample: string;
  practice: DiagnosticQuestion[];
}

export interface RetestResponse {
  questions: DiagnosticQuestion[];
}

export interface SaveRetestResponse {
  ok?: boolean;
  status?: string;
}

export type FeedbackRating = 'up' | 'down';

export interface WrongAnswerDetail {
  stage: 'diagnostic' | 'retest';
  question: string;
  subtopic: string;
  studentAnswer: string;
  correctAnswer: string;
}

export interface BookTutorResponse {
  ok?: boolean;
  bookingId?: string;
  tutor?: string;
  when?: string;
  waitlist?: boolean;
  error?: string;
}

export interface DashboardLogEntry {
  id?: string;
  time?: string;
  timestamp?: string;
  request?: string;
  requestId?: string;
  step?: string;
  detail?: string;
  student?: string;
  campus?: string;
  course?: string;
  topic?: string;
  stage?: string;
  score?: number;
  status?: string;
  tutor?: string;
  [key: string]: unknown;
}

export interface DashboardData {
  total: number;
  resolvedByAI: number;
  bookedWithTutor: number;
  waitlist: number;
  percentResolvedByAI: number;
  byCourse: Record<string, number>;
  byTopic: Record<string, number>;
  busiestTutors: Record<string, number>;
  recentLog: DashboardLogEntry[];
}

export interface AnalyticsRequestRow {
  studentUid: string;
  course: string;
  topic: string;
  status: string;
  diagScore: number | null;
  retestScore: number | null;
  tutor?: string;
  createdAt: string;
}

export interface AnalyticsBookingRow {
  tutorName: string;
  studentUid?: string;
  status: BookingItem['status'];
  date: string;
  createdAt: string;
}

export interface AnalyticsRetestRow {
  studentUid: string;
  course: string;
  topic: string;
  score: number;
  createdAt: string;
}

export interface AnalyticsActivityRow {
  actorUid: string;
  actorRole: AuthRole;
  createdAt: string;
}

export interface AdminAnalyticsDataset {
  requests: AnalyticsRequestRow[];
  bookings: AnalyticsBookingRow[];
  retests: AnalyticsRetestRow[];
  activity: AnalyticsActivityRow[];
}

export interface TutorNoteAttachment {
  id: string;
  fileName: string;
  mimeType: AttachmentMimeType;
  size: number;
  partCount: number;
}

export type TutorNoteAudience = 'student' | 'course';

export interface TutorNoteReplyItem {
  id: string;
  noteId: string;
  studentUid: string;
  authorUid: string;
  authorName: string;
  authorRole: 'student' | 'tutor';
  text: string;
  createdAt: string;
}

export interface TutorNoteItem {
  id: string;
  tutorId: string;
  tutorName: string;
  courseCode: string;
  audience: TutorNoteAudience;
  studentId?: string;
  studentName?: string;
  title: string;
  body: string;
  attachments?: TutorNoteAttachment[];
  createdAt: string;
  updatedAt: string;
  readCount?: number;
  isRead?: boolean;
  replies?: TutorNoteReplyItem[];
}

export interface TutorHandledStudent {
  uid: string;
  name: string;
  email?: string;
  courses: string[];
}

