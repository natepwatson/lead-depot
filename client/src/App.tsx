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
import NotFound from "./pages/not-found";
import JoinPage from "./pages/JoinPage";
import { useEffect, useState } from "react";

function AppRoutes() {
  const { user, setHeadshot, setHomeCounty } = useAuth();
  // v14.51 — admin bottom nav can jump to any agent-side tab, not just leads.
  // null = show AdminDashboard. "leads"/"refer"/"leaderboard"/"profile" = show AgentView on that tab.
  const [adminAgentTab, setAdminAgentTab] = useState<null | "leads" | "refer" | "leaderboard" | "profile">(null);
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
    return <AgentView mode="seller" onBackToAdmin={() => setAdminAgentTab(null)} initialTab={adminAgentTab} />;
  }
  if (user.role === "admin") return (
    <AdminDashboard
      onWorkMyLeads={() => setAdminAgentTab("leads")}
      onOpenAgentTab={(t) => setAdminAgentTab(t)}
    />
  );
  return (
    <>
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
            <Route path="/join" component={JoinPage} />
            {/* Account setup — no auth required, token-gated */}
            <Route path="/setup/:token" component={AccountSetupPage} />
            {/* Password reset — no auth required, token-gated */}
            <Route path="/reset-password/:token" component={ResetPasswordPage} />
            {/* v12.5 — Recruiting Depot (admin-only, guarded in AppRoutes) */}
            <Route path="/recruiting" component={AppRoutes} />
            <Route path="/" component={AppRoutes} />
            <Route component={NotFound} />
          </Switch>
        </Router>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
