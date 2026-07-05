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
import NotFound from "./pages/not-found";
import JoinPage from "./pages/JoinPage";
import { useEffect, useState } from "react";

function AppRoutes() {
  const { user } = useAuth();
  const [adminViewingLeads, setAdminViewingLeads] = useState(false);
  const [location, navigate] = useLocation();

  if (!user) return <LoginPage />;

  // v13.9 — HeadshotGate removed post-login.
  // Only NEW agents get a headshot prompt during AccountSetupPage (which is optional).
  // Existing agents are never blocked, even if headshot is missing.
  // Leaderboard and admin views fall back to initials when no headshot is on file.

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

  if (user.role === "admin" && adminViewingLeads) {
    return <AgentView mode="seller" onBackToAdmin={() => setAdminViewingLeads(false)} initialTab="leads" />;
  }
  if (user.role === "admin") return <AdminDashboard onWorkMyLeads={() => setAdminViewingLeads(true)} />;
  return <AgentView mode="seller" />;
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
