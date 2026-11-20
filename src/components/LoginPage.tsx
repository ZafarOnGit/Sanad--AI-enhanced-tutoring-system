import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Building2,
  ExternalLink,
  Eye,
  EyeOff,
  GraduationCap,
  Lock,
  Mail,
  PhoneCall,
  RefreshCw,
  User,
  UserCheck,
} from 'lucide-react';
import {
  AuthConfigError,
  DatabaseError,
  fetchPublicCourses,
  signInSanadUser,
  signUpSanadAccount,
} from '../api';
import { formatUserError } from '../firebase';
import type { AuthSession, FirestoreCourse } from '../types';
import { Footer } from './Footer';
import { SanadLogo } from './SanadLogo';
import { Spinner } from './Spinner';

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

interface LoginPageProps {
  onLoginSuccess: (session: AuthSession) => void;
  onOpenHumanSupport: () => void;
  onOpenTutorApply: () => void;
  encryptionConfigured: boolean | null;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  onOpenHumanSupport,
  onOpenTutorApply,
  encryptionConfigured,
}) => {
  const [authTab, setAuthTab] = useState<'signin' | 'signup'>('signin');

  // Sign in state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Sign up state
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [signupCampus, setSignupCampus] = useState('Fujairah');
  const [signupRole, setSignupRole] = useState<'student' | 'tutor'>('student');
  const [availableCourses, setAvailableCourses] = useState<FirestoreCourse[]>([]);
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);

  const [validationError, setValidationError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [configGuide, setConfigGuide] = useState<string | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    void fetchPublicCourses()
      .then((courses) => setAvailableCourses(courses))
      .catch(() => undefined);
  }, []);

  const switchTab = (nextTab: 'signin' | 'signup') => {
    setAuthTab(nextTab);
    setValidationError(null);
    setAuthError(null);
    setConfigGuide(null);
    setDbError(null);
  };

  const toggleSignupCourse = (code: string) => {
    setSelectedCourses((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const performLogin = async () => {
    const trimmedUser = username.trim();
    const trimmedPass = password.trim();

    if (!trimmedUser || !trimmedPass) {
      setValidationError('Please enter both email/username and password.');
      setAuthError(null);
      setConfigGuide(null);
      setDbError(null);
      return;
    }

    setValidationError(null);
    setAuthError(null);
    setConfigGuide(null);
    setDbError(null);
    setIsSubmitting(true);

    try {
      const session = await signInSanadUser(trimmedUser, trimmedPass);
      onLoginSuccess(session);
    } catch (err) {
      if (err instanceof AuthConfigError) {
        setConfigGuide(err.message);
      } else if (err instanceof DatabaseError) {
        setDbError(formatUserError(err, 'Could not reach Sanad right now. Please try again.'));
      } else {
        setAuthError(formatUserError(err, 'Wrong username or password'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const performSignUp = async () => {
    const cleanName = signupName.trim();
    const cleanEmail = signupEmail.trim();

    if (!cleanName) {
      setValidationError('Please enter your full name.');
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setValidationError('Please enter a valid email address.');
      return;
    }
    if (signupPassword.length < 8) {
      setValidationError('Password must be at least 8 characters.');
      return;
    }
    if (signupPassword !== signupConfirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }
    if (signupRole === 'student' && availableCourses.length > 0 && selectedCourses.length === 0) {
      setValidationError('Please select at least one enrolled course.');
      return;
    }

    setValidationError(null);
    setAuthError(null);
    setConfigGuide(null);
    setDbError(null);
    setIsSubmitting(true);

    try {
      const session = await signUpSanadAccount({
        name: cleanName,
        email: cleanEmail,
        password: signupPassword,
        role: signupRole,
        campus: signupCampus,
        courses: selectedCourses,
      });
      onLoginSuccess(session);
    } catch (err) {
      if (err instanceof AuthConfigError) {
        setConfigGuide(err.message);
      } else if (err instanceof DatabaseError) {
        setDbError(formatUserError(err, 'Could not reach Sanad right now. Please try again.'));
      } else {
        setAuthError(formatUserError(err, 'Could not create your account. Please try again.'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignInSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void performLogin();
  };

  const handleSignUpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void performSignUp();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-slate-900">
      <header className="bg-[#0B2240] text-white border-b border-white/10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <SanadLogo variant="dark" />
          <button
            type="button"
            onClick={onOpenHumanSupport}
            className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium text-[#0B2240] bg-white rounded-lg hover:bg-slate-100 active:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <PhoneCall className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Talk to a human</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10 sm:py-14">
        <div className={`w-full ${authTab === 'signup' ? 'max-w-lg' : 'max-w-md'} space-y-5`}>
          {encryptionConfigured === false && (
            <div
              role="status"
              className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900 space-y-1"
            >
              <p className="font-semibold">Portal setup incomplete</p>
              <p>
                Please contact an administrator to complete portal setup before submitting new requests or notes.
              </p>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 sm:p-8 space-y-6">
            <div className="space-y-3">
              <SanadLogo variant="light" />
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold text-[#0B2240] tracking-tight">
                  Sanad – HCT Academic Success Center
                </h1>
                <p className="mt-1 text-sm text-slate-600">
                  {authTab === 'signin'
                    ? 'Sign in with your Sanad email or username.'
                    : 'Create your student or tutor account.'}
                </p>
              </div>
            </div>

            {/* Sign in / Sign up Tabs */}
            <div
              role="tablist"
              aria-label="Authentication mode"
              className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200"
            >
              <button
                type="button"
                role="tab"
                aria-selected={authTab === 'signin'}
                onClick={() => switchTab('signin')}
                className={`py-2 text-sm font-semibold rounded-md transition-colors cursor-pointer ${
                  authTab === 'signin'
                    ? 'bg-white text-[#0B2240] shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authTab === 'signup'}
                onClick={() => switchTab('signup')}
                className={`py-2 text-sm font-semibold rounded-md transition-colors cursor-pointer ${
                  authTab === 'signup'
                    ? 'bg-white text-[#0B2240] shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign up
              </button>
            </div>

            {authTab === 'signin' ? (
              <>
                <form onSubmit={handleSignInSubmit} noValidate className="space-y-4">
                  <div>
                    <label
                      htmlFor="login-username"
                      className="block text-sm font-medium text-slate-800 mb-1.5"
                    >
                      Email or Username
                    </label>
                    <div className="relative">
                      <Mail
                        className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="login-username"
                        type="text"
                        autoComplete="username"
                        disabled={isSubmitting}
                        value={username}
                        onChange={(e) => {
                          setUsername(e.target.value);
                          if (validationError) setValidationError(null);
                          if (authError) setAuthError(null);
                        }}
                        placeholder="e.g. s1 or name@hct.ac.ae"
                        className="w-full min-h-[44px] pl-10 pr-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B2240] focus:border-[#0B2240] disabled:bg-slate-50"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="login-password"
                      className="block text-sm font-medium text-slate-800 mb-1.5"
                    >
                      Password
                    </label>
                    <div className="relative">
                      <Lock
                        className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        disabled={isSubmitting}
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          if (validationError) setValidationError(null);
                          if (authError) setAuthError(null);
                        }}
                        placeholder="Enter your password"
                        className="w-full min-h-[44px] pl-10 pr-12 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B2240] focus:border-[#0B2240] disabled:bg-slate-50"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-500 hover:text-[#0B2240] rounded-md cursor-pointer"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <Eye className="w-4 h-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>

                  {validationError && (
                    <p role="alert" className="flex items-center gap-2 text-sm text-red-600 font-medium">
                      <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{validationError}</span>
                    </p>
                  )}

                  {authError && (
                    <p role="alert" className="flex items-center gap-2 text-sm text-red-600 font-medium">
                      <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{authError}</span>
                    </p>
                  )}

                  {configGuide && (
                    <div
                      role="alert"
                      className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950 space-y-2"
                    >
                      <p className="font-semibold">Account Sign-In Setup Required</p>
                      <p className="leading-relaxed">{configGuide}</p>
                      <a
                        href="https://console.firebase.google.com/project/solar-beanbag-mvr20/authentication/providers"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 font-semibold text-[#0B2240] hover:underline"
                      >
                        <span>Open Authentication Settings</span>
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                    </div>
                  )}

                  {isSubmitting && <Spinner label="Signing in..." />}

                  {dbError && !isSubmitting && (
                    <div
                      role="alert"
                      className="p-4 rounded-lg bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-2 text-sm text-red-800">
                        <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>{dbError}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void performLogin()}
                        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[38px] text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] transition-colors shrink-0 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Retry</span>
                      </button>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full inline-flex items-center justify-center px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {isSubmitting ? 'Signing in...' : 'Sign in'}
                  </button>
                </form>

                <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="text-xs text-slate-600">
                    <p className="font-semibold text-[#0B2240]">Want to tutor at HCT ASC?</p>
                    <p>Students &amp; faculty can apply and track status.</p>
                  </div>
                  <button
                    type="button"
                    onClick={onOpenTutorApply}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-xs font-semibold text-[#0B2240] bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors shrink-0 cursor-pointer"
                  >
                    <GraduationCap className="w-4 h-4" aria-hidden="true" />
                    <span>Apply to Become a Tutor</span>
                  </button>
                </div>

                <div className="rounded-lg bg-slate-100 border border-slate-200 px-4 py-3 text-xs text-slate-600 leading-relaxed space-y-1">
                  <p>
                    Demo accounts: student <span className="font-mono font-medium text-slate-800">s1</span> /{' '}
                    <span className="font-mono font-medium text-slate-800">Student@2026</span>, tutor{' '}
                    <span className="font-mono font-medium text-slate-800">t1</span> /{' '}
                    <span className="font-mono font-medium text-slate-800">Tutor@2026</span>, admin{' '}
                    <span className="font-mono font-medium text-slate-800">admin</span> /{' '}
                    <span className="font-mono font-medium text-slate-800">Admin@2026</span>
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Available demo usernames: s1–s15, t1–t10, admin
                  </p>
                </div>
              </>
            ) : (
              <form onSubmit={handleSignUpSubmit} noValidate className="space-y-4">
                <div>
                  <span className="block text-sm font-medium text-slate-800 mb-2">
                    Account Role
                  </span>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => setSignupRole('student')}
                      className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                        signupRole === 'student'
                          ? 'border-[#0B2240] bg-[#0B2240]/5 ring-1 ring-[#0B2240]'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-semibold text-sm text-[#0B2240]">
                        <GraduationCap className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span>Student</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Get help, practise &amp; book tutoring
                      </p>
                    </button>

                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => setSignupRole('tutor')}
                      className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                        signupRole === 'tutor'
                          ? 'border-[#0B2240] bg-[#0B2240]/5 ring-1 ring-[#0B2240]'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-semibold text-sm text-[#0B2240]">
                        <UserCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span>Tutor</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Reviewed by ASC before activation
                      </p>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="signup-name"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Full Name
                    </label>
                    <div className="relative">
                      <User
                        className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="signup-name"
                        type="text"
                        autoComplete="name"
                        disabled={isSubmitting}
                        value={signupName}
                        onChange={(e) => {
                          setSignupName(e.target.value);
                          if (validationError) setValidationError(null);
                        }}
                        placeholder="e.g. Ayesha Al Suwaidi"
                        className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="signup-campus"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Campus
                    </label>
                    <div className="relative">
                      <Building2
                        className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                        aria-hidden="true"
                      />
                      <select
                        id="signup-campus"
                        disabled={isSubmitting}
                        value={signupCampus}
                        onChange={(e) => setSignupCampus(e.target.value)}
                        className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                      >
                        {CAMPUSES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="signup-email"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail
                      className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      id="signup-email"
                      type="email"
                      autoComplete="email"
                      disabled={isSubmitting}
                      value={signupEmail}
                      onChange={(e) => {
                        setSignupEmail(e.target.value);
                        if (validationError) setValidationError(null);
                      }}
                      placeholder="name@hct.ac.ae"
                      className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="signup-password"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Password (min 8 characters)
                    </label>
                    <div className="relative">
                      <Lock
                        className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="signup-password"
                        type={showSignupPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        disabled={isSubmitting}
                        value={signupPassword}
                        onChange={(e) => {
                          setSignupPassword(e.target.value);
                          if (validationError) setValidationError(null);
                        }}
                        placeholder="At least 8 characters"
                        className="w-full min-h-[42px] pl-9 pr-10 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                      />
                      <button
                        type="button"
                        onClick={() => setShowSignupPassword((prev) => !prev)}
                        aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 text-slate-500 hover:text-[#0B2240] rounded cursor-pointer"
                      >
                        {showSignupPassword ? (
                          <EyeOff className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <Eye className="w-4 h-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="signup-confirm-password"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Confirm Password
                    </label>
                    <div className="relative">
                      <Lock
                        className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="signup-confirm-password"
                        type={showSignupPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        disabled={isSubmitting}
                        value={signupConfirmPassword}
                        onChange={(e) => {
                          setSignupConfirmPassword(e.target.value);
                          if (validationError) setValidationError(null);
                        }}
                        placeholder="Re-enter password"
                        className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>
                </div>

                {/* Dynamic Courses Multi-Select */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B2240]">
                      <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {signupRole === 'student'
                          ? 'Enrolled Courses (select at least 1)'
                          : 'Courses you can tutor (optional)'}
                      </span>
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {selectedCourses.length} selected
                    </span>
                  </div>

                  <div className="max-h-44 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50">
                    {availableCourses.map((course) => {
                      const checked = selectedCourses.includes(course.code);
                      return (
                        <label
                          key={course.code}
                          className={`flex items-start gap-2 p-2 rounded-md border text-xs cursor-pointer transition-colors ${
                            checked
                              ? 'border-[#0B2240] bg-white text-[#0B2240] font-semibold'
                              : 'border-slate-200 bg-white/80 text-slate-700 hover:border-slate-300'
                          }`}
                        >
                          <input
                            type="checkbox"
                            disabled={isSubmitting}
                            checked={checked}
                            onChange={() => toggleSignupCourse(course.code)}
                            className="mt-0.5 h-3.5 w-3.5 accent-[#0B2240] shrink-0"
                          />
                          <span className="leading-snug">
                            <span className="font-mono font-semibold">{course.code}</span>
                            {course.title && course.title !== course.code ? ` – ${course.title}` : ''}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {signupRole === 'tutor' && (
                  <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                    New tutor accounts require Academic Success Center coordinator approval before accessing tutoring sessions.
                  </p>
                )}

                {validationError && (
                  <p role="alert" className="flex items-center gap-2 text-sm text-red-600 font-medium">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{validationError}</span>
                  </p>
                )}

                {authError && (
                  <p role="alert" className="flex items-center gap-2 text-sm text-red-600 font-medium">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{authError}</span>
                  </p>
                )}

                {configGuide && (
                  <div
                    role="alert"
                    className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950 space-y-2"
                  >
                    <p className="font-semibold">Account Sign-Up Setup Required</p>
                    <p className="leading-relaxed">{configGuide}</p>
                  </div>
                )}

                {isSubmitting && <Spinner label="Creating your account..." />}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full inline-flex items-center justify-center px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {isSubmitting
                    ? 'Creating account...'
                    : signupRole === 'student'
                      ? 'Create Student Account'
                      : 'Submit Tutor Sign-Up'}
                </button>
              </form>
            )}
          </div>
        </div>
      </main>

      <Footer onOpenHumanSupport={onOpenHumanSupport} />
    </div>
  );
};
