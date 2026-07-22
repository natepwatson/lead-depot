import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import LoginPage from "./pages/LoginPage";
import AdminDashboard from "./pages/AdminDashboard";
import AgentView from "./pages/AgentView";
import AccountSetupPage from "./pages/AccountSetupPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import HeadshotGate from "./components/ld/HeadshotGate";
import HomeCountyGate from "./components/ld/HomeCountyGate";
import WatsonEmailNudge from "./components/ld/WatsonEmailNudge";
import OnAirBanner from "./components/ld/OnAirBanner";
// v15.11.3 — push subscription removed. The always-visible Prime bar IS the
// notifier. No web-push, no iOS-permission dance, no opt-in. Everyone who
// opens the app sees the same red/amber/gray broadcast light at the top of
// every screen — that's the alert.
import ProfileGate from "./components/ProfileGate";
import TutorialFlow from "./components/TutorialFlow";
import NotFound from "./pages/not-found";
import JoinPage from "./pages/JoinPage";
import CandidateLanding from "./pages/CandidateLanding";
import { useEffect, useState } from "react";

function AppRoutes() {
  const { user, setHeadshot, setHomeCounty, setTutorialCompleted, refreshUser } = useAuth();

  // v15.11 — On login, silently try to subscribe this browser to Web Push so
  // Prime Time alerts reach the agent even when the app is closed. If perms
  // are denied or the browser doesn't support it, this is a no-op.
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => { /* no-op: push removed in v15.11.3 */ }, 1500);
    return () => clearTimeout(t);
  }, [user?.id]);

  // v15.11.17 — Hydration guard: if the localStorage user is missing the
  // tutorialCompletedAt / profileCompletedAt keys (older builds didn't return
  // them from /api/login), refresh from /api/me/:id before the gate check
  // runs. Without this, the tutorial re-fires every login for agents whose
  // cached user object predates v14.81 — the same bug Alex reported today
  // ("tutorial isn't working for some agents"). Cheap fetch, runs once per
  // login.
  useEffect(() => {
    if (!user) return;
    const missingFlags = (user as any).tutorialCompletedAt === undefined
      || (user as any).profileCompletedAt === undefined;
    if (missingFlags) {
      refreshUser();
    }
     
  }, [user?.id]);
  // v14.51 — admin bottom nav can jump to any agent-side tab, not just leads.
  // null = show AdminDashboard. "leads"/"refer"/"leaderboard"/"profile" = show AgentView on that tab.
  const [adminAgentTab, setAdminAgentTab] = useState<null | "leads" | "refer" | "leaderboard" | "profile" | "pipeline">(null);
  const [location, navigate] = useLocation();

  if (!user) return <LoginPage />;

  // v13.10 — Two required gates for agents (admins skip both).
  //   1. HomeCountyGate — hard block until they pick their county (drives lead flow)
  //   2. HeadshotGate   — nag every login until a photo is on file
  // Admins (Alex + Nate) skip both — they work all counties (killer mode) and
  // their photo is optional.
  const isAgent = user.role === "agent";
  if (isAgent && !user.homeCounty) {
    return (
      <HomeCountyGate
        userId={user.id}
        userName={user.name}
        onComplete={(county) => setHomeCounty(county)}
      />
    );
  }
  // v14.7 — Headshot no longer blocks. Agents can work immediately;
  // headshot upload is available from the Profile tab.
  // (HeadshotGate kept in imports for future opt-in nag, but not rendered.)

  // v14.81 — Two new onboarding gates for agents, in order after HomeCounty
  // (the most fundamental / pre-existing gate). Admins (Alex + Nate) are
  // pre-marked complete for both via the startup backfill migration, so this
  // never blocks them. A rewatch (triggered from Profile) sets tutorialCompletedAt
  // back to null server-side but flags sessionStorage so TutorialFlow knows
  // it's not the agent's first time (enables the Skip button).
  // v14.9 — Onboarding gates now fire for BOTH agents and admins. Original
  // v14.81 gated on isAgent only, which meant the Profile "Replay Tutorial"
  // button was a silent no-op for admins (Alex/Nate) because App.tsx skipped
  // straight past the TutorialFlow mount. Admins can now rewatch too.
  if (!user.profileCompletedAt) {
    return <ProfileGate onComplete={() => refreshUser()} />;
  }
  if (!user.tutorialCompletedAt) {
    const isRewatch = (() => {
      try { return sessionStorage.getItem("ld_tutorial_rewatch") === "true"; } catch { return false; }
    })();
    return (
      <TutorialFlow
        isFirstTime={!isRewatch}
        onComplete={() => {
          try { sessionStorage.removeItem("ld_tutorial_rewatch"); } catch {}
          setTutorialCompleted(new Date().toISOString());
        }}
      />
    );
  }

  // v12.5 — Recruiting Depot is admin-only. Non-admin at #/recruiting → redirect.
  const onRecruiting = location.startsWith("/recruiting");
  if (onRecruiting && user.role !== "admin") {
    navigate("/", { replace: true });
    return null;
  }
  // Admin at #/recruiting sees the Recruiting Depot AgentView shell
  if (onRecruiting && user.role === "admin") {
    return <AgentView mode="recruiting" initialTab="leads" onBackToAdmin={() => navigate("/", { replace: true })} />;
  }

  // v14.29.1 — Non-admin agents whose email isn't @watsonbrothersgroup.com
  // see a dismissible per-session nudge to get their team email provisioned.
  const showEmailNudge = isAgent;

  if (user.role === "admin" && adminAgentTab) {
    return (
      <>
        <OnAirBanner agentId={String(user.id)} />
        <AgentView mode="seller" onBackToAdmin={() => setAdminAgentTab(null)} initialTab={adminAgentTab} />
      </>
    );
  }
  if (user.role === "admin") return (
    <>
      <OnAirBanner agentId={String(user.id)} />
      <AdminDashboard
        onWorkMyLeads={() => setAdminAgentTab("leads")}
        onOpenAgentTab={(t) => setAdminAgentTab(t)}
      />
    </>
  );
  return (
    <>
      <OnAirBanner agentId={String(user.id)} />
      <AgentView mode="seller" />
      {showEmailNudge && <WatsonEmailNudge userEmail={user.email} userName={user.name} />}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router hook={useHashLocation}>
          <Switch>
            {/* Public recruiting form — no auth required */}
            {/* v15.5 — candidate landing must be checked BEFORE the generic /join route */}
            <Route path="/join/:token" component={CandidateLanding} />
            <Route path="/join" component={JoinPage} />
            {/* Account setup — no auth required, token-gated */}
            <Route path="/setup/:token" component={AccountSetupPage} />
            {/* Password reset — no auth required, token-gated */}
            <Route path="/reset-password/:token" component={ResetPasswordPage} />
            {/* v12.5 — Recruiting Depot (admin-only, guarded in AppRoutes) */}
            <Route path="/recruiting" component={AppRoutes} />
            <Route path="/" component={AppRoutes} />
            {/* v15.11.31 — defensive catch: any hash path we don't own routes home
                instead of 404. Prevents stale bookmarks and mis-typed URLs from
                dead-ending in the tiny 404 card. */}
            <Route path="/leaderboard" component={AppRoutes} />
            <Route path="/dial" component={AppRoutes} />
            <Route path="/dashboard" component={AppRoutes} />
            <Route path="/leads" component={AppRoutes} />
            <Route path="/pipeline" component={AppRoutes} />
            <Route path="/profile" component={AppRoutes} />
            <Route path="/refer" component={AppRoutes} />
            <Route component={NotFound} />
          </Switch>
        </Router>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
