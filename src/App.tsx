import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  Bookmark,
  Calendar,
  Clock,
  GraduationCap,
  HelpCircle,
  Home,
  LayoutDashboard,
  LogOut,
  Mail,
  PhoneCall,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import {
  fetchCourseRecords,
  fetchCryptoStatus,
  fetchPublicCourses,
  fetchStudentUnreadTutorNotesCount,
  resolveUserSession,
  signOutSanadUser,
} from './api';
import { formatCourseList, normalizeCourseCode } from './courses';
import { CoordinatorDashboard } from './components/CoordinatorDashboard';
import { Footer } from './components/Footer';
import { HumanSupportModal } from './components/HumanSupportModal';
import { LoginPage } from './components/LoginPage';
import { SanadLogo } from './components/SanadLogo';
import { Spinner } from './components/Spinner';
import { StudentHome } from './components/StudentHome';
import { StudentSavedAnswersPage } from './components/StudentSavedAnswersPage';
import { StudentTutorNotesPage } from './components/StudentTutorNotesPage';
import { StudentWorkspace } from './components/StudentWorkspace';
import {
  TutorApplicationPortal,
  TutorApplicationRegistration,
} from './components/TutorApplicationPortal';
import { TutorWorkspace } from './components/TutorWorkspace';
import { auth } from './firebase';
import type { AuthRole, AuthSession, Student, StudentResumeContext } from './types';

type StudentView = 'home' | 'notes' | 'saved' | 'ask' | 'apply';

function getRoleLabel(role: AuthRole): 'Student' | 'Tutor' | 'Admin' | 'Applicant' {
  switch (role) {
    case 'student':
      return 'Student';
    case 'tutor':
      return 'Tutor';
    case 'admin':
      return 'Admin';
    case 'applicant':
      return 'Applicant';
  }
}

function getRoleBadgeClasses(role: AuthRole, onDarkBg: boolean): string {
  if (onDarkBg) {
    switch (role) {
      case 'student':
        return 'bg-blue-400/20 text-blue-100 border-blue-300/30';
      case 'tutor':
        return 'bg-emerald-400/20 text-emerald-100 border-emerald-300/30';
      case 'admin':
        return 'bg-amber-400/20 text-amber-100 border-amber-300/30';
      case 'applicant':
        return 'bg-purple-400/20 text-purple-100 border-purple-300/30';
    }
  }
  switch (role) {
    case 'student':
      return 'bg-blue-50 text-blue-800 border-blue-200';
    case 'tutor':
      return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    case 'admin':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    case 'applicant':
      return 'bg-purple-50 text-purple-800 border-purple-200';
  }
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [showTutorRegistration, setShowTutorRegistration] = useState(false);
  const [encryptionConfigured, setEncryptionConfigured] = useState<boolean | null>(null);
  const [studentView, setStudentView] = useState<StudentView>('home');
  const [resumeContext, setResumeContext] = useState<StudentResumeContext | null>(null);
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [unreadTutorNotesCount, setUnreadTutorNotesCount] = useState(0);
  const [isHumanModalOpen, setIsHumanModalOpen] = useState(false);

  useEffect(() => {
    void fetchCryptoStatus().then(setEncryptionConfigured);
    void fetchPublicCourses();

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setSession(null);
        setIsAuthReady(true);
        void fetchPublicCourses();
        return;
      }
      try {
        const [resolved] = await Promise.all([
          resolveUserSession(firebaseUser),
          fetchCourseRecords(false).catch(() => []),
        ]);
        setSession(resolved);
      } catch {
        setSession(null);
      } finally {
        setIsAuthReady(true);
      }
    });

    return () => unsubscribe();
  }, []);

  const studentEnrolledCourses =
    session?.role === 'student' && session.profile?.subjects
      ? session.profile.subjects
          .split(',')
          .map((c) => normalizeCourseCode(c))
          .filter(Boolean)
      : [];
  const enrolledCoursesKey = studentEnrolledCourses.join(',');

  useEffect(() => {
    if (!session || session.role !== 'student') {
      setUnreadTutorNotesCount(0);
      return;
    }
    let cancelled = false;
    const coursesList = enrolledCoursesKey ? enrolledCoursesKey.split(',') : [];
    void fetchStudentUnreadTutorNotesCount(session.uid, coursesList)
      .then((count) => {
        if (!cancelled) setUnreadTutorNotesCount(count);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session?.uid, session?.role, enrolledCoursesKey, homeRefreshKey]);

  const handleLoginSuccess = (newSession: AuthSession) => {
    setSession(newSession);
    setShowTutorRegistration(false);
    setResumeContext(null);
    setStudentView('home');
    setHomeRefreshKey((prev) => prev + 1);
  };

  const handleRefreshSession = async () => {
    if (!auth.currentUser) return;
    try {
      const refreshed = await resolveUserSession(auth.currentUser);
      setSession(refreshed);
    } catch {
      // Ignore refresh failure
    }
  };

  const handleSignOut = async () => {
    await signOutSanadUser();
    setSession(null);
    setShowTutorRegistration(false);
    setResumeContext(null);
    setStudentView('home');
  };

  const handleBackToStudentHome = () => {
    setResumeContext(null);
    setStudentView('home');
    setHomeRefreshKey((prev) => prev + 1);
  };

  const handleResumeRequest = (context: StudentResumeContext) => {
    setResumeContext(context);
    setStudentView('ask');
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] p-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <Spinner label="Connecting to Sanad portal..." />
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        {showTutorRegistration ? (
          <TutorApplicationRegistration
            onRegistered={handleLoginSuccess}
            onBackToLogin={() => setShowTutorRegistration(false)}
            onOpenHumanSupport={() => setIsHumanModalOpen(true)}
          />
        ) : (
          <LoginPage
            onLoginSuccess={handleLoginSuccess}
            onOpenHumanSupport={() => setIsHumanModalOpen(true)}
            onOpenTutorApply={() => setShowTutorRegistration(true)}
            encryptionConfigured={encryptionConfigured}
          />
        )}
        <HumanSupportModal
          isOpen={isHumanModalOpen}
          onClose={() => setIsHumanModalOpen(false)}
        />
      </>
    );
  }

  const roleLabel = getRoleLabel(session.role);
  const displayName = session.name || session.profile?.name || session.username;
  const userCampus = session.campus || session.profile?.campus;
  const userEmail = session.email || session.profile?.email || '';

  const isPendingOrRejectedTutor =
    session.role === 'tutor' && session.profile?.active === false;

  const studentProfile: Student = {
    id: session.uid,
    name: displayName,
    campus: userCampus || 'Fujairah',
    email: userEmail,
    sheetEmail: session.profile?.sheetEmail,
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#F8FAFC] text-slate-900">
      {/* Desktop Left Sidebar */}
      <aside className="hidden md:flex md:w-64 md:shrink-0 md:flex-col md:sticky md:top-0 md:h-screen bg-[#0B2240] text-white border-r border-white/10">
        <div className="px-5 py-5 border-b border-white/10">
          <SanadLogo variant="dark" showSubtitle />
        </div>

        <nav aria-label="Portal navigation" className="flex-1 px-3 py-5 space-y-1.5 overflow-y-auto">
          {session.role === 'student' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setResumeContext(null);
                  setStudentView('home');
                  setHomeRefreshKey((prev) => prev + 1);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  studentView === 'home'
                    ? 'bg-white text-[#0B2240]'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Home className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Home</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setResumeContext(null);
                  setStudentView('notes');
                }}
                className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  studentView === 'notes'
                    ? 'bg-white text-[#0B2240]'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Mail className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Tutor Notes</span>
                </span>
                {unreadTutorNotesCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold rounded-full bg-amber-500 text-white tabular-nums">
                    {unreadTutorNotesCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setResumeContext(null);
                  setStudentView('saved');
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  studentView === 'saved'
                    ? 'bg-white text-[#0B2240]'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Bookmark className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Saved answers</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setResumeContext(null);
                  setStudentView('ask');
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  studentView === 'ask'
                    ? 'bg-white text-[#0B2240]'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <HelpCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Ask for help</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setResumeContext(null);
                  setStudentView('apply');
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  studentView === 'apply'
                    ? 'bg-white text-[#0B2240]'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <GraduationCap className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Become a Tutor</span>
              </button>
            </>
          )}

          {session.role === 'applicant' && (
            <button
              type="button"
              className="w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-white text-[#0B2240] cursor-default"
            >
              <GraduationCap className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Tutor Application</span>
            </button>
          )}

          {session.role === 'tutor' && (
            <button
              type="button"
              className="w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-white text-[#0B2240] cursor-default"
            >
              <Calendar className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{isPendingOrRejectedTutor ? 'Tutor Status' : 'My Sessions'}</span>
            </button>
          )}

          {session.role === 'admin' && (
            <button
              type="button"
              className="w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium bg-white text-[#0B2240] cursor-default"
            >
              <LayoutDashboard className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>ASC Coordinator</span>
            </button>
          )}
        </nav>

        {/* Bottom Sidebar User Info & Support */}
        <div className="p-4 border-t border-white/10 space-y-3">
          <button
            type="button"
            onClick={() => setIsHumanModalOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2.5 min-h-[40px] text-xs font-medium text-white bg-white/10 border border-white/15 rounded-lg hover:bg-white/20 transition-colors cursor-pointer"
          >
            <PhoneCall className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Talk to a human</span>
          </button>

          <div className="rounded-lg bg-white/5 border border-white/10 p-3 space-y-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">{displayName}</p>
                {userCampus && (
                  <p className="text-xs text-slate-300 truncate">{userCampus} Campus</p>
                )}
              </div>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold shrink-0 ${getRoleBadgeClasses(
                  session.role,
                  true
                )}`}
              >
                {roleLabel}
              </span>
            </div>

            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 min-h-[38px] text-xs font-medium text-slate-100 bg-white/10 hover:bg-white/20 rounded-md transition-colors cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        {/* Mobile Top Bar + Desktop Header Strip */}
        <header className="sticky top-0 z-30 bg-[#0B2240] md:bg-white text-white md:text-slate-900 border-b border-white/10 md:border-slate-200">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
            {/* Mobile Logo / Desktop Portal Label */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="md:hidden">
                <SanadLogo variant="dark" />
              </div>
              <div className="hidden md:flex items-center gap-2 text-sm text-slate-600 min-w-0">
                <span className="font-display font-semibold text-[#0B2240] whitespace-nowrap">
                  HCT Academic Success Center
                </span>
                {userCampus && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span className="truncate">{userCampus} Campus</span>
                  </>
                )}
              </div>
            </div>

            {/* Header Right: Name, Role Badge, Talk to a human, Sign out */}
            <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
              <div className="hidden sm:flex items-center gap-2">
                <span className="text-sm font-medium text-white md:text-slate-800 whitespace-nowrap">
                  {displayName}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold whitespace-nowrap md:inline-flex hidden ${getRoleBadgeClasses(
                    session.role,
                    false
                  )}`}
                >
                  {roleLabel}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold whitespace-nowrap md:hidden ${getRoleBadgeClasses(
                    session.role,
                    true
                  )}`}
                >
                  {roleLabel}
                </span>
              </div>

              <button
                type="button"
                onClick={() => setIsHumanModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] text-xs sm:text-sm font-medium text-[#0B2240] bg-white md:bg-slate-50 md:border md:border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <PhoneCall className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">Talk to a human</span>
                <span className="sm:hidden">ASC</span>
              </button>

              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] text-xs sm:text-sm font-medium text-white md:text-slate-700 bg-white/10 md:bg-white border border-white/20 md:border-slate-300 rounded-lg hover:bg-white/20 md:hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </div>
          </div>

          {/* Mobile Role Navigation Bar */}
          <div className="md:hidden bg-white text-slate-900 border-t border-slate-200 px-4 py-2 flex items-center justify-between gap-2 overflow-x-auto">
            <div className="flex items-center gap-2 shrink-0">
              {session.role === 'student' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeContext(null);
                      setStudentView('home');
                      setHomeRefreshKey((prev) => prev + 1);
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                      studentView === 'home'
                        ? 'bg-[#0B2240] text-white'
                        : 'text-slate-600 hover:text-slate-900 bg-slate-100'
                    }`}
                  >
                    <Home className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Home</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeContext(null);
                      setStudentView('notes');
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                      studentView === 'notes'
                        ? 'bg-[#0B2240] text-white'
                        : 'text-slate-600 hover:text-slate-900 bg-slate-100'
                    }`}
                  >
                    <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Tutor Notes</span>
                    {unreadTutorNotesCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[11px] font-semibold rounded-full bg-amber-500 text-white tabular-nums">
                        {unreadTutorNotesCount}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeContext(null);
                      setStudentView('saved');
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                      studentView === 'saved'
                        ? 'bg-[#0B2240] text-white'
                        : 'text-slate-600 hover:text-slate-900 bg-slate-100'
                    }`}
                  >
                    <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Saved answers</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeContext(null);
                      setStudentView('ask');
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                      studentView === 'ask'
                        ? 'bg-[#0B2240] text-white'
                        : 'text-slate-600 hover:text-slate-900 bg-slate-100'
                    }`}
                  >
                    <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Ask for help</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeContext(null);
                      setStudentView('apply');
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                      studentView === 'apply'
                        ? 'bg-[#0B2240] text-white'
                        : 'text-slate-600 hover:text-slate-900 bg-slate-100'
                    }`}
                  >
                    <GraduationCap className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Become a Tutor</span>
                  </button>
                </>
              )}

              {session.role === 'applicant' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#0B2240] text-white whitespace-nowrap shrink-0">
                  <GraduationCap className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Tutor Application</span>
                </span>
              )}

              {session.role === 'tutor' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#0B2240] text-white whitespace-nowrap shrink-0">
                  <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{isPendingOrRejectedTutor ? 'Tutor Status' : 'My Sessions'}</span>
                </span>
              )}

              {session.role === 'admin' && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#0B2240] text-white whitespace-nowrap shrink-0">
                  <LayoutDashboard className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>ASC Coordinator</span>
                </span>
              )}
            </div>

            <div className="sm:hidden flex items-center gap-1.5 shrink-0 text-xs">
              <span className="font-medium text-slate-800 truncate max-w-[110px]">
                {displayName}
              </span>
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${getRoleBadgeClasses(
                  session.role,
                  false
                )}`}
              >
                {roleLabel}
              </span>
            </div>
          </div>
        </header>

        <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {encryptionConfigured === false && (
            <div
              role="status"
              className="mb-6 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900"
            >
              <strong>Portal setup pending:</strong> Please contact an administrator to finish server configuration before creating new records.
            </div>
          )}

          {session.role === 'student' && studentView === 'home' && (
            <StudentHome
              key={homeRefreshKey}
              studentUid={session.uid}
              studentName={displayName}
              studentCampus={userCampus}
              unreadTutorNotesCount={unreadTutorNotesCount}
              onAskForHelp={() => {
                setResumeContext(null);
                setStudentView('ask');
              }}
              onOpenTutorNotes={() => {
                setResumeContext(null);
                setStudentView('notes');
              }}
              onOpenSavedAnswers={() => {
                setResumeContext(null);
                setStudentView('saved');
              }}
              onResumeRequest={handleResumeRequest}
              onOpenHumanSupport={() => setIsHumanModalOpen(true)}
            />
          )}

          {session.role === 'student' && studentView === 'notes' && (
            <StudentTutorNotesPage
              studentUid={session.uid}
              studentName={displayName}
              enrolledCourses={studentEnrolledCourses}
              onBackToHome={handleBackToStudentHome}
              onUnreadCountChange={setUnreadTutorNotesCount}
            />
          )}

          {session.role === 'student' && studentView === 'saved' && (
            <StudentSavedAnswersPage
              studentUid={session.uid}
              onAskForHelp={() => {
                setResumeContext(null);
                setStudentView('ask');
              }}
            />
          )}

          {session.role === 'student' && studentView === 'ask' && (
            <StudentWorkspace
              key={resumeContext ? `resume-${resumeContext.request.id}-${resumeContext.startStage || 'auto'}` : 'new-ask'}
              student={studentProfile}
              resumeContext={resumeContext}
              onBackToHome={handleBackToStudentHome}
              onOpenHumanSupport={() => setIsHumanModalOpen(true)}
            />
          )}

          {session.role === 'student' && studentView === 'apply' && (
            <TutorApplicationPortal
              session={session}
              onRefreshSession={handleRefreshSession}
              onBack={handleBackToStudentHome}
            />
          )}

          {session.role === 'applicant' && (
            <TutorApplicationPortal
              session={session}
              onRefreshSession={handleRefreshSession}
            />
          )}

          {session.role === 'tutor' && isPendingOrRejectedTutor && (
            <section
              aria-label="Tutor review status"
              className="max-w-2xl mx-auto bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5"
            >
              <div className="flex items-start gap-3">
                <div
                  className={`p-2.5 rounded-lg border shrink-0 ${
                    session.profile?.status === 'rejected'
                      ? 'bg-red-50 border-red-200 text-red-700'
                      : 'bg-amber-50 border-amber-200 text-amber-800'
                  }`}
                >
                  {session.profile?.status === 'rejected' ? (
                    <XCircle className="w-5 h-5" aria-hidden="true" />
                  ) : (
                    <Clock className="w-5 h-5" aria-hidden="true" />
                  )}
                </div>
                <div className="space-y-1">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-semibold ${
                      session.profile?.status === 'rejected'
                        ? 'bg-red-50 text-red-800 border-red-200'
                        : 'bg-amber-50 text-amber-800 border-amber-200'
                    }`}
                  >
                    {session.profile?.status === 'rejected' ? 'Not approved' : 'Pending review'}
                  </span>
                  <h1 className="font-display text-xl sm:text-2xl font-bold text-[#0B2240]">
                    {session.profile?.status === 'rejected'
                      ? 'Your tutor application was not approved'
                      : 'Your application is pending review'}
                  </h1>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    {session.profile?.status === 'rejected'
                      ? 'Please contact the Academic Success Center coordinator if you would like more details or wish to update your courses.'
                      : 'The Academic Success Center coordinator will review your application and activate your tutoring workspace shortly. You can refresh your status anytime.'}
                  </p>
                </div>
              </div>

              {session.profile?.subjects && (
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-xs space-y-1">
                  <p className="font-semibold text-[#0B2240]">Selected courses</p>
                  <p className="text-slate-700">{formatCourseList(session.profile.subjects)}</p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => void handleRefreshSession()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  <span>Refresh status</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsHumanModalOpen(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[42px] text-sm font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  <PhoneCall className="w-4 h-4" aria-hidden="true" />
                  <span>Talk to a human</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[42px] text-sm font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer"
                >
                  <LogOut className="w-4 h-4" aria-hidden="true" />
                  <span>Sign out</span>
                </button>
              </div>
            </section>
          )}

          {session.role === 'tutor' && !isPendingOrRejectedTutor && (
            <TutorWorkspace
              tutorUid={session.uid}
              tutorRefId={session.refId}
              tutorName={displayName}
              tutorCampus={userCampus}
              tutorSubjects={session.profile?.subjects}
              onSubjectsUpdated={(nextSubjects) =>
                setSession((prev) =>
                  prev
                    ? {
                        ...prev,
                        profile: { ...prev.profile, subjects: nextSubjects },
                      }
                    : prev
                )
              }
              onOpenHumanSupport={() => setIsHumanModalOpen(true)}
            />
          )}

          {session.role === 'admin' && <CoordinatorDashboard adminUid={session.uid} />}
        </main>

        <Footer onOpenHumanSupport={() => setIsHumanModalOpen(true)} />
      </div>

      <HumanSupportModal
        isOpen={isHumanModalOpen}
        onClose={() => setIsHumanModalOpen(false)}
        campus={userCampus}
        email={userEmail}
      />
    </div>
  );
}
