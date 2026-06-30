import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function LoginPage() {
  const { login } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (result.error) {
      toast({ title: "Login failed", description: result.error, variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo mark */}
        <div className="flex flex-col items-center mb-12">
          {/* Brothers Group M-mark style logo */}
          <div className="mb-6 flex items-center justify-center w-16 h-16 bg-white rounded-sm">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-label="Brothers Group">
              {/* Stylized "BG" / M-mark inspired by their logo */}
              <path d="M4 34V8L20 2L36 8V34H4Z" fill="#171717"/>
              <path d="M4 8L20 14L36 8" stroke="white" strokeWidth="1.5" fill="none"/>
              <rect x="15" y="22" width="10" height="12" fill="white" opacity="0.9"/>
              <path d="M10 18h6M24 18h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white uppercase" style={{letterSpacing: '0.08em'}}>Lead Depot</h1>
          <p className="text-sm text-white/40 mt-1.5 uppercase tracking-widest" style={{fontSize: '0.65rem'}}>Brothers Group · Momentum Realty</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-xs font-medium text-white/60 uppercase tracking-wider">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@watsonbrothersgroup.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              data-testid="input-email"
              className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-white/40 focus:ring-0 h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs font-medium text-white/60 uppercase tracking-wider">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              data-testid="input-password"
              className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-white/40 focus:ring-0 h-11"
            />
          </div>
          <Button
            type="submit"
            className="w-full bg-white text-black hover:bg-white/90 font-semibold uppercase tracking-widest text-xs h-11 mt-2"
            style={{letterSpacing: '0.12em'}}
            disabled={loading}
            data-testid="button-login"
          >
            {loading ? "Signing in…" : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
