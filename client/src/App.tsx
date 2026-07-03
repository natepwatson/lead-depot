import { Switch, Route, Router } from "wouter";
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
import NotFound from "./pages/not-found";
import { useState, useEffect } from "react";

function AppRoutes() {
  const { user } = useAuth();
  const [adminViewingLeads, setAdminViewingLeads] = useState(false);
  // Headshot gate — check if user has a headshot on file
  const [headshotChecked, setHeadshotChecked] = useState(false);
  const [hasHeadshot, setHasHeadshot] = useState(true); // optimistic

  useEffect(() => {
    if (!user) { setHeadshotChecked(true); return; }
    fetch(`/api/me/${user.id}`)
      .then(r => r.json())
      .then(d => {
        const url = d.agent?.headshotUrl || d.agent?.headshot_url || "";
        setHasHeadshot(!!url);
        setHeadshotChecked(true);
      })
      .catch(() => {
        // If check fails, don't block
        setHasHeadshot(true);
        setHeadshotChecked(true);
      });
  }, [user?.id]);

  if (!user) return <LoginPage />;
  if (!headshotChecked) return null; // Brief flicker-free check

  // Block with headshot gate if no headshot
  if (!hasHeadshot) {
    return (
      <HeadshotGate
        userId={user.id}
        userName={user.name}
        onComplete={(_url) => setHasHeadshot(true)}
      />
    );
  }

  if (user.role === "admin" && adminViewingLeads) {
    return <AgentView onBackToAdmin={() => setAdminViewingLeads(false)} initialTab="leads" />;
  }
  if (user.role === "admin") return <AdminDashboard onWorkMyLeads={() => setAdminViewingLeads(true)} />;
  return <AgentView />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router hook={useHashLocation}>
          <Switch>
            {/* Account setup — no auth required, token-gated */}
            <Route path="/setup/:token" component={AccountSetupPage} />
            {/* Password reset — no auth required, token-gated */}
            <Route path="/reset-password/:token" component={ResetPasswordPage} />
            <Route path="/" component={AppRoutes} />
            <Route component={NotFound} />
          </Switch>
        </Router>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
