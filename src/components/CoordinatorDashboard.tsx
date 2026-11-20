import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  BookOpen,
  Calendar,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Edit3,
  Eye,
  FileText,
  GraduationCap,
  HelpCircle,
  Image as ImageIcon,
  Layers,
  List,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Shield,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import {
  cancelBookingAdmin,
  createCourseAdmin,
  createTutorSlot,
  createUserAdmin,
  deleteMaterialAndChunks,
  deleteTutorNote,
  fetchAllBookingsAdmin,
  fetchAllRequestsAdmin,
  fetchAllTutorApplicationsAdmin,
  fetchAllTutorNotesAdmin,
  fetchAllUsersAdmin,
  fetchCourseRecords,
  fetchCourses,
  fetchDashboardData,
  fetchMaterialExtractedNotes,
  fetchMaterialPdfBlobUrl,
  fetchMaterialsOnly,
  fetchTutorNoteAttachmentBlobUrl,
  fetchUsageLogsAdmin,
  MAX_PDF_BYTES,
  purgeLegacyMockMaterials,
  refreshCourseAiNotesAdmin,
  reindexMaterial,
  rescheduleBookingAdmin,
  seedDemoEcosystem,
  syncSeedCourseTitlesOnceAdmin,
  toggleCourseActiveAdmin,
  updateCourseAdmin,
  updateTutorSlot,
  updateUserAdmin,
  uploadAndIndexMaterial,
} from '../api';
import {
  compareTopicTitles,
  deriveTopicTitleFromFileName,
  formatCourse,
  formatCourseList,
  isValidCourseCode,
  normalizeCourseCode,
} from '../courses';
import {
  auth,
  DAILY_LIMIT_ERROR_MESSAGE,
  formatUserError,
  isResourceExhaustedError,
  QuotaExceededError,
} from '../firebase';
import type {
  AuthRole,
  BookingItem,
  DashboardData,
  DashboardLogEntry,
  FirestoreCourse,
  FirestoreMaterial,
  FirestoreUser,
  MaterialNotePageGroup,
  MaterialStatus,
  StudentRequestItem,
  TutorNoteAttachment,
  TutorNoteItem,
  UsageLogItem,
} from '../types';
import { AdminAnalyticsPanel } from './AdminAnalyticsPanel';
import { AdminBookingCalendar } from './AdminBookingCalendar';
import { AdminTutorApplicationsPanel } from './AdminTutorApplicationsPanel';
import { AttachmentList } from './AttachmentList';
import { FormattedText } from './FormattedText';
import { Spinner } from './Spinner';

type AdminTab =
  | 'overview'
  | 'analytics'
  | 'applications'
  | 'courses'
  | 'requests'
  | 'users'
  | 'tutors'
  | 'slots'
  | 'materials'
  | 'tutorNotes'
  | 'logs';

function toSortedEntries(
  input: Record<string, number> | undefined
): Array<[string, number]> {
  if (!input) return [];
  return Object.entries(input)
    .map(([k, v]): [string, number] => [k, Number(v) || 0])
    .sort((a, b) => b[1] - a[1]);
}

function formatDateOnly(raw: string | undefined): string {
  if (!raw) return '—';
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return raw;
}

function scrubAdminMetadata(raw: string | undefined): string {
  if (!raw) return '—';
  return raw
    .replace(/\b(?:REQ|SLOT|APP|mat)-[a-zA-Z0-9_-]+\b/g, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || '—';
}

function getMaterialStatusBadge(status: MaterialStatus): { label: string; classes: string } {
  switch (status) {
    case 'uploading':
    case 'indexing':
      return {
        label: 'Processing',
        classes: 'bg-amber-50 text-amber-800 border-amber-200',
      };
    case 'failed':
      return {
        label: 'Failed',
        classes: 'bg-red-50 text-red-800 border-red-200',
      };
    case 'indexed':
    default:
      return {
        label: 'Ready',
        classes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
      };
  }
}

interface MaterialUploadQueueItem {
  id: string;
  file: File;
  courseCode: string;
  topicTitle: string;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error?: string;
}

const CAMPUSES = [
  'Fujairah',
  'Abu Dhabi',
  'Dubai',
  'Sharjah',
  'Al Ain',
  'Ras Al Khaimah',
  'Madinat Zayed',
  'Ruwais',
];

interface CoordinatorDashboardProps {
  adminUid?: string;
}

export const CoordinatorDashboard: React.FC<CoordinatorDashboardProps> = ({ adminUid }) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [pendingAppsCount, setPendingAppsCount] = useState(0);

  // Seed Demo Ecosystem state
  const [isSeeding, setIsSeeding] = useState(false);
  const [seedStatus, setSeedStatus] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  // Overview state
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoadingDash, setIsLoadingDash] = useState(true);
  const [dashError, setDashError] = useState<string | null>(null);

  // Users & Tutors state
  const [users, setUsers] = useState<FirestoreUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<AuthRole>('student');
  const [newCampus, setNewCampus] = useState('Fujairah');
  const [newRefId, setNewRefId] = useState('');
  const [newSubjects, setNewSubjects] = useState('');
  const [userFormError, setUserFormError] = useState<string | null>(null);
  const [isSavingUser, setIsSavingUser] = useState(false);

  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [editUserName, setEditUserName] = useState('');
  const [editUserRole, setEditUserRole] = useState<AuthRole>('student');
  const [editUserCampus, setEditUserCampus] = useState('');
  const [editUserRefId, setEditUserRefId] = useState('');
  const [editUserSubjects, setEditUserSubjects] = useState('');

  // Slots / Bookings & Calendar state
  const [bookings, setBookings] = useState<BookingItem[]>([]);
  const [bookingsViewMode, setBookingsViewMode] = useState<'calendar' | 'table'>('calendar');
  const [isLoadingBookings, setIsLoadingBookings] = useState(false);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [showCreateSlot, setShowCreateSlot] = useState(false);
  const [slotTutorUid, setSlotTutorUid] = useState('');
  const [slotDate, setSlotDate] = useState(() =>
    new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  );
  const [slotStart, setSlotStart] = useState('10:00');
  const [slotEnd, setSlotEnd] = useState('10:30');
  const [isSavingSlot, setIsSavingSlot] = useState(false);
  const [slotError, setSlotError] = useState<string | null>(null);

  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [editSlotDate, setEditSlotDate] = useState('');
  const [editSlotStart, setEditSlotStart] = useState('');
  const [editSlotEnd, setEditSlotEnd] = useState('');
  const [editSlotStatus, setEditSlotStatus] = useState<BookingItem['status']>('open');

  // Reschedule & Cancel booking modal state
  const [rescheduleTarget, setRescheduleTarget] = useState<BookingItem | null>(null);
  const [reschedDate, setReschedDate] = useState('');
  const [reschedStart, setReschedStart] = useState('');
  const [reschedEnd, setReschedEnd] = useState('');
  const [reschedTutorUid, setReschedTutorUid] = useState('');
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);

  const [cancelTarget, setCancelTarget] = useState<BookingItem | null>(null);
  const [cancelReopenSlot, setCancelReopenSlot] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [isCancellingBooking, setIsCancellingBooking] = useState(false);
  const [cancelBookingError, setCancelBookingError] = useState<string | null>(null);
  const [bookingActionBanner, setBookingActionBanner] = useState<string | null>(null);

  // Courses state
  const [coursesList, setCoursesList] = useState<FirestoreCourse[]>([]);
  const [isLoadingCourses, setIsLoadingCourses] = useState(false);
  const [coursesError, setCoursesError] = useState<string | null>(null);
  const [showCreateCourse, setShowCreateCourse] = useState(false);
  const [newCourseCode, setNewCourseCode] = useState('');
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseDept, setNewCourseDept] = useState('');
  const [newCourseActive, setNewCourseActive] = useState(true);
  const [courseFormError, setCourseFormError] = useState<string | null>(null);
  const [courseActionBanner, setCourseActionBanner] = useState<string | null>(null);
  const [isSavingCourse, setIsSavingCourse] = useState(false);
  const [editingCourseId, setEditingCourseId] = useState<string | null>(null);
  const [editCourseTitle, setEditCourseTitle] = useState('');
  const [editCourseDept, setEditCourseDept] = useState('');
  const [editCourseActive, setEditCourseActive] = useState(true);

  // Student Requests state
  const [allRequests, setAllRequests] = useState<StudentRequestItem[]>([]);
  const [isLoadingRequests, setIsLoadingRequests] = useState(false);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [reqSearch, setReqSearch] = useState('');
  const [reqCourseFilter, setReqCourseFilter] = useState('all');

  // Materials state
  const [catalogCourses, setCatalogCourses] = useState<string[]>([]);
  const [materials, setMaterials] = useState<FirestoreMaterial[]>([]);
  const [hasLegacyEntries, setHasLegacyEntries] = useState(false);
  const [isPurgingLegacy, setIsPurgingLegacy] = useState(false);
  const [matSearch, setMatSearch] = useState('');
  const [matCourseFilter, setMatCourseFilter] = useState<string>('all');
  const [expandedCourses, setExpandedCourses] = useState<Record<string, boolean>>({});
  const [isLoadingMaterials, setIsLoadingMaterials] = useState(false);
  const [materialsError, setMaterialsError] = useState<string | null>(null);
  const [showCreateMat, setShowCreateMat] = useState(false);
  const [matCourse, setMatCourse] = useState<string>('');
  const [uploadQueue, setUploadQueue] = useState<MaterialUploadQueueItem[]>([]);
  const uploadQueueRef = useRef<MaterialUploadQueueItem[]>([]);
  const isProcessingQueueRef = useRef(false);
  const dragDepthRef = useRef(0);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [isDragOverMat, setIsDragOverMat] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [ignoredFilesNotice, setIgnoredFilesNotice] = useState<string | null>(null);
  const [matFormError, setMatFormError] = useState<string | null>(null);
  const [matActionBanner, setMatActionBanner] = useState<string | null>(null);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);
  const [refreshingCourseCode, setRefreshingCourseCode] = useState<string | null>(null);
  const [courseRefreshProgress, setCourseRefreshProgress] = useState<string | null>(null);
  const [deletingMatId, setDeletingMatId] = useState<string | null>(null);
  const [confirmDeleteMatId, setConfirmDeleteMatId] = useState<string | null>(null);
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

  // Tutor Notes moderation state
  const [tutorNotes, setTutorNotes] = useState<TutorNoteItem[]>([]);
  const [isLoadingTutorNotes, setIsLoadingTutorNotes] = useState(false);
  const [tutorNotesError, setTutorNotesError] = useState<string | null>(null);
  const [tutorNoteSearch, setTutorNoteSearch] = useState('');
  const [tutorNoteCourseFilter, setTutorNoteCourseFilter] = useState('all');
  const [confirmDeleteTutorNoteId, setConfirmDeleteTutorNoteId] = useState<string | null>(null);
  const [deletingTutorNoteId, setDeletingTutorNoteId] = useState<string | null>(null);
  const [tutorNotesBanner, setTutorNotesBanner] = useState<string | null>(null);
  const [busyNoteAttachmentId, setBusyNoteAttachmentId] = useState<string | null>(null);
  const [previewNoteAttachment, setPreviewNoteAttachment] = useState<{
    fileName: string;
    mimeType: string;
    url: string;
  } | null>(null);

  // Usage Logs state
  const [usageLogs, setUsageLogs] = useState<UsageLogItem[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

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

  const loadDashboard = async () => {
    setIsLoadingDash(true);
    setDashError(null);
    try {
      const result = await fetchDashboardData();
      setData(result);
    } catch (err) {
      setDashError(
        formatUserError(err, 'Could not reach the Sanad database. Please try again.')
      );
    } finally {
      setIsLoadingDash(false);
    }
  };

  const loadUsers = async () => {
    setIsLoadingUsers(true);
    setUsersError(null);
    try {
      const list = await fetchAllUsersAdmin();
      setUsers(list);
      const firstTutor = list.find((u) => u.role === 'tutor' && u.active !== false);
      if (firstTutor && !slotTutorUid) {
        setSlotTutorUid(firstTutor.uid);
      }
    } catch (err) {
      setUsersError(
        formatUserError(err, 'Could not load users. Please try again.')
      );
    } finally {
      setIsLoadingUsers(false);
    }
  };

  const loadBookings = async () => {
    setIsLoadingBookings(true);
    setBookingsError(null);
    try {
      const list = await fetchAllBookingsAdmin();
      setBookings(list);
    } catch (err) {
      setBookingsError(
        formatUserError(err, 'Could not load tutor slots. Please try again.')
      );
    } finally {
      setIsLoadingBookings(false);
    }
  };

  const loadCourses = async () => {
    setIsLoadingCourses(true);
    setCoursesError(null);
    try {
      const records = await fetchCourseRecords(true);
      setCoursesList(records);
      const activeCodes = records.filter((c) => c.active).map((c) => c.code);
      setCatalogCourses(activeCodes);
      if (activeCodes.length > 0 && (!matCourse || !activeCodes.includes(matCourse))) {
        setMatCourse(activeCodes[0]);
      }
    } catch (err) {
      setCoursesError(
        formatUserError(err, 'Could not load courses. Please try again.')
      );
    } finally {
      setIsLoadingCourses(false);
    }
  };

  const loadRequestsAdmin = async () => {
    setIsLoadingRequests(true);
    setRequestsError(null);
    try {
      const list = await fetchAllRequestsAdmin();
      setAllRequests(list);
    } catch (err) {
      setRequestsError(
        formatUserError(err, 'Could not load student requests. Please try again.')
      );
    } finally {
      setIsLoadingRequests(false);
    }
  };

  const loadMaterials = async () => {
    setIsLoadingMaterials(true);
    setMaterialsError(null);
    try {
      const [res, courseList] = await Promise.all([
        fetchMaterialsOnly(),
        fetchCourses().catch(() => [] as string[]),
      ]);
      if (courseList.length > 0) {
        setCatalogCourses(courseList);
        if (!matCourse || !courseList.includes(matCourse)) {
          setMatCourse(courseList[0]);
        }
      }
      setHasLegacyEntries(res.hasLegacyEntries);
      setMaterials(res.materials);
    } catch (err) {
      setMaterialsError(
        formatUserError(err, 'Could not load course materials. Please try again.')
      );
    } finally {
      setIsLoadingMaterials(false);
    }
  };

  const loadTutorNotesAdmin = async () => {
    setIsLoadingTutorNotes(true);
    setTutorNotesError(null);
    try {
      const list = await fetchAllTutorNotesAdmin();
      setTutorNotes(list);
    } catch (err) {
      setTutorNotesError(
        formatUserError(err, 'Could not load tutor notes. Please try again.')
      );
    } finally {
      setIsLoadingTutorNotes(false);
    }
  };

  const loadLogs = async () => {
    setIsLoadingLogs(true);
    setLogsError(null);
    try {
      const list = await fetchUsageLogsAdmin();
      setUsageLogs(list);
    } catch (err) {
      setLogsError(
        formatUserError(err, 'Could not load usage logs. Please try again.')
      );
    } finally {
      setIsLoadingLogs(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
    void loadUsers();
    void loadCourses();
    void syncSeedCourseTitlesOnceAdmin()
      .then((updated) => {
        if (updated > 0) {
          void loadCourses();
          void loadDashboard();
        }
      })
      .catch(() => undefined);
    void fetchAllTutorApplicationsAdmin()
      .then((apps) => setPendingAppsCount(apps.filter((a) => a.status === 'pending').length))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeTab === 'courses') void loadCourses();
    if (activeTab === 'requests') void loadRequestsAdmin();
    if (activeTab === 'users' || activeTab === 'tutors') void loadUsers();
    if (activeTab === 'slots') {
      void loadUsers();
      void loadBookings();
    }
    if (activeTab === 'materials') void loadMaterials();
    if (activeTab === 'tutorNotes') void loadTutorNotesAdmin();
    if (activeTab === 'logs') void loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleSeedAll = async () => {
    setIsSeeding(true);
    setSeedError(null);
    setSeedStatus('Starting demo seed...');
    try {
      const summary = await seedDemoEcosystem((msg) => setSeedStatus(msg));
      setSeedStatus(
        `Seeded ${summary.usersSeeded} users (s1–s15, t1–t10, admin), ${summary.coursesSeeded} courses, and ${summary.slotsSeeded} initial slots.`
      );
      await Promise.all([loadDashboard(), loadUsers(), loadBookings(), loadMaterials()]);
    } catch (err) {
      setSeedError(formatUserError(err, 'Failed to seed demo data.'));
    } finally {
      setIsSeeding(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim() || !newPassword.trim() || !newName.trim()) {
      setUserFormError('Username, password, and full name are required.');
      return;
    }
    setIsSavingUser(true);
    setUserFormError(null);
    const derivedRefId =
      newRefId.trim() ||
      `${(activeTab === 'tutors' ? 'T' : newRole.charAt(0).toUpperCase())}${Date.now().toString().slice(-4)}`;
    try {
      await createUserAdmin({
        email: newEmail,
        password: newPassword,
        name: newName,
        role: activeTab === 'tutors' ? 'tutor' : newRole,
        campus: newCampus,
        refId: derivedRefId,
        subjects: newSubjects,
      });
      setShowCreateUser(false);
      setNewEmail('');
      setNewPassword('');
      setNewName('');
      setNewRefId('');
      setNewSubjects('');
      await loadUsers();
    } catch (err) {
      setUserFormError(formatUserError(err, 'Failed to create user.'));
    } finally {
      setIsSavingUser(false);
    }
  };

  const startEditUser = (u: FirestoreUser) => {
    setEditingUid(u.uid);
    setEditUserName(u.name);
    setEditUserRole(u.role);
    setEditUserCampus(u.campus);
    setEditUserRefId(u.refId);
    setEditUserSubjects(u.subjects || '');
  };

  const handleSaveEditUser = async (uid: string) => {
    setIsSavingUser(true);
    try {
      await updateUserAdmin(uid, {
        name: editUserName,
        role: editUserRole,
        campus: editUserCampus,
        refId: editUserRefId,
        subjects: editUserSubjects,
      });
      setEditingUid(null);
      await loadUsers();
    } catch (err) {
      setUsersError(formatUserError(err, 'Failed to update user.'));
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleToggleUserActive = async (u: FirestoreUser) => {
    try {
      await updateUserAdmin(u.uid, { active: !u.active });
      await loadUsers();
    } catch (err) {
      setUsersError(formatUserError(err, 'Failed to update user status.'));
    }
  };

  const handleCreateCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeCourseCode(newCourseCode);
    const title = newCourseTitle.trim();
    const dept = newCourseDept.trim();

    if (!isValidCourseCode(normalized)) {
      setCourseFormError(
        'Course code must start with 2-8 letters followed by 2-6 digits (for example, CIS2113).'
      );
      return;
    }
    if (!title) {
      setCourseFormError('Please enter a course title.');
      return;
    }
    if (coursesList.some((c) => c.code.toUpperCase() === normalized)) {
      setCourseFormError(`Course ${normalized} already exists.`);
      return;
    }

    setIsSavingCourse(true);
    setCourseFormError(null);
    setCourseActionBanner(null);
    try {
      const created = await createCourseAdmin({
        code: normalized,
        title,
        department: dept || undefined,
        active: newCourseActive,
      });
      setCourseActionBanner(`Added ${created.code} – ${created.title}.`);
      setNewCourseCode('');
      setNewCourseTitle('');
      setNewCourseDept('');
      setNewCourseActive(true);
      setShowCreateCourse(false);
      await loadCourses();
    } catch (err) {
      setCourseFormError(formatUserError(err, 'Could not add course.'));
    } finally {
      setIsSavingCourse(false);
    }
  };

  const startEditCourse = (c: FirestoreCourse) => {
    setEditingCourseId(c.id);
    setEditCourseTitle(c.title);
    setEditCourseDept(c.department || '');
    setEditCourseActive(c.active);
    setCoursesError(null);
  };

  const handleSaveEditCourse = async (courseId: string) => {
    if (!editCourseTitle.trim()) {
      setCoursesError('Course title cannot be empty.');
      return;
    }
    setIsSavingCourse(true);
    setCoursesError(null);
    try {
      await updateCourseAdmin(courseId, {
        title: editCourseTitle,
        department: editCourseDept,
        active: editCourseActive,
      });
      setEditingCourseId(null);
      setCourseActionBanner(`Updated course ${courseId}.`);
      await loadCourses();
    } catch (err) {
      setCoursesError(formatUserError(err, 'Failed to update course.'));
    } finally {
      setIsSavingCourse(false);
    }
  };

  const handleToggleCourseActive = async (c: FirestoreCourse) => {
    setCoursesError(null);
    try {
      await toggleCourseActiveAdmin(c.id, !c.active);
      setCourseActionBanner(
        !c.active ? `Activated ${c.code} – ${c.title}.` : `Deactivated ${c.code} – ${c.title}.`
      );
      await loadCourses();
    } catch (err) {
      setCoursesError(formatUserError(err, 'Failed to update course status.'));
    }
  };

  const handleCreateSlot = async (e: React.FormEvent) => {
    e.preventDefault();
    const tutor = users.find((u) => u.uid === slotTutorUid);
    if (!tutor) {
      setSlotError('Select a tutor first.');
      return;
    }
    setIsSavingSlot(true);
    setSlotError(null);
    try {
      await createTutorSlot({
        tutorUid: tutor.uid,
        tutorId: tutor.refId,
        tutorName: tutor.name,
        campus: tutor.campus,
        date: slotDate,
        start: slotStart,
        end: slotEnd,
      });
      setShowCreateSlot(false);
      await loadBookings();
    } catch (err) {
      setSlotError(formatUserError(err, 'Failed to create slot.'));
    } finally {
      setIsSavingSlot(false);
    }
  };

  const handleSaveEditSlot = async (bookingId: string) => {
    setIsSavingSlot(true);
    try {
      await updateTutorSlot({
        bookingId,
        date: editSlotDate,
        start: editSlotStart,
        end: editSlotEnd,
        status: editSlotStatus,
      });
      setEditingSlotId(null);
      await loadBookings();
    } catch (err) {
      setSlotError(formatUserError(err, 'Failed to update slot.'));
    } finally {
      setIsSavingSlot(false);
    }
  };

  const handleToggleSlotActive = async (b: BookingItem) => {
    try {
      await updateTutorSlot({
        bookingId: b.id,
        date: b.date,
        start: b.start,
        end: b.end,
        status: b.status === 'inactive' ? 'open' : 'inactive',
      });
      await loadBookings();
    } catch (err) {
      setSlotError(formatUserError(err, 'Failed to toggle slot status.'));
    }
  };

  const openRescheduleModal = (b: BookingItem) => {
    setRescheduleTarget(b);
    setReschedDate(b.date);
    setReschedStart(b.start);
    setReschedEnd(b.end);
    setReschedTutorUid(b.tutorUid);
    setRescheduleError(null);
  };

  const openCancelBookingModal = (b: BookingItem) => {
    setCancelTarget(b);
    setCancelReopenSlot(false);
    setCancelReason('');
    setCancelBookingError(null);
  };

  const handleConfirmReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rescheduleTarget) return;
    if (!reschedDate || !reschedStart || !reschedEnd) {
      setRescheduleError('Date, start time, and end time are required.');
      return;
    }
    if (reschedStart >= reschedEnd) {
      setRescheduleError('End time must be after start time.');
      return;
    }

    const chosenTutor = users.find((u) => u.uid === reschedTutorUid);
    const effectiveAdminUid = adminUid || auth.currentUser?.uid || '';
    const nextStatus: BookingItem['status'] =
      rescheduleTarget.status === 'cancelled' || rescheduleTarget.status === 'booked'
        ? rescheduleTarget.studentUid || rescheduleTarget.requestId
          ? 'booked'
          : 'open'
        : rescheduleTarget.status;

    setIsRescheduling(true);
    setRescheduleError(null);
    try {
      await rescheduleBookingAdmin({
        bookingId: rescheduleTarget.id,
        requestId: rescheduleTarget.requestId,
        date: reschedDate,
        start: reschedStart,
        end: reschedEnd,
        tutorUid: chosenTutor?.uid || rescheduleTarget.tutorUid,
        tutorId: chosenTutor?.refId || rescheduleTarget.tutorId,
        tutorName: chosenTutor?.name || rescheduleTarget.tutorName,
        campus: chosenTutor?.campus || rescheduleTarget.campus,
        status: nextStatus,
        adminUid: effectiveAdminUid,
      });
      setBookingActionBanner(
        `Rescheduled session to ${reschedDate} ${reschedStart}–${reschedEnd}${
          chosenTutor ? ` with ${chosenTutor.name}` : ''
        }.`
      );
      setRescheduleTarget(null);
      await Promise.all([loadBookings(), loadDashboard()]);
    } catch (err) {
      setRescheduleError(
        formatUserError(err, 'Failed to reschedule booking.')
      );
    } finally {
      setIsRescheduling(false);
    }
  };

  const handleConfirmCancelBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelTarget) return;
    const effectiveAdminUid = adminUid || auth.currentUser?.uid || '';
    setIsCancellingBooking(true);
    setCancelBookingError(null);
    try {
      await cancelBookingAdmin({
        bookingId: cancelTarget.id,
        requestId: cancelTarget.requestId,
        adminUid: effectiveAdminUid,
        reopenSlot: cancelReopenSlot,
        reason: cancelReason.trim() || undefined,
      });
      setBookingActionBanner(
        cancelReopenSlot
          ? `Booking cancelled and ${cancelTarget.date} ${cancelTarget.start}–${cancelTarget.end} slot reopened.`
          : `Booking on ${cancelTarget.date} ${cancelTarget.start}–${cancelTarget.end} cancelled.`
      );
      setCancelTarget(null);
      await Promise.all([loadBookings(), loadDashboard()]);
    } catch (err) {
      setCancelBookingError(
        formatUserError(err, 'Failed to cancel booking.')
      );
    } finally {
      setIsCancellingBooking(false);
    }
  };

  const updateQueueState = (
    updater: (prev: MaterialUploadQueueItem[]) => MaterialUploadQueueItem[]
  ) => {
    setUploadQueue((prev) => {
      const next = updater(prev);
      uploadQueueRef.current = next;
      return next;
    });
  };

  const addFilesToQueue = (filesList: FileList | File[]) => {
    const files = Array.from(filesList);
    if (files.length === 0) return;
    setMatFormError(null);
    setIgnoredFilesNotice(null);

    const acceptedFiles: File[] = [];
    const ignoredNames: string[] = [];

    files.forEach((file) => {
      const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
      if (isPdf) {
        acceptedFiles.push(file);
      } else {
        ignoredNames.push(file.name);
      }
    });

    if (ignoredNames.length > 0) {
      setIgnoredFilesNotice(
        ignoredNames.length === 1
          ? `Ignored ${ignoredNames[0]}. Only PDF files are accepted.`
          : `Ignored ${ignoredNames.length} non-PDF files. Only PDF files are accepted.`
      );
    }

    if (acceptedFiles.length === 0) {
      setFileInputKey((k) => k + 1);
      return;
    }

    const newItems: MaterialUploadQueueItem[] = acceptedFiles.map((file, idx) => {
      const id = `q-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`;
      const defaultTopic = deriveTopicTitleFromFileName(file.name);
      if (file.size <= 0) {
        return {
          id,
          file,
          courseCode: matCourse,
          topicTitle: defaultTopic,
          status: 'failed',
          error: 'This PDF file is empty.',
        };
      }
      if (file.size > MAX_PDF_BYTES) {
        return {
          id,
          file,
          courseCode: matCourse,
          topicTitle: defaultTopic,
          status: 'failed',
          error: 'Exceeds the 25 MB maximum size limit.',
        };
      }
      return {
        id,
        file,
        courseCode: matCourse,
        topicTitle: defaultTopic,
        status: 'pending',
      };
    });

    updateQueueState((prev) => [...prev, ...newItems]);
    setFileInputKey((k) => k + 1);
  };

  const handleBatchCourseChange = (nextCourse: string) => {
    setMatCourse(nextCourse);
    updateQueueState((prev) =>
      prev.map((item) => (item.status === 'pending' ? { ...item, courseCode: nextCourse } : item))
    );
  };

  const updateQueueTopicTitle = (itemId: string, nextTitle: string) => {
    updateQueueState((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, topicTitle: nextTitle } : item))
    );
  };

  const handlePdfFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
    }
  };

  const handleMatDragEnter = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOverMat(true);
  };

  const handleMatDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOverMat) setIsDragOverMat(true);
  };

  const handleMatDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverMat(false);
    }
  };

  const handleMatDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragOverMat(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  const removeQueueItem = (itemId: string) => {
    updateQueueState((prev) =>
      prev.filter((item) => item.id !== itemId || item.status === 'processing')
    );
  };

  const clearFinishedQueueItems = () => {
    updateQueueState((prev) =>
      prev.filter((item) => item.status === 'pending' || item.status === 'processing')
    );
  };

  const retryQueueItem = (itemId: string) => {
    updateQueueState((prev) =>
      prev.map((item) =>
        item.id === itemId && item.status === 'failed'
          ? { ...item, status: 'pending', error: undefined }
          : item
      )
    );
    setMatFormError(null);
    void runUploadQueueInBackground();
  };

  const runUploadQueueInBackground = async () => {
    if (isProcessingQueueRef.current) return;
    isProcessingQueueRef.current = true;
    setIsProcessingQueue(true);

    try {
      let processedAny = false;
      while (true) {
        const nextItem = uploadQueueRef.current.find((item) => item.status === 'pending');
        if (!nextItem) break;

        if (processedAny) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        processedAny = true;

        updateQueueState((prev) =>
          prev.map((item) =>
            item.id === nextItem.id ? { ...item, status: 'processing', error: undefined } : item
          )
        );

        try {
          const created = await uploadAndIndexMaterial({
            file: nextItem.file,
            courseCode: nextItem.courseCode,
            topicTitle: nextItem.topicTitle.trim() || deriveTopicTitleFromFileName(nextItem.file.name),
            uploadedBy: adminUid || 'admin',
          });
          updateQueueState((prev) =>
            prev.map((item) => (item.id === nextItem.id ? { ...item, status: 'ready' } : item))
          );
          setMatActionBanner(`${created.fileName} was added to ${formatCourse(created.courseCode)}.`);
          void loadMaterials();
        } catch (err) {
          if (err instanceof QuotaExceededError || isResourceExhaustedError(err)) {
            updateQueueState((prev) =>
              prev.map((item) =>
                item.id === nextItem.id || item.status === 'pending'
                  ? { ...item, status: 'failed', error: DAILY_LIMIT_ERROR_MESSAGE }
                  : item
              )
            );
            setMatFormError(DAILY_LIMIT_ERROR_MESSAGE);
            setMaterialsError(DAILY_LIMIT_ERROR_MESSAGE);
            void loadMaterials();
            break;
          }
          const errorMsg = formatUserError(
            err,
            'Could not add this file. Please try again.'
          );
          updateQueueState((prev) =>
            prev.map((item) =>
              item.id === nextItem.id ? { ...item, status: 'failed', error: errorMsg } : item
            )
          );
          void loadMaterials();
        }
      }
    } finally {
      isProcessingQueueRef.current = false;
      setIsProcessingQueue(false);
    }
  };

  const handleStartUploadQueue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!matCourse.trim()) {
      setMatFormError('Please select a course.');
      return;
    }
    const hasPending = uploadQueueRef.current.some((item) => item.status === 'pending');
    if (!hasPending) {
      setMatFormError('Please drop or select at least one PDF file to upload.');
      return;
    }
    setMatFormError(null);
    void runUploadQueueInBackground();
  };

  const handleReprocessMaterial = async (mat: FirestoreMaterial) => {
    setReprocessingId(mat.id);
    setMaterialsError(null);
    setMatActionBanner(null);
    try {
      await reindexMaterial(mat.id);
      setMatActionBanner(`${mat.fileName} was reprocessed for ${formatCourse(mat.courseCode)}.`);
      await loadMaterials();
    } catch (err) {
      setMaterialsError(formatUserError(err, 'Could not reprocess this file.'));
      await loadMaterials();
    } finally {
      setReprocessingId(null);
    }
  };

  const handleRefreshCourseNotes = async (courseCode: string) => {
    setRefreshingCourseCode(courseCode);
    setCourseRefreshProgress('Preparing course files...');
    setMaterialsError(null);
    setMatActionBanner(null);
    try {
      const updated = await refreshCourseAiNotesAdmin(courseCode, (current, total, fileName) => {
        setCourseRefreshProgress(`Refreshing ${current} of ${total}: ${fileName}`);
      });
      setMatActionBanner(
        `Refreshed AI study notes for ${formatCourse(courseCode)} (${updated} ${
          updated === 1 ? 'file' : 'files'
        }).`
      );
      await loadMaterials();
    } catch (err) {
      setMaterialsError(
        err instanceof QuotaExceededError || isResourceExhaustedError(err)
          ? DAILY_LIMIT_ERROR_MESSAGE
          : formatUserError(err, 'Could not refresh course notes. Please try again.')
      );
    } finally {
      setRefreshingCourseCode(null);
      setCourseRefreshProgress(null);
    }
  };

  const handlePurgeLegacyMaterials = async () => {
    setIsPurgingLegacy(true);
    setMaterialsError(null);
    try {
      const removed = await purgeLegacyMockMaterials();
      setHasLegacyEntries(false);
      setMatActionBanner(
        removed > 0
          ? `Removed ${removed} old sample entries.`
          : 'No old sample entries needed cleanup.'
      );
      await loadMaterials();
    } catch (err) {
      setMaterialsError(formatUserError(err, 'Could not remove sample entries.'));
    } finally {
      setIsPurgingLegacy(false);
    }
  };

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
      setMaterialsError(formatUserError(err, 'Could not load study notes.'));
    } finally {
      setLoadingNotesMatId(null);
    }
  };

  const handleDeleteMaterial = async (mat: FirestoreMaterial) => {
    setDeletingMatId(mat.id);
    setMaterialsError(null);
    setMatActionBanner(null);
    try {
      if (viewingPdf?.id === mat.id) {
        URL.revokeObjectURL(viewingPdf.url);
        setViewingPdf(null);
      }
      await deleteMaterialAndChunks(mat.id, mat.courseCode);
      setConfirmDeleteMatId(null);
      setMatActionBanner(`${mat.fileName} was removed.`);
      await loadMaterials();
    } catch (err) {
      setMaterialsError(formatUserError(err, 'Could not remove material.'));
    } finally {
      setDeletingMatId(null);
    }
  };

  const handleOpenTutorNoteAttachmentAdmin = async (
    noteId: string,
    attachment: TutorNoteAttachment,
    download = false
  ) => {
    setBusyNoteAttachmentId(attachment.id);
    setTutorNotesError(null);
    try {
      const blobUrl = await fetchTutorNoteAttachmentBlobUrl(noteId, attachment.id);
      if (download) {
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = attachment.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
      } else {
        if (previewNoteAttachment?.url) {
          URL.revokeObjectURL(previewNoteAttachment.url);
        }
        setPreviewNoteAttachment({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          url: blobUrl,
        });
      }
    } catch (err) {
      setTutorNotesError(
        formatUserError(err, 'Could not open this attachment.')
      );
    } finally {
      setBusyNoteAttachmentId(null);
    }
  };

  const handleDeleteTutorNoteAdmin = async (note: TutorNoteItem) => {
    setDeletingTutorNoteId(note.id);
    setTutorNotesError(null);
    setTutorNotesBanner(null);
    try {
      await deleteTutorNote(note.id, note.attachments);
      setConfirmDeleteTutorNoteId(null);
      setTutorNotes((prev) => prev.filter((item) => item.id !== note.id));
      setTutorNotesBanner(`Removed note "${note.title}".`);
    } catch (err) {
      setTutorNotesError(formatUserError(err, 'Could not delete tutor note.'));
    } finally {
      setDeletingTutorNoteId(null);
    }
  };

  const courseEntries = toSortedEntries(data?.byCourse);
  const topicEntries = toSortedEntries(data?.byTopic);
  const tutorEntries = toSortedEntries(data?.busiestTutors);
  const recentLog = Array.isArray(data?.recentLog) ? data.recentLog : [];
  const tutorsOnly = users.filter((u) => u.role === 'tutor');

  const allCourseCodes = useMemo(
    () => Array.from(new Set([...catalogCourses, ...materials.map((m) => m.courseCode)])),
    [catalogCourses, materials]
  );

  const toggleCourseSection = (code: string) => {
    setExpandedCourses((prev) => ({ ...prev, [code]: !prev[code] }));
  };

  const organizedCourseSections = useMemo(() => {
    const searchNeedle = matSearch.trim().toLowerCase();
    const targetCourses =
      matCourseFilter === 'all'
        ? allCourseCodes
        : allCourseCodes.filter((c) => c === matCourseFilter);

    const sections = targetCourses.map((code) => {
      const courseTitle = formatCourse(code);
      const allForCourse = materials.filter((m) => m.courseCode === code);
      const filteredForCourse = searchNeedle
        ? allForCourse.filter((m) => {
            const topicLabel = (m.topicTitle || deriveTopicTitleFromFileName(m.fileName)).toLowerCase();
            return (
              m.fileName.toLowerCase().includes(searchNeedle) ||
              topicLabel.includes(searchNeedle) ||
              code.toLowerCase().includes(searchNeedle) ||
              courseTitle.toLowerCase().includes(searchNeedle)
            );
          })
        : allForCourse;

      const groupsMap = new Map<string, { label: string; items: FirestoreMaterial[] }>();
      filteredForCourse.forEach((mat) => {
        const label = (mat.topicTitle || deriveTopicTitleFromFileName(mat.fileName)).trim() || 'General';
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
          items: group.items
            .slice()
            .sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' })),
        }));

      return {
        code,
        courseTitle,
        totalCount: allForCourse.length,
        filteredCount: filteredForCourse.length,
        topicGroups,
      };
    });

    if (searchNeedle) {
      return sections.filter((s) => s.filteredCount > 0);
    }
    return sections;
  }, [allCourseCodes, materials, matSearch, matCourseFilter]);

  const tabs: Array<{ id: AdminTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <Shield className="w-4 h-4" aria-hidden="true" /> },
    { id: 'analytics', label: 'Analytics', icon: <BarChart3 className="w-4 h-4" aria-hidden="true" /> },
    {
      id: 'applications',
      label: pendingAppsCount > 0 ? `Tutor Applications (${pendingAppsCount})` : 'Tutor Applications',
      icon: <GraduationCap className="w-4 h-4" aria-hidden="true" />,
    },
    { id: 'courses', label: 'Courses', icon: <Layers className="w-4 h-4" aria-hidden="true" /> },
    { id: 'requests', label: 'Student Requests', icon: <HelpCircle className="w-4 h-4" aria-hidden="true" /> },
    { id: 'users', label: 'Users', icon: <Users className="w-4 h-4" aria-hidden="true" /> },
    { id: 'tutors', label: 'Tutors', icon: <UserPlus className="w-4 h-4" aria-hidden="true" /> },
    { id: 'slots', label: 'Slots & Bookings', icon: <Calendar className="w-4 h-4" aria-hidden="true" /> },
    { id: 'materials', label: 'Materials', icon: <BookOpen className="w-4 h-4" aria-hidden="true" /> },
    { id: 'tutorNotes', label: 'Tutor Notes', icon: <MessageSquare className="w-4 h-4" aria-hidden="true" /> },
    { id: 'logs', label: 'Usage Logs', icon: <FileText className="w-4 h-4" aria-hidden="true" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header & Seed Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-slate-500">
            HCT Academic Success Center · Admin &amp; Operations Portal
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-[#0B2240]">
            ASC Coordinator
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={isSeeding}
            onClick={() => void handleSeedAll()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[42px] text-xs font-medium text-[#0B2240] bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 disabled:opacity-50 transition-colors cursor-pointer"
          >
            <Database className="w-4 h-4" aria-hidden="true" />
            <span>{isSeeding ? 'Seeding demo accounts...' : 'Seed Demo Accounts & Data'}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void loadDashboard();
              if (activeTab === 'courses') void loadCourses();
              if (activeTab === 'requests') void loadRequestsAdmin();
              if (activeTab === 'users' || activeTab === 'tutors') void loadUsers();
              if (activeTab === 'slots') void loadBookings();
              if (activeTab === 'materials') void loadMaterials();
              if (activeTab === 'tutorNotes') void loadTutorNotesAdmin();
              if (activeTab === 'logs') void loadLogs();
            }}
            disabled={isLoadingDash}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isLoadingDash ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {seedStatus && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
          <span>{seedStatus}</span>
        </div>
      )}

      {seedError && (
        <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{seedError}</span>
        </div>
      )}

      {/* Admin Sub-Navigation Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex items-center gap-1.5 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`inline-flex items-center gap-2 px-3.5 py-2 min-h-[40px] rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              activeTab === tab.id
                ? 'bg-[#0B2240] text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {isLoadingDash && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading dashboard metrics..." />
            </div>
          )}

          {dashError && !isLoadingDash && (
            <div
              role="alert"
              className="p-5 rounded-xl bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-sm text-red-800">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{dashError}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadDashboard()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {!isLoadingDash && !dashError && data && (
            <>
              <section aria-label="Summary metrics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="text-xs font-medium text-slate-500">Total requests</div>
                  <div className="mt-2 font-mono text-3xl font-semibold text-[#0B2240] tabular-nums">
                    {data.total}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="text-xs font-medium text-slate-500">Resolved by AI</div>
                  <div className="mt-2 flex items-baseline gap-2 font-mono tabular-nums">
                    <span className="text-3xl font-semibold text-[#0B2240]">{data.resolvedByAI}</span>
                    <span className="text-sm font-medium text-slate-600">
                      ({Math.round(data.percentResolvedByAI)}%)
                    </span>
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="text-xs font-medium text-slate-500">Booked with a tutor</div>
                  <div className="mt-2 font-mono text-3xl font-semibold text-[#0B2240] tabular-nums">
                    {data.bookedWithTutor}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="text-xs font-medium text-slate-500">Waitlist</div>
                  <div className="mt-2 font-mono text-3xl font-semibold text-[#0B2240] tabular-nums">
                    {data.waitlist}
                  </div>
                </div>
              </section>

              <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200">
                    <h2 className="font-display text-base font-semibold text-[#0B2240]">
                      Requests by course
                    </h2>
                  </div>
                  {courseEntries.length === 0 ? (
                    <p className="p-5 text-sm text-slate-500">No course requests recorded yet.</p>
                  ) : (
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                          <th className="py-2.5 px-5">Course</th>
                          <th className="py-2.5 px-5 text-right">Requests</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {courseEntries.map(([name, count]) => (
                          <tr key={name}>
                            <td className="py-2.5 px-5 text-xs font-medium text-slate-800">
                              {formatCourse(name)}
                            </td>
                            <td className="py-2.5 px-5 text-right font-mono font-medium text-[#0B2240] tabular-nums">
                              {count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200">
                    <h2 className="font-display text-base font-semibold text-[#0B2240]">
                      Demand by topic
                    </h2>
                  </div>
                  {topicEntries.length === 0 ? (
                    <p className="p-5 text-sm text-slate-500">No topic demand recorded yet.</p>
                  ) : (
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                          <th className="py-2.5 px-5">Topic</th>
                          <th className="py-2.5 px-5 text-right">Requests</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {topicEntries.map(([name, count]) => (
                          <tr key={name}>
                            <td className="py-2.5 px-5 text-slate-800">{name}</td>
                            <td className="py-2.5 px-5 text-right font-mono font-medium text-[#0B2240] tabular-nums">
                              {count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200">
                    <h2 className="font-display text-base font-semibold text-[#0B2240]">
                      Busiest tutors
                    </h2>
                  </div>
                  {tutorEntries.length === 0 ? (
                    <p className="p-5 text-sm text-slate-500">No tutor bookings recorded yet.</p>
                  ) : (
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                          <th className="py-2.5 px-5">Tutor</th>
                          <th className="py-2.5 px-5 text-right">Bookings</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {tutorEntries.map(([name, count]) => (
                          <tr key={name}>
                            <td className="py-2.5 px-5 text-slate-800">{name}</td>
                            <td className="py-2.5 px-5 text-right font-mono font-medium text-[#0B2240] tabular-nums">
                              {count}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>

              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                  <h2 className="font-display text-base font-semibold text-[#0B2240]">
                    Live activity
                  </h2>
                  <span className="font-mono text-xs text-slate-500 tabular-nums">
                    {recentLog.length} entries
                  </span>
                </div>
                {recentLog.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    No activity recorded yet. Student requests and bookings will appear here.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                          <th className="py-3 px-5">Date</th>
                          <th className="py-3 px-5">Course</th>
                          <th className="py-3 px-5">Activity</th>
                          <th className="py-3 px-5">Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {recentLog.map((entry: DashboardLogEntry, index: number) => (
                          <tr key={`${index}-${entry.step || 'log'}`}>
                            <td className="py-3 px-5 font-mono text-xs text-slate-600 whitespace-nowrap tabular-nums">
                              {formatDateOnly(entry.time)}
                            </td>
                            <td className="py-3 px-5 font-mono text-xs text-slate-900 whitespace-nowrap">
                              {entry.course ? formatCourse(entry.course) : '—'}
                            </td>
                            <td className="py-3 px-5 text-slate-800 whitespace-nowrap">
                              {entry.step ? entry.step.replace(/_/g, ' ') : '—'}
                            </td>
                            <td className="py-3 px-5 text-slate-700">
                              {scrubAdminMetadata(entry.detail)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}

      {/* TAB: ANALYTICS */}
      {activeTab === 'analytics' && <AdminAnalyticsPanel />}

      {/* TAB: TUTOR APPLICATIONS */}
      {activeTab === 'applications' && (
        <AdminTutorApplicationsPanel
          adminUid={adminUid || auth.currentUser?.uid || ''}
          adminEmail={auth.currentUser?.email || 'admin@sanad.demo'}
          onPendingCountChange={setPendingAppsCount}
          onApplicantPromoted={() => {
            void loadUsers();
            void loadDashboard();
          }}
        />
      )}

      {/* TAB: COURSES CRUD */}
      {activeTab === 'courses' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Manage Courses
              </h2>
              <p className="text-xs text-slate-500">
                Add, edit, activate, or deactivate courses across student help requests, sign-up, tutoring, and course materials.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowCreateCourse((prev) => !prev);
                setCourseFormError(null);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>{showCreateCourse ? 'Close form' : 'Add course'}</span>
            </button>
          </div>

          {courseActionBanner && (
            <div
              role="status"
              className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2"
            >
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>{courseActionBanner}</span>
              </span>
              <button
                type="button"
                onClick={() => setCourseActionBanner(null)}
                className="text-emerald-800 hover:text-emerald-950 cursor-pointer"
                aria-label="Dismiss notice"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {showCreateCourse && (
            <form
              onSubmit={handleCreateCourse}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <h3 className="font-display text-sm font-semibold text-[#0B2240]">
                Add New Course
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-start">
                <div>
                  <label htmlFor="new-course-code" className="block text-xs font-medium text-slate-700 mb-1">
                    Course Code
                  </label>
                  <input
                    id="new-course-code"
                    type="text"
                    value={newCourseCode}
                    onChange={(e) => {
                      setNewCourseCode(e.target.value.toUpperCase());
                      if (courseFormError) setCourseFormError(null);
                    }}
                    placeholder="e.g. CIS2113"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono uppercase"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="new-course-title" className="block text-xs font-medium text-slate-700 mb-1">
                    Course Title
                  </label>
                  <input
                    id="new-course-title"
                    type="text"
                    value={newCourseTitle}
                    onChange={(e) => {
                      setNewCourseTitle(e.target.value);
                      if (courseFormError) setCourseFormError(null);
                    }}
                    placeholder="e.g. Data Structures & Algorithms"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="new-course-dept" className="block text-xs font-medium text-slate-700 mb-1">
                    Department
                  </label>
                  <input
                    id="new-course-dept"
                    type="text"
                    value={newCourseDept}
                    onChange={(e) => setNewCourseDept(e.target.value)}
                    placeholder="e.g. Computer Information Science"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newCourseActive}
                  onChange={(e) => setNewCourseActive(e.target.checked)}
                  className="h-4 w-4 accent-[#0B2240]"
                />
                <span>Active (available to students and tutors)</span>
              </label>

              {courseFormError && (
                <p role="alert" className="text-xs text-red-700 font-medium flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{courseFormError}</span>
                </p>
              )}

              <div>
                <button
                  type="submit"
                  disabled={isSavingCourse}
                  className="px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                >
                  {isSavingCourse ? 'Saving...' : 'Save course'}
                </button>
              </div>
            </form>
          )}

          {isLoadingCourses && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading courses..." />
            </div>
          )}

          {coursesError && !isLoadingCourses && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
              <span>{coursesError}</span>
              <button
                type="button"
                onClick={() => void loadCourses()}
                className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoadingCourses && !coursesError && coursesList.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
              No courses configured yet. Click &ldquo;Add course&rdquo; above to add one.
            </div>
          )}

          {!isLoadingCourses && !coursesError && coursesList.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                    <th className="py-3 px-4">Code</th>
                    <th className="py-3 px-4">Title</th>
                    <th className="py-3 px-4">Department</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {coursesList.map((c) => {
                    const isEditing = editingCourseId === c.id;
                    return (
                      <tr key={c.id}>
                        <td className="py-3 px-4 font-mono text-xs font-semibold text-[#0B2240] whitespace-nowrap">
                          {c.code}
                        </td>
                        <td className="py-3 px-4 text-slate-900 font-medium">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editCourseTitle}
                              onChange={(e) => setEditCourseTitle(e.target.value)}
                              className="w-full min-w-[200px] px-2.5 py-1 text-xs border border-slate-300 rounded"
                            />
                          ) : (
                            c.title
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-700">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editCourseDept}
                              onChange={(e) => setEditCourseDept(e.target.value)}
                              placeholder="Department"
                              className="w-full min-w-[160px] px-2.5 py-1 text-xs border border-slate-300 rounded"
                            />
                          ) : (
                            c.department || '—'
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {isEditing ? (
                            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={editCourseActive}
                                onChange={(e) => setEditCourseActive(e.target.checked)}
                                className="h-3.5 w-3.5 accent-[#0B2240]"
                              />
                              <span>{editCourseActive ? 'Active' : 'Inactive'}</span>
                            </label>
                          ) : (
                            <span
                              className={`inline-flex px-2 py-0.5 rounded border text-[11px] font-semibold ${
                                c.active
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : 'bg-slate-100 text-slate-600 border-slate-200'
                              }`}
                            >
                              {c.active ? 'Active' : 'Inactive'}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                disabled={isSavingCourse}
                                onClick={() => void handleSaveEditCourse(c.id)}
                                className="px-2.5 py-1 text-xs font-medium text-white bg-[#0B2240] rounded cursor-pointer"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingCourseId(null)}
                                className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded cursor-pointer"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => startEditCourse(c)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                <Edit3 className="w-3 h-3" aria-hidden="true" />
                                <span>Edit</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleToggleCourseActive(c)}
                                className={`px-2.5 py-1 text-xs font-medium rounded border cursor-pointer ${
                                  c.active
                                    ? 'text-red-700 border-red-200 hover:bg-red-50'
                                    : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                                }`}
                              >
                                {c.active ? 'Deactivate' : 'Activate'}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB: STUDENT REQUESTS (WITH ATTACHMENTS) */}
      {activeTab === 'requests' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Student Help Requests
              </h2>
              <p className="text-xs text-slate-500">
                Review submitted doubts, tutor briefs, and student attachments.
              </p>
            </div>
            <button
              type="button"
              disabled={isLoadingRequests}
              onClick={() => void loadRequestsAdmin()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingRequests ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="search"
                value={reqSearch}
                onChange={(e) => setReqSearch(e.target.value)}
                placeholder="Search by student, topic, or question..."
                aria-label="Search student requests"
                className="w-full min-h-[40px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
            </div>
            <select
              value={reqCourseFilter}
              onChange={(e) => setReqCourseFilter(e.target.value)}
              aria-label="Filter requests by course"
              className="sm:w-64 min-h-[40px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
            >
              <option value="all">All courses</option>
              {allCourseCodes.map((code) => (
                <option key={code} value={code}>
                  {formatCourse(code)}
                </option>
              ))}
            </select>
          </div>

          {isLoadingRequests && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading student requests..." />
            </div>
          )}

          {requestsError && !isLoadingRequests && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
              <span>{requestsError}</span>
              <button
                type="button"
                onClick={() => void loadRequestsAdmin()}
                className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoadingRequests && !requestsError && (() => {
            const needle = reqSearch.trim().toLowerCase();
            const filtered = allRequests.filter((req) => {
              if (reqCourseFilter !== 'all' && req.course !== reqCourseFilter) return false;
              if (!needle) return true;
              return (
                (req.studentName || '').toLowerCase().includes(needle) ||
                (req.topic || '').toLowerCase().includes(needle) ||
                (req.text || '').toLowerCase().includes(needle) ||
                (req.course || '').toLowerCase().includes(needle)
              );
            });

            if (filtered.length === 0) {
              return (
                <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                  No student requests match your filter.
                </div>
              );
            }

            return (
              <div className="space-y-3">
                {filtered.map((req) => (
                  <article
                    key={req.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-semibold text-[#0B2240] bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                          {formatCourse(req.course)}
                        </span>
                        <span className="font-semibold text-slate-900">
                          {req.studentName || 'Student'}
                        </span>
                        {req.campus && <span className="text-slate-500">· {req.campus} Campus</span>}
                        {req.time && <span className="text-slate-500">· {formatDateOnly(req.time)}</span>}
                      </div>
                      <span className="px-2.5 py-0.5 rounded border text-xs font-semibold bg-slate-50 text-slate-800 border-slate-200">
                        {req.status}
                      </span>
                    </div>

                    {req.topic && (
                      <p className="text-xs font-semibold text-[#0B2240]">Topic: {req.topic}</p>
                    )}

                    {req.text && (
                      <p dir="auto" className="text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-3 leading-relaxed">
                        {req.text}
                      </p>
                    )}

                    {req.studentNote && (
                      <div className="rounded-lg bg-blue-50/60 border border-blue-200 p-3 text-xs space-y-1">
                        <p className="font-semibold text-[#0B2240]">Student notes</p>
                        <p dir="auto" className="text-slate-800 whitespace-pre-wrap leading-relaxed">
                          {req.studentNote}
                        </p>
                      </div>
                    )}

                    {req.attachments && req.attachments.length > 0 && (
                      <AttachmentList attachments={req.attachments} />
                    )}

                    {req.brief && (
                      <details className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                        <summary className="text-xs font-semibold text-[#0B2240] cursor-pointer">
                          View AI tutor brief
                        </summary>
                        <div className="mt-2 pt-2 border-t border-slate-200">
                          <FormattedText text={req.brief} />
                        </div>
                      </details>
                    )}
                  </article>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* TAB 2 & 3: USERS & TUTORS CRUD */}
      {(activeTab === 'users' || activeTab === 'tutors') && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                {activeTab === 'tutors' ? 'Manage Tutors' : 'Manage Users'}
              </h2>
              <p className="text-xs text-slate-500">
                Create, edit, and deactivate user accounts.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setNewRole(activeTab === 'tutors' ? 'tutor' : 'student');
                setShowCreateUser((prev) => !prev);
                setUserFormError(null);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>{showCreateUser ? 'Close form' : activeTab === 'tutors' ? 'Add tutor' : 'Add user'}</span>
            </button>
          </div>

          {showCreateUser && (
            <form
              onSubmit={handleCreateUser}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <h3 className="font-display text-sm font-semibold text-[#0B2240]">
                Create {activeTab === 'tutors' ? 'Tutor' : 'User'} Account
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  placeholder="Username (e.g. s16)"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                <input
                  type="password"
                  placeholder="Password (min 6 chars)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  placeholder="Full name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
                <select
                  value={newCampus}
                  onChange={(e) => setNewCampus(e.target.value)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {CAMPUSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {activeTab !== 'tutors' && (
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as AuthRole)}
                    className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="student">Student</option>
                    <option value="tutor">Tutor</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
                {(activeTab === 'tutors' || newRole === 'tutor') && (
                  <input
                    type="text"
                    placeholder="Subjects (e.g. CIS1813,CYB3513,CYB2423,CIS2903)"
                    value={newSubjects}
                    onChange={(e) => setNewSubjects(e.target.value)}
                    className="px-3 py-2 text-sm border border-slate-300 rounded-lg sm:col-span-2"
                  />
                )}
              </div>
              {userFormError && (
                <p role="alert" className="text-xs text-red-700 font-medium">
                  {userFormError}
                </p>
              )}
              <button
                type="submit"
                disabled={isSavingUser}
                className="px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
              >
                {isSavingUser ? 'Creating...' : 'Create account'}
              </button>
            </form>
          )}

          {isLoadingUsers && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading users..." />
            </div>
          )}

          {usersError && !isLoadingUsers && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
              <span>{usersError}</span>
              <button
                type="button"
                onClick={() => void loadUsers()}
                className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoadingUsers &&
            !usersError &&
            (activeTab === 'tutors' ? tutorsOnly : users).length === 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                No {activeTab === 'tutors' ? 'tutors' : 'users'} found yet. Click &ldquo;Seed Demo Accounts &amp; Data&rdquo; or create a new account above.
              </div>
            )}

          {!isLoadingUsers &&
            !usersError &&
            (activeTab === 'tutors' ? tutorsOnly : users).length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                      <th className="py-3 px-4">Name</th>
                      <th className="py-3 px-4">Role</th>
                      <th className="py-3 px-4">Campus</th>
                      {activeTab === 'tutors' && <th className="py-3 px-4">Subjects</th>}
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(activeTab === 'tutors' ? tutorsOnly : users).map((u) => {
                      const isEditing = editingUid === u.uid;
                      return (
                        <tr key={u.uid}>
                          <td className="py-3 px-4 text-slate-900 font-medium">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editUserName}
                                onChange={(e) => setEditUserName(e.target.value)}
                                className="w-40 px-2 py-1 text-xs border border-slate-300 rounded"
                              />
                            ) : (
                              u.name
                            )}
                          </td>
                          <td className="py-3 px-4 capitalize text-xs">
                            {isEditing ? (
                              <select
                                value={editUserRole}
                                onChange={(e) => setEditUserRole(e.target.value as AuthRole)}
                                className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                              >
                                <option value="student">student</option>
                                <option value="tutor">tutor</option>
                                <option value="applicant">applicant</option>
                                <option value="admin">admin</option>
                              </select>
                            ) : (
                              u.role
                            )}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-700">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editUserCampus}
                                onChange={(e) => setEditUserCampus(e.target.value)}
                                className="w-28 px-2 py-1 text-xs border border-slate-300 rounded"
                              />
                            ) : (
                              u.campus
                            )}
                          </td>
                          {activeTab === 'tutors' && (
                            <td className="py-3 px-4 text-xs text-slate-600">
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={editUserSubjects}
                                  onChange={(e) => setEditUserSubjects(e.target.value)}
                                  className="w-36 px-2 py-1 text-xs border border-slate-300 rounded font-mono"
                                />
                              ) : (
                                formatCourseList(u.subjects) || '—'
                              )}
                            </td>
                          )}
                          <td className="py-3 px-4">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded border text-[11px] font-semibold ${
                                u.active !== false
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : 'bg-red-50 text-red-800 border-red-200'
                              }`}
                            >
                              {u.active !== false ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  disabled={isSavingUser}
                                  onClick={() => void handleSaveEditUser(u.uid)}
                                  className="px-2.5 py-1 text-xs font-medium text-white bg-[#0B2240] rounded cursor-pointer"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingUid(null)}
                                  className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => startEditUser(u)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50 cursor-pointer"
                                >
                                  <Edit3 className="w-3 h-3" aria-hidden="true" />
                                  <span>Edit</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleToggleUserActive(u)}
                                  className={`px-2.5 py-1 text-xs font-medium rounded border cursor-pointer ${
                                    u.active !== false
                                      ? 'text-red-700 border-red-200 hover:bg-red-50'
                                      : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                                  }`}
                                >
                                  {u.active !== false ? 'Deactivate' : 'Activate'}
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {/* TAB 4: SLOTS & BOOKINGS */}
      {activeTab === 'slots' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Booking Calendar &amp; Tutor Slots
              </h2>
              <p className="text-xs text-slate-500">
                View scheduled sessions on the calendar, reschedule or cancel bookings, and manage tutor slots
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setBookingsViewMode('calendar')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                    bookingsViewMode === 'calendar'
                      ? 'bg-[#0B2240] text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Calendar</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBookingsViewMode('table')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                    bookingsViewMode === 'table'
                      ? 'bg-[#0B2240] text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <List className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Table</span>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateSlot((prev) => !prev)}
                className="inline-flex items-center gap-2 px-4 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>{showCreateSlot ? 'Close form' : 'Create slot'}</span>
              </button>
            </div>
          </div>

          {bookingActionBanner && (
            <div
              role="status"
              className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2"
            >
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>{bookingActionBanner}</span>
              </span>
              <button
                type="button"
                onClick={() => setBookingActionBanner(null)}
                className="text-emerald-800 hover:text-emerald-950 cursor-pointer"
                aria-label="Dismiss notice"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {showCreateSlot && (
            <form
              onSubmit={handleCreateSlot}
              className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end"
            >
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Tutor</label>
                <select
                  value={slotTutorUid}
                  onChange={(e) => setSlotTutorUid(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Select a tutor...</option>
                  {tutorsOnly.map((t) => (
                    <option key={t.uid} value={t.uid}>
                      {t.name} ({t.campus})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                <input
                  type="date"
                  value={slotDate}
                  onChange={(e) => setSlotDate(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Start</label>
                  <input
                    type="time"
                    value={slotStart}
                    onChange={(e) => setSlotStart(e.target.value)}
                    className="w-full min-h-[40px] px-2 py-1.5 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">End</label>
                  <input
                    type="time"
                    value={slotEnd}
                    onChange={(e) => setSlotEnd(e.target.value)}
                    className="w-full min-h-[40px] px-2 py-1.5 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={isSavingSlot}
                className="min-h-[40px] px-4 py-2 text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
              >
                {isSavingSlot ? 'Saving...' : 'Add slot'}
              </button>
            </form>
          )}

          {slotError && (
            <p role="alert" className="text-xs text-red-700 font-medium">
              {slotError}
            </p>
          )}

          {isLoadingBookings && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading calendar slots and bookings..." />
            </div>
          )}

          {bookingsError && !isLoadingBookings && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
              <span>{bookingsError}</span>
              <button
                type="button"
                onClick={() => void loadBookings()}
                className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoadingBookings && !bookingsError && bookingsViewMode === 'calendar' && (
            <AdminBookingCalendar
              bookings={bookings}
              tutors={tutorsOnly}
              onReschedule={openRescheduleModal}
              onCancelBooking={openCancelBookingModal}
              onToggleSlotActive={(b) => void handleToggleSlotActive(b)}
              onCreateSlotForDate={(dateIso) => {
                setSlotDate(dateIso);
                setShowCreateSlot(true);
              }}
            />
          )}

          {!isLoadingBookings && !bookingsError && bookingsViewMode === 'table' && bookings.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
              No tutor slots created yet.
            </div>
          )}

          {!isLoadingBookings && !bookingsError && bookingsViewMode === 'table' && bookings.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                    <th className="py-3 px-4">Tutor</th>
                    <th className="py-3 px-4">Campus</th>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Time</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Student</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bookings.map((b) => {
                    const isEditing = editingSlotId === b.id;
                    return (
                      <tr key={b.id}>
                        <td className="py-3 px-4 font-medium text-slate-900">{b.tutorName}</td>
                        <td className="py-3 px-4 text-xs text-slate-600">{b.campus}</td>
                        <td className="py-3 px-4 font-mono text-xs">
                          {isEditing ? (
                            <input
                              type="date"
                              value={editSlotDate}
                              onChange={(e) => setEditSlotDate(e.target.value)}
                              className="px-2 py-1 text-xs border border-slate-300 rounded"
                            />
                          ) : (
                            b.date
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs">
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="time"
                                value={editSlotStart}
                                onChange={(e) => setEditSlotStart(e.target.value)}
                                className="px-1.5 py-1 text-xs border border-slate-300 rounded"
                              />
                              <input
                                type="time"
                                value={editSlotEnd}
                                onChange={(e) => setEditSlotEnd(e.target.value)}
                                className="px-1.5 py-1 text-xs border border-slate-300 rounded"
                              />
                            </div>
                          ) : (
                            `${b.start} – ${b.end}`
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs capitalize">
                          {isEditing ? (
                            <select
                              value={editSlotStatus}
                              onChange={(e) =>
                                setEditSlotStatus(e.target.value as BookingItem['status'])
                              }
                              className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                            >
                              <option value="open">open</option>
                              <option value="inactive">inactive</option>
                              <option value="booked">booked</option>
                              <option value="completed">completed</option>
                              <option value="cancelled">cancelled</option>
                            </select>
                          ) : (
                            <div className="space-y-1">
                              <span>{b.status}</span>
                              {b.rescheduleStatus === 'requested' && (
                                <span className="block w-fit px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-900 text-[10px] font-semibold normal-case">
                                  Reschedule requested
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600">
                          <div>
                            {b.studentName || (b.status === 'booked' || b.status === 'completed' ? 'Student' : '—')}
                          </div>
                          {b.rescheduleStatus === 'requested' && b.rescheduleReason && (
                            <p className="mt-0.5 text-[11px] text-amber-900 max-w-[220px] truncate" title={b.rescheduleReason}>
                              Reason: {b.rescheduleReason}
                            </p>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                disabled={isSavingSlot}
                                onClick={() => void handleSaveEditSlot(b.id)}
                                className="px-2.5 py-1 text-xs font-medium text-white bg-[#0B2240] rounded cursor-pointer"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSlotId(null)}
                                className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded cursor-pointer"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              {(b.status === 'booked' || b.status === 'cancelled') && (
                                <button
                                  type="button"
                                  onClick={() => openRescheduleModal(b)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-[#0B2240] rounded hover:bg-[#133563] cursor-pointer"
                                >
                                  <CalendarClock className="w-3 h-3" aria-hidden="true" />
                                  <span>Reschedule</span>
                                </button>
                              )}
                              {b.status === 'booked' && (
                                <button
                                  type="button"
                                  onClick={() => openCancelBookingModal(b)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 rounded hover:bg-red-50 cursor-pointer"
                                >
                                  <XCircle className="w-3 h-3" aria-hidden="true" />
                                  <span>Cancel</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSlotId(b.id);
                                  setEditSlotDate(b.date);
                                  setEditSlotStart(b.start);
                                  setEditSlotEnd(b.end);
                                  setEditSlotStatus(b.status);
                                }}
                                className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50 cursor-pointer"
                              >
                                Edit
                              </button>
                              {(b.status === 'open' || b.status === 'inactive') && (
                                <button
                                  type="button"
                                  onClick={() => void handleToggleSlotActive(b)}
                                  className="px-2.5 py-1 text-xs font-medium text-amber-800 border border-amber-200 rounded hover:bg-amber-50 cursor-pointer"
                                >
                                  {b.status === 'inactive' ? 'Activate' : 'Deactivate'}
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Reschedule Booking Modal */}
          {rescheduleTarget && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="reschedule-modal-title"
              className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
            >
              <form
                onSubmit={handleConfirmReschedule}
                className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-xl"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 id="reschedule-modal-title" className="font-display text-lg font-bold text-[#0B2240]">
                      {rescheduleTarget.status === 'booked' || rescheduleTarget.status === 'cancelled'
                        ? 'Reschedule Booking'
                        : 'Edit Slot Time & Tutor'}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {rescheduleTarget.studentName
                        ? `${rescheduleTarget.studentName} · ${
                            rescheduleTarget.course
                              ? formatCourse(rescheduleTarget.course)
                              : 'Session'
                          }`
                        : `Slot with ${rescheduleTarget.tutorName}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRescheduleTarget(null)}
                    aria-label="Close modal"
                    className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>

                {rescheduleTarget.rescheduleStatus === 'requested' && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-950 space-y-1">
                    <p className="font-semibold text-amber-900">Student requested a reschedule</p>
                    {rescheduleTarget.rescheduleReason && (
                      <p>
                        <span className="font-medium">Reason:</span> {rescheduleTarget.rescheduleReason}
                      </p>
                    )}
                    {rescheduleTarget.reschedulePreferredWhen && (
                      <p>
                        <span className="font-medium">Preferred time:</span>{' '}
                        <span className="font-mono">{rescheduleTarget.reschedulePreferredWhen}</span>
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Assigned Tutor
                    </label>
                    <select
                      value={reschedTutorUid}
                      onChange={(e) => setReschedTutorUid(e.target.value)}
                      className="w-full min-h-[40px] px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg"
                    >
                      {tutorsOnly.map((t) => (
                        <option key={t.uid} value={t.uid}>
                          {t.name} ({t.campus})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      New Date
                    </label>
                    <input
                      type="date"
                      value={reschedDate}
                      onChange={(e) => setReschedDate(e.target.value)}
                      className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Start Time
                      </label>
                      <input
                        type="time"
                        value={reschedStart}
                        onChange={(e) => setReschedStart(e.target.value)}
                        className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        End Time
                      </label>
                      <input
                        type="time"
                        value={reschedEnd}
                        onChange={(e) => setReschedEnd(e.target.value)}
                        className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                      />
                    </div>
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
                    disabled={isRescheduling}
                    onClick={() => setRescheduleTarget(null)}
                    className="px-4 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isRescheduling}
                    className="px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                  >
                    {isRescheduling ? 'Rescheduling...' : 'Save new schedule'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Cancel Booking Modal */}
          {cancelTarget && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cancel-booking-modal-title"
              className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
            >
              <form
                onSubmit={handleConfirmCancelBooking}
                className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 shadow-xl"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 id="cancel-booking-modal-title" className="font-display text-lg font-bold text-red-900">
                      Cancel Tutor Booking
                    </h3>
                    <p className="text-xs text-slate-600 mt-0.5">
                      {cancelTarget.studentName || 'Student'} with{' '}
                      {cancelTarget.tutorName} ({cancelTarget.date} {cancelTarget.start}–{cancelTarget.end})
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCancelTarget(null)}
                    aria-label="Close modal"
                    className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Cancellation note (optional)
                  </label>
                  <input
                    type="text"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder="e.g. Tutor unavailable, student requested cancellation"
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cancelReopenSlot}
                    onChange={(e) => setCancelReopenSlot(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded accent-[#0B2240]"
                  />
                  <span>
                    Reopen this tutor time slot as <strong>open</strong> for other students (otherwise the booking is marked <strong>cancelled</strong>).
                  </span>
                </label>

                {cancelBookingError && (
                  <p role="alert" className="text-xs text-red-700 font-medium">
                    {cancelBookingError}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    disabled={isCancellingBooking}
                    onClick={() => setCancelTarget(null)}
                    className="px-4 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    Keep booking
                  </button>
                  <button
                    type="submit"
                    disabled={isCancellingBooking}
                    className="px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-red-700 rounded-lg hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                  >
                    {isCancellingBooking ? 'Cancelling...' : 'Confirm cancel booking'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* TAB 5: COURSE MATERIALS */}
      {activeTab === 'materials' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Course Materials
              </h2>
              <p className="text-xs text-slate-500">
                Upload course PDFs (slides, notes, syllabus). Max 25 MB each.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowCreateMat((prev) => !prev);
                setMatFormError(null);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>{showCreateMat ? 'Close form' : 'Add material'}</span>
            </button>
          </div>

          {matActionBanner && (
            <div
              role="status"
              className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2"
            >
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>{matActionBanner}</span>
              </span>
              <button
                type="button"
                onClick={() => setMatActionBanner(null)}
                className="text-emerald-800 hover:text-emerald-950 cursor-pointer"
                aria-label="Dismiss notice"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {showCreateMat && (
            <form
              onSubmit={handleStartUploadQueue}
              className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5"
            >
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="material-course-select"
                    className="block text-xs font-semibold text-[#0B2240] mb-1.5"
                  >
                    Course (applies to all files in this batch)
                  </label>
                  <select
                    id="material-course-select"
                    value={matCourse}
                    onChange={(e) => handleBatchCourseChange(e.target.value)}
                    className="w-full sm:max-w-md min-h-[42px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0B2240]"
                  >
                    {catalogCourses.map((code) => (
                      <option key={code} value={code}>
                        {formatCourse(code)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="material-pdf-input"
                    className="block text-xs font-semibold text-[#0B2240] mb-1.5"
                  >
                    Course PDF Files
                  </label>
                  <label
                    htmlFor="material-pdf-input"
                    onDragEnter={handleMatDragEnter}
                    onDragOver={handleMatDragOver}
                    onDragLeave={handleMatDragLeave}
                    onDrop={handleMatDrop}
                    className={`flex flex-col items-center justify-center gap-2.5 min-h-[168px] px-6 py-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors text-center ${
                      isDragOverMat
                        ? 'border-[#0B2240] bg-blue-50/90 ring-2 ring-[#0B2240]/20'
                        : 'border-slate-300 hover:border-[#0B2240] bg-slate-50/70'
                    }`}
                  >
                    <Upload
                      className={`w-8 h-8 transition-transform ${
                        isDragOverMat ? 'text-[#0B2240] scale-110' : 'text-[#0B2240]'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="text-sm sm:text-base font-semibold text-[#0B2240]">
                      Drag and drop PDFs here, or click to browse
                    </div>
                    <div className="text-xs text-slate-500">
                      Accepts multiple PDFs at once · Assigned to {formatCourse(matCourse)}
                    </div>
                    <input
                      key={fileInputKey}
                      id="material-pdf-input"
                      type="file"
                      multiple
                      accept=".pdf,application/pdf"
                      onChange={handlePdfFileChange}
                      className="sr-only"
                    />
                  </label>
                </div>

                {ignoredFilesNotice && (
                  <div
                    role="status"
                    className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-2"
                  >
                    <span className="inline-flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                      <span>{ignoredFilesNotice}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setIgnoredFilesNotice(null)}
                      aria-label="Dismiss notice"
                      className="text-amber-800 hover:text-amber-950 cursor-pointer"
                    >
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                )}

                {uploadQueue.length > 0 && (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-[#0B2240]">
                        Batch Files ({uploadQueue.length})
                      </p>
                      {uploadQueue.some((item) => item.status === 'ready' || item.status === 'failed') && (
                        <button
                          type="button"
                          onClick={clearFinishedQueueItems}
                          className="text-xs font-medium text-slate-600 hover:text-[#0B2240] cursor-pointer"
                        >
                          Clear finished
                        </button>
                      )}
                    </div>
                    <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden bg-white">
                      {uploadQueue.map((item) => {
                        const statusConfig =
                          item.status === 'processing'
                            ? {
                                label: 'Uploading',
                                classes: 'bg-amber-50 text-amber-800 border-amber-200',
                              }
                            : item.status === 'ready'
                              ? {
                                  label: 'Ready',
                                  classes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
                                }
                              : item.status === 'failed'
                                ? {
                                    label: 'Failed',
                                    classes: 'bg-red-50 text-red-800 border-red-200',
                                  }
                                : {
                                    label: 'Waiting',
                                    classes: 'bg-slate-100 text-slate-700 border-slate-200',
                                  };

                        return (
                          <div key={item.id} className="p-3.5 space-y-2 text-xs">
                            <div className="flex flex-col md:flex-row md:items-center gap-3">
                              <div className="flex items-center gap-2 min-w-0 md:w-4/12">
                                <FileText className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
                                <span className="font-medium text-slate-900 truncate" title={item.file.name}>
                                  {item.file.name}
                                </span>
                              </div>

                              <div className="flex-1">
                                <label className="sr-only" htmlFor={`topic-${item.id}`}>
                                  Topic title for {item.file.name}
                                </label>
                                <input
                                  id={`topic-${item.id}`}
                                  type="text"
                                  disabled={item.status !== 'pending'}
                                  value={item.topicTitle}
                                  onChange={(e) => updateQueueTopicTitle(item.id, e.target.value)}
                                  placeholder="Topic title (e.g. Week 1 What is AI)"
                                  className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0B2240] disabled:bg-slate-50 disabled:text-slate-600"
                                />
                              </div>

                              <div className="flex items-center justify-between md:justify-end gap-2 shrink-0">
                                <span
                                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded border text-[11px] font-semibold ${statusConfig.classes}`}
                                >
                                  {item.status === 'processing' && (
                                    <RotateCw className="w-3 h-3 animate-spin" aria-hidden="true" />
                                  )}
                                  <span>{statusConfig.label}</span>
                                </span>

                                {item.status === 'failed' && (
                                  <button
                                    type="button"
                                    onClick={() => retryQueueItem(item.id)}
                                    aria-label={`Retry ${item.file.name}`}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#0B2240] border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer"
                                  >
                                    <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
                                    <span>Retry</span>
                                  </button>
                                )}

                                <button
                                  type="button"
                                  disabled={item.status === 'processing'}
                                  onClick={() => removeQueueItem(item.id)}
                                  aria-label={`Remove ${item.file.name}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-red-50 hover:text-red-700 hover:border-red-200 disabled:opacity-40 cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                                  <span>Remove</span>
                                </button>
                              </div>
                            </div>

                            {item.status === 'failed' && item.error && (
                              <p className="text-[11px] text-red-700 pl-6">{item.error}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {matFormError && (
                <p role="alert" className="text-xs text-red-700 font-medium flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{matFormError}</span>
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={!uploadQueue.some((q) => q.status === 'pending')}
                  className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {isProcessingQueue
                      ? 'Uploading batch...'
                      : `Upload ${uploadQueue.filter((q) => q.status === 'pending').length || ''} PDF${
                          uploadQueue.filter((q) => q.status === 'pending').length === 1 ? '' : 's'
                        }`.trim()}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateMat(false);
                    setMatFormError(null);
                  }}
                  className="px-4 py-2 min-h-[40px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  {isProcessingQueue ? 'Minimize (keep uploading)' : 'Close'}
                </button>
              </div>
            </form>
          )}

          {!showCreateMat && uploadQueue.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-sm font-semibold text-[#0B2240]">
                    Upload Queue
                  </h3>
                  {isProcessingQueue && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-[11px] font-medium text-amber-800">
                      <RotateCw className="w-3 h-3 animate-spin" aria-hidden="true" />
                      <span>Uploading in background...</span>
                    </span>
                  )}
                </div>
                {uploadQueue.some((item) => item.status === 'ready' || item.status === 'failed') && (
                  <button
                    type="button"
                    onClick={clearFinishedQueueItems}
                    className="text-xs font-medium text-slate-600 hover:text-[#0B2240] cursor-pointer"
                  >
                    Clear finished
                  </button>
                )}
              </div>

              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                {uploadQueue.map((item) => {
                  const statusConfig =
                    item.status === 'processing'
                      ? {
                          label: 'Uploading',
                          classes: 'bg-amber-50 text-amber-800 border-amber-200',
                        }
                      : item.status === 'ready'
                        ? {
                            label: 'Ready',
                            classes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
                          }
                        : item.status === 'failed'
                          ? {
                              label: 'Failed',
                              classes: 'bg-red-50 text-red-800 border-red-200',
                            }
                          : {
                              label: 'Waiting',
                              classes: 'bg-slate-100 text-slate-700 border-slate-200',
                            };

                  return (
                    <div
                      key={item.id}
                      className="px-3.5 py-2.5 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 space-y-1 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                          <span className="font-medium text-slate-900 truncate">{item.file.name}</span>
                          {item.topicTitle && (
                            <span className="text-slate-600 truncate">· {item.topicTitle}</span>
                          )}
                          <span className="font-mono text-[11px] text-[#0B2240] bg-slate-100 px-2 py-0.5 rounded shrink-0">
                            {formatCourse(item.courseCode)}
                          </span>
                        </div>
                        {item.status === 'failed' && item.error && (
                          <p className="text-[11px] text-red-700">{item.error}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-semibold ${statusConfig.classes}`}
                        >
                          {item.status === 'processing' && (
                            <RotateCw className="w-3 h-3 animate-spin" aria-hidden="true" />
                          )}
                          <span>{statusConfig.label}</span>
                        </span>
                        {item.status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => retryQueueItem(item.id)}
                            aria-label={`Retry ${item.file.name}`}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-[#0B2240] hover:bg-slate-100 rounded cursor-pointer"
                          >
                            <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Retry</span>
                          </button>
                        )}
                        {item.status !== 'processing' && (
                          <button
                            type="button"
                            onClick={() => removeQueueItem(item.id)}
                            aria-label={`Remove ${item.file.name}`}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 hover:text-red-700 rounded hover:bg-red-50 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Remove</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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

          {/* Search and Course Filter Bar */}
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
                {allCourseCodes.map((code) => (
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

          {!isLoadingMaterials && !materialsError && organizedCourseSections.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
              <p className="font-display text-base font-semibold text-[#0B2240]">
                No materials match your search.
              </p>
              <p className="text-xs text-slate-500">
                Try another file name, topic, or clear the course filter.
              </p>
            </div>
          )}

          {hasLegacyEntries && !isLoadingMaterials && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
              <span>Old sample entries were found and can be removed safely.</span>
              <button
                type="button"
                disabled={isPurgingLegacy}
                onClick={() => void handlePurgeLegacyMaterials()}
                className="px-3 py-1.5 rounded-lg bg-[#0B2240] text-white font-medium hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
              >
                {isPurgingLegacy ? 'Cleaning up...' : 'Clean up old sample entries'}
              </button>
            </div>
          )}

          {!isLoadingMaterials && !materialsError && organizedCourseSections.length > 0 && (
            <div className="space-y-3">
              {organizedCourseSections.map((section) => {
                const isExpanded = Boolean(expandedCourses[section.code]);
                const fileCountLabel = `${section.filteredCount} ${
                  section.filteredCount === 1 ? 'file' : 'files'
                }`;
                const isRefreshingThisCourse = refreshingCourseCode === section.code;

                return (
                  <section
                    key={section.code}
                    aria-label={section.courseTitle}
                    className="bg-white border border-slate-200 rounded-xl overflow-hidden"
                  >
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => toggleCourseSection(section.code)}
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
                        {fileCountLabel}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-slate-200">
                        {section.totalCount > 0 && (
                          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-slate-600">
                              {isRefreshingThisCourse && courseRefreshProgress
                                ? courseRefreshProgress
                                : 'Refresh study notes if AI answers seem out of date for this course.'}
                            </span>
                            <button
                              type="button"
                              disabled={refreshingCourseCode !== null}
                              onClick={() => void handleRefreshCourseNotes(section.code)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
                            >
                              <RotateCw
                                className={`w-3.5 h-3.5 ${isRefreshingThisCourse ? 'animate-spin' : ''}`}
                                aria-hidden="true"
                              />
                              <span>
                                {isRefreshingThisCourse
                                  ? 'Refreshing...'
                                  : 'Refresh AI notes for this course'}
                              </span>
                            </button>
                          </div>
                        )}

                        {section.filteredCount === 0 ? (
                          <p className="px-5 py-6 text-sm text-slate-500 text-center">
                            No materials yet
                          </p>
                        ) : (
                          <div className="divide-y divide-slate-200">
                            {section.topicGroups.map((group) => (
                              <div key={group.label} className="bg-slate-50/40">
                                <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100">
                                  <h4 className="text-xs font-semibold text-[#0B2240]">
                                    {group.label}
                                  </h4>
                                </div>
                                <div className="divide-y divide-slate-100 bg-white">
                                  {group.items.map((mat) => {
                                    const statusBadge = getMaterialStatusBadge(mat.status);
                                    const isConfirmingDel = confirmDeleteMatId === mat.id;
                                    const isViewingThis = viewingPdf?.id === mat.id;
                                    const hasPdfBinary =
                                      mat.storageMode === 'firestore_parts' &&
                                      (mat.partCount ?? 0) > 0;
                                    const topicLabel =
                                      mat.topicTitle || deriveTopicTitleFromFileName(mat.fileName);

                                    return (
                                      <div key={mat.id} className="px-5 py-3.5 space-y-2.5">
                                        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                                          <div className="min-w-0 space-y-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <FileText
                                                className="w-4 h-4 text-slate-500 shrink-0"
                                                aria-hidden="true"
                                              />
                                              <span className="text-sm font-semibold text-slate-900 truncate">
                                                {mat.fileName}
                                              </span>
                                              <span
                                                className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold ${statusBadge.classes}`}
                                              >
                                                {statusBadge.label}
                                              </span>
                                            </div>
                                            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
                                              <span className="font-medium text-slate-700">
                                                {topicLabel}
                                              </span>
                                              <span>{formatDateOnly(mat.uploadedAt)}</span>
                                            </div>
                                            {mat.status === 'failed' && mat.errorMessage && (
                                              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 ml-6">
                                                {formatUserError(mat.errorMessage, 'Could not process this file.')}
                                              </p>
                                            )}
                                          </div>

                                          <div className="flex flex-wrap items-center gap-2 shrink-0 pl-6 lg:pl-0">
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
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium rounded-lg border bg-white text-[#0B2240] border-slate-300 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
                                              >
                                                <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                                                <span>
                                                  {loadingNotesMatId === mat.id
                                                    ? 'Loading...'
                                                    : 'View notes'}
                                                </span>
                                              </button>
                                            )}

                                            <button
                                              type="button"
                                              disabled={reprocessingId === mat.id || refreshingCourseCode !== null}
                                              onClick={() => void handleReprocessMaterial(mat)}
                                              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium text-[#0B2240] bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer disabled:opacity-50"
                                            >
                                              <RotateCw
                                                className={`w-3.5 h-3.5 ${
                                                  reprocessingId === mat.id ? 'animate-spin' : ''
                                                }`}
                                                aria-hidden="true"
                                              />
                                              <span>
                                                {reprocessingId === mat.id ? 'Reprocessing...' : 'Reprocess'}
                                              </span>
                                            </button>

                                            <button
                                              type="button"
                                              onClick={() =>
                                                setConfirmDeleteMatId(isConfirmingDel ? null : mat.id)
                                              }
                                              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                                              aria-label={`Delete material ${mat.fileName}`}
                                            >
                                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                              <span>Delete</span>
                                            </button>
                                          </div>
                                        </div>

                                        {isConfirmingDel && (
                                          <div className="ml-6 p-3 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-red-900">
                                            <span>
                                              Delete <strong>{mat.fileName}</strong>? This course file will no longer be available.
                                            </span>
                                            <div className="flex items-center gap-2 shrink-0">
                                              <button
                                                type="button"
                                                disabled={deletingMatId === mat.id}
                                                onClick={() => void handleDeleteMaterial(mat)}
                                                className="px-3 py-1.5 rounded-md bg-red-700 text-white font-medium hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                                              >
                                                {deletingMatId === mat.id ? 'Removing...' : 'Confirm delete'}
                                              </button>
                                              <button
                                                type="button"
                                                disabled={deletingMatId === mat.id}
                                                onClick={() => setConfirmDeleteMatId(null)}
                                                className="px-3 py-1.5 rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
                                              >
                                                Cancel
                                              </button>
                                            </div>
                                          </div>
                                        )}
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
          )}
        </div>
      )}

      {/* TAB: TUTOR NOTES MODERATION (READ-ONLY + DELETE) */}
      {activeTab === 'tutorNotes' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                Tutor Notes &amp; Messages
              </h2>
              <p className="text-xs text-slate-500">
                Review notes sent by tutors to students or courses, view read counts and replies, or remove posts.
              </p>
            </div>
            <button
              type="button"
              disabled={isLoadingTutorNotes}
              onClick={() => void loadTutorNotesAdmin()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingTutorNotes ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>

          {tutorNotesBanner && (
            <div
              role="status"
              className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2"
            >
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                <span>{tutorNotesBanner}</span>
              </span>
              <button
                type="button"
                onClick={() => setTutorNotesBanner(null)}
                aria-label="Dismiss notice"
                className="text-emerald-800 hover:text-emerald-950 cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="search"
                value={tutorNoteSearch}
                onChange={(e) => setTutorNoteSearch(e.target.value)}
                placeholder="Search by title, message, tutor, or student..."
                aria-label="Search tutor notes"
                className="w-full min-h-[40px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
            </div>
            <select
              value={tutorNoteCourseFilter}
              onChange={(e) => setTutorNoteCourseFilter(e.target.value)}
              aria-label="Filter tutor notes by course"
              className="sm:w-64 min-h-[40px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
            >
              <option value="all">All courses</option>
              {Array.from(
                new Set([...allCourseCodes, ...tutorNotes.map((n) => n.courseCode)])
              ).map((code) => (
                <option key={code} value={code}>
                  {formatCourse(code)}
                </option>
              ))}
            </select>
          </div>

          {isLoadingTutorNotes && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading tutor notes..." />
            </div>
          )}

          {tutorNotesError && !isLoadingTutorNotes && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
              <span>{tutorNotesError}</span>
              <button
                type="button"
                onClick={() => void loadTutorNotesAdmin()}
                className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoadingTutorNotes && !tutorNotesError && (() => {
            const needle = tutorNoteSearch.trim().toLowerCase();
            const filtered = tutorNotes.filter((note) => {
              if (tutorNoteCourseFilter !== 'all' && note.courseCode !== tutorNoteCourseFilter) {
                return false;
              }
              if (!needle) return true;
              return (
                note.title.toLowerCase().includes(needle) ||
                note.body.toLowerCase().includes(needle) ||
                note.tutorName.toLowerCase().includes(needle) ||
                (note.studentName || '').toLowerCase().includes(needle) ||
                formatCourse(note.courseCode).toLowerCase().includes(needle)
              );
            });

            if (filtered.length === 0) {
              return (
                <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                  No tutor notes match your filter.
                </div>
              );
            }

            return (
              <div className="space-y-3">
                {filtered.map((note) => {
                  const isConfirming = confirmDeleteTutorNoteId === note.id;
                  return (
                    <article
                      key={note.id}
                      className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-2 border-b border-slate-100">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-semibold text-[#0B2240] bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                              {formatCourse(note.courseCode)}
                            </span>
                            <span className="font-semibold text-slate-900">
                              From: {note.tutorName}
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
                          <p className="text-xs text-slate-500">{formatDateOnly(note.createdAt)}</p>
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            setConfirmDeleteTutorNoteId(isConfirming ? null : note.id)
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Delete</span>
                        </button>
                      </div>

                      {isConfirming && (
                        <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-red-900">
                          <span>
                            Delete <strong>{note.title}</strong>? Students will no longer see this post.
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={deletingTutorNoteId === note.id}
                              onClick={() => void handleDeleteTutorNoteAdmin(note)}
                              className="px-3 py-1.5 rounded-md bg-red-700 text-white font-medium hover:bg-red-800 disabled:opacity-50 cursor-pointer"
                            >
                              {deletingTutorNoteId === note.id ? 'Deleting...' : 'Confirm delete'}
                            </button>
                            <button
                              type="button"
                              disabled={deletingTutorNoteId === note.id}
                              onClick={() => setConfirmDeleteTutorNoteId(null)}
                              className="px-3 py-1.5 rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      <p
                        dir="auto"
                        className="text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-3.5 leading-relaxed whitespace-pre-wrap"
                      >
                        {note.body}
                      </p>

                      {note.attachments && note.attachments.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-semibold text-slate-700">
                            Attachments ({note.attachments.length})
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {note.attachments.map((att) => (
                              <div
                                key={att.id}
                                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs"
                              >
                                {att.mimeType === 'application/pdf' ? (
                                  <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                                ) : (
                                  <ImageIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                                )}
                                <span className="font-medium text-slate-800 max-w-[180px] truncate">
                                  {att.fileName}
                                </span>
                                <button
                                  type="button"
                                  disabled={busyNoteAttachmentId === att.id}
                                  onClick={() =>
                                    void handleOpenTutorNoteAttachmentAdmin(note.id, att, false)
                                  }
                                  className="text-[#0B2240] font-medium hover:underline cursor-pointer disabled:opacity-50"
                                >
                                  View
                                </button>
                                <button
                                  type="button"
                                  disabled={busyNoteAttachmentId === att.id}
                                  onClick={() =>
                                    void handleOpenTutorNoteAttachmentAdmin(note.id, att, true)
                                  }
                                  className="text-slate-600 font-medium hover:underline cursor-pointer disabled:opacity-50"
                                >
                                  Download
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {note.replies && note.replies.length > 0 && (
                        <div className="pt-2 border-t border-slate-100 space-y-2">
                          <p className="text-xs font-semibold text-slate-700">
                            Replies ({note.replies.length})
                          </p>
                          <div className="space-y-1.5">
                            {note.replies.map((rep) => (
                              <div
                                key={rep.id}
                                className={`rounded-lg px-3 py-2 text-xs border ${
                                  rep.authorRole === 'tutor'
                                    ? 'bg-slate-50 border-slate-200'
                                    : 'bg-blue-50/60 border-blue-200'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 mb-0.5">
                                  <span className="font-semibold text-slate-800">
                                    {rep.authorName} ({rep.authorRole})
                                  </span>
                                  <span>{formatDateOnly(rep.createdAt)}</span>
                                </div>
                                <p dir="auto" className="text-slate-800 whitespace-pre-wrap">
                                  {rep.text}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* TAB 6: USAGE LOGS */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          <h2 className="font-display text-lg font-semibold text-[#0B2240]">
            System Usage Logs
          </h2>

          {isLoadingLogs && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <Spinner label="Loading usage logs..." />
            </div>
          )}

          {logsError && !isLoadingLogs && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
              <span>{logsError}</span>
              <button
                type="button"
                onClick={() => void loadLogs()}
                className="px-3.5 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoadingLogs && !logsError && usageLogs.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
              No usage logs recorded yet.
            </div>
          )}

          {!isLoadingLogs && !logsError && usageLogs.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4">Action</th>
                    <th className="py-3 px-4">Course</th>
                    <th className="py-3 px-4">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {usageLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="py-3 px-4 font-mono text-xs text-slate-600 whitespace-nowrap tabular-nums">
                        {formatDateOnly(log.createdAt)}
                      </td>
                      <td className="py-3 px-4 text-xs capitalize text-slate-700">{log.actorRole}</td>
                      <td className="py-3 px-4 font-mono text-xs text-[#0B2240]">
                        {log.action.replace(/_/g, ' ')}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-600">
                        {log.course ? formatCourse(log.course) : '—'}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700">
                        {scrubAdminMetadata(log.detail)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
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
