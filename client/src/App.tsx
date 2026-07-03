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
import NotFound from "./pages/not-found";
import { useState } from "react";

function AppRoutes() {
  const { user } = useAuth();
  const [adminViewingLeads, setAdminViewingLeads] = useState(false);

  if (!user) return <LoginPage />;
  if (user.role === "admin" && adminViewingLeads) {
    // Pass initialTab="leads" so admin lands directly on Dial, not Leaderboard
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
