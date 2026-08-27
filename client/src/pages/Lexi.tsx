// v20.37.0 — Lexi, the BGRE AI Assistant voice portal.
// Admin-gated full-screen takeover. Auto-listens on mount (no press-to-talk),
// sends finalized speech to /api/assistant/chat, speaks the reply back, and
// shows a Confirm/Cancel card for any proposed write action (e.g. creating a
// FUB task) — nothing is written until the admin explicitly confirms, by
// voice ("yes" / "confirm" / "go ahead") or by tapping the button.
// v20.37.0 — conversation history is now hydrated from the server on mount
// (GET /api/assistant/history) and each turn sends only the newest message
// ({ message: text }) since the server is now the authoritative memory
// store — the transcript survives reloads, closed tabs, and poor connectivity.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Sparkles, Mic, MicOff, X, Check, XCircle } from "lucide-react";

type ChatMsg = { role: "user" | "assistant"; content: string };
type ProposedAction = { type: string; title?: string; personName?: string; dueDate?: string; notes?: string } | null;

const CONFIRM_WORDS = ["yes", "yeah", "yep", "confirm", "go ahead", "do it", "please do", "sounds good", "sure"];
const CANCEL_WORDS = ["no", "nope", "cancel", "never mind", "nevermind", "don't", "stop", "skip it"];

// v20.37.5 — Lexi's voice is now generated server-side by Kokoro (af_heart,
// faster-than-default cadence) instead of the browser's robotic built-in
// speechSynthesis. Falls back to speechSynthesis if the server voice is
// unreachable or errors, so Lexi never goes silent.
let currentSpeechAudio: HTMLAudioElement | null = null;

function speakBrowserFallback(text: string, onDone: () => void) {
  try {
    if (!("speechSynthesis" in window) || !text.trim()) {
      onDone();
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.pitch = 1.0;
    utter.onend = onDone;
    utter.onerror = onDone;
    window.speechSynthesis.speak(utter);
  } catch {
    onDone();
  }
}

async function speak(text: string, onDone: () => void) {
  const trimmed = text.trim();
  if (!trimmed) {
    onDone();
    return;
  }
  try {
    if (currentSpeechAudio) {
      currentSpeechAudio.pause();
      currentSpeechAudio = null;
    }
    window.speechSynthesis?.cancel();
    const res = await apiRequest("POST", "/api/assistant/speak", { text: trimmed });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentSpeechAudio = audio;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (currentSpeechAudio === audio) currentSpeechAudio = null;
      onDone();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    await audio.play();
  } catch {
    speakBrowserFallback(trimmed, onDone);
  }
}

export default function Lexi({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<"listening" | "thinking" | "speaking" | "paused" | "unsupported">("listening");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [interim, setInterim] = useState("");
  const [proposedAction, setProposedAction] = useState<ProposedAction>(null);
  const [manualInput, setManualInput] = useState("");

  const [historyLoaded, setHistoryLoaded] = useState(false);
  const recognitionRef = useRef<any>(null);
  const shouldListenRef = useRef(true);
  const messagesRef = useRef<ChatMsg[]>([]);
  const proposedActionRef = useRef<ProposedAction>(null);
  messagesRef.current = messages;
  proposedActionRef.current = proposedAction;

  // Hydrate the transcript from persistent server-side memory on mount.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/assistant/history");
        const data = await res.json();
        if (Array.isArray(data.messages) && data.messages.length) {
          setMessages(data.messages.map((m: any) => ({ role: m.role, content: m.content })));
        }
      } catch {
        // Non-fatal — Lexi just starts with an empty transcript this session.
      } finally {
        setHistoryLoaded(true);
      }
    })();
  }, []);

  const stopListening = useCallback(() => {
    shouldListenRef.current = false;
    try { recognitionRef.current?.stop(); } catch {}
  }, []);

  const startListening = useCallback(() => {
    shouldListenRef.current = true;
    try { recognitionRef.current?.start(); } catch {}
  }, []);

  const runAction = useCallback(async (action: ProposedAction) => {
    if (!action) return;
    setStatus("thinking");
    try {
      const res = await apiRequest("POST", "/api/assistant/execute-action", { action });
      const data = await res.json();
      const confirmText = data.ok
        ? `Done — I ${action.type === "create_fub_task" ? "added that task" : "made that change"}${data.attachedToPerson ? "" : action.personName ? " (couldn't find that person in FUB, so it's a general task)" : ""}.`
        : "That didn't go through on the FUB side — want me to try again?";
      setMessages((m) => [...m, { role: "assistant", content: confirmText }]);
      setProposedAction(null);
      setStatus("speaking");
      speak(confirmText, () => { setStatus("listening"); startListening(); });
    } catch (err: any) {
      const failText = "I couldn't complete that action — something went wrong on my end.";
      setMessages((m) => [...m, { role: "assistant", content: failText }]);
      setProposedAction(null);
      setStatus("speaking");
      speak(failText, () => { setStatus("listening"); startListening(); });
    }
  }, [startListening]);

  const sendToLexi = useCallback(async (text: string) => {
    if (!text.trim()) return;
    stopListening();
    setInterim("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setStatus("thinking");
    try {
      const res = await apiRequest("POST", "/api/assistant/chat", { message: text });
      const data = await res.json();
      const reply: string = data.reply || "Sorry, I didn't catch that.";
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
      if (data.proposedAction) setProposedAction(data.proposedAction);
      setStatus("speaking");
      speak(reply, () => { setStatus("listening"); startListening(); });
    } catch (err: any) {
      const failText = err?.message?.includes("PERPLEXITY_API_KEY")
        ? "My brain isn't wired up yet — the Perplexity API key isn't set on the server."
        : "I hit an error reaching my brain — try again in a second.";
      // v20.37.0 — do NOT also setError() here; the failText already renders as a
      // chat bubble two lines below. Setting both produced a duplicate on-screen
      // error (bubble + red-text line) reported in Tier V visual QA.
      setMessages((m) => [...m, { role: "assistant", content: failText }]);
      setStatus("speaking");
      speak(failText, () => { setStatus("listening"); startListening(); });
    }
  }, [startListening, stopListening]);

  const handleFinalTranscript = useCallback((text: string) => {
    const lower = text.trim().toLowerCase();
    if (proposedActionRef.current) {
      if (CONFIRM_WORDS.some((w) => lower === w || lower.startsWith(w + " ") || lower.includes(w))) {
        runAction(proposedActionRef.current);
        return;
      }
      if (CANCEL_WORDS.some((w) => lower === w || lower.startsWith(w + " "))) {
        setProposedAction(null);
        const cancelText = "No problem, I won't do that.";
        setMessages((m) => [...m, { role: "assistant", content: cancelText }]);
        setStatus("speaking");
        speak(cancelText, () => { setStatus("listening"); startListening(); });
        return;
      }
    }
    sendToLexi(text);
  }, [runAction, sendToLexi, startListening]);

  useEffect(() => {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setStatus("unsupported");
      return;
    }
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      setInterim(interimText);
      if (finalText.trim()) {
        setInterim("");
        handleFinalTranscript(finalText.trim());
      }
    };
    recognition.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      console.warn("[Lexi] recognition error:", e.error);
    };
    recognition.onend = () => {
      // Browsers auto-stop continuous recognition periodically — restart
      // unless we deliberately paused it (thinking/speaking).
      if (shouldListenRef.current) {
        try { recognition.start(); } catch {}
      }
    };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}

    return () => {
      shouldListenRef.current = false;
      try { recognition.stop(); } catch {}
      try { window.speechSynthesis.cancel(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleFinalTranscript]);

  const statusLabel = {
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
    paused: "Paused",
    unsupported: "Voice not supported in this browser",
  }[status];

  const orbColor = status === "listening" ? "#4ade80" : status === "thinking" ? "#c8aa5a" : status === "speaking" ? "#67e8f9" : "#555";

  return (
    <div style={{
      minHeight: "100dvh", background: "#080808", color: "#fff",
      display: "flex", flexDirection: "column",
      fontFamily: "'Switzer','Inter',sans-serif",
    }}>
      <div className="ld-glow" />
      <div className="ld-glow-corner" />

      {/* Header */}
      <header style={{
        position: "sticky", top: 0, zIndex: 20,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 20px",
        background: "rgba(8,8,8,0.95)", backdropFilter: "blur(16px)",
        borderBottom: "1px solid rgba(200,170,90,0.1)",
      }}>
        <button onClick={onClose} style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", fontWeight: 700,
          color: "#c8aa5a", background: "rgba(200,170,90,0.10)",
          border: "1px solid rgba(200,170,90,0.30)", borderRadius: 8, padding: "6px 9px", cursor: "pointer",
        }}>
          <X size={12} /> Close
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Sparkles size={16} style={{ color: "#c8aa5a" }} />
          <p style={{
            fontFamily: "'Cormorant Garamond','Georgia',serif",
            fontSize: 16, letterSpacing: "0.16em", textTransform: "uppercase", color: "#fff",
          }}>Lexi</p>
        </div>
        <div style={{ width: 62 }} />
      </header>

      {/* Orb + status */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "36px 20px 18px" }}>
        <div style={{
          width: 96, height: 96, borderRadius: "50%",
          background: `radial-gradient(circle, ${orbColor}33 0%, transparent 70%)`,
          border: `1.5px solid ${orbColor}88`,
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: status === "listening" || status === "speaking" ? "lexiPulse 1.8s ease-in-out infinite" : "none",
          transition: "border-color 0.3s, background 0.3s",
        }}>
          {status === "unsupported" ? <MicOff size={30} style={{ color: orbColor }} /> : <Mic size={30} style={{ color: orbColor }} />}
        </div>
        <style>{`@keyframes lexiPulse { 0%,100% { box-shadow: 0 0 0 0 ${orbColor}33; } 50% { box-shadow: 0 0 0 14px ${orbColor}11; } }`}</style>
        <p style={{ marginTop: 14, fontSize: 11, letterSpacing: "0.10em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>
          {statusLabel}
        </p>
        {interim && (
          <p style={{ marginTop: 8, fontSize: 13, color: "rgba(255,255,255,0.4)", fontStyle: "italic", maxWidth: 420, textAlign: "center" }}>
            "{interim}"
          </p>
        )}
      </div>

      {/* Transcript */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px", display: "flex", flexDirection: "column", gap: 12, maxWidth: 640, margin: "0 auto", width: "100%" }}>
        {historyLoaded && messages.length === 0 && status !== "unsupported" && (
          <p style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 13, marginTop: 20 }}>
            Just start talking — Lexi's listening.
          </p>
        )}
        {status === "unsupported" && (
          <p style={{ textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 13, marginTop: 20 }}>
            This browser doesn't support voice recognition. Type a message below instead.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "82%",
            background: m.role === "user" ? "rgba(200,170,90,0.14)" : "rgba(255,255,255,0.06)",
            border: m.role === "user" ? "1px solid rgba(200,170,90,0.3)" : "1px solid rgba(255,255,255,0.1)",
            borderRadius: 14, padding: "10px 14px", fontSize: 14, lineHeight: 1.5,
            color: m.role === "user" ? "#f5e6c4" : "#eee",
          }}>
            {m.content}
          </div>
        ))}

        {proposedAction && (
          <div style={{
            alignSelf: "center", width: "100%",
            background: "rgba(200,170,90,0.08)", border: "1px solid rgba(200,170,90,0.35)",
            borderRadius: 14, padding: "14px 16px", marginTop: 4,
          }}>
            <p style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#c8aa5a", marginBottom: 6, fontWeight: 700 }}>
              Proposed action
            </p>
            <p style={{ fontSize: 14, color: "#fff", marginBottom: 10 }}>
              Create task: <strong>{proposedAction.title}</strong>
              {proposedAction.personName ? ` for ${proposedAction.personName}` : ""}
              {proposedAction.dueDate ? ` — due ${proposedAction.dueDate}` : ""}
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => runAction(proposedAction)}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  background: "rgba(74,222,128,0.15)", border: "1px solid rgba(74,222,128,0.4)",
                  color: "#4ade80", borderRadius: 10, padding: "9px 0", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em",
                }}
              >
                <Check size={13} /> Confirm
              </button>
              <button
                onClick={() => { setProposedAction(null); }}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)",
                  color: "rgba(255,255,255,0.7)", borderRadius: 10, padding: "9px 0", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em",
                }}
              >
                <XCircle size={13} /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Manual text fallback — always available, useful when mic access is denied or noisy. */}
      <form
        onSubmit={(e) => { e.preventDefault(); if (manualInput.trim()) { sendToLexi(manualInput.trim()); setManualInput(""); } }}
        style={{
          display: "flex", gap: 8, padding: "12px 20px", borderTop: "1px solid rgba(255,255,255,0.08)",
          maxWidth: 640, margin: "0 auto", width: "100%", boxSizing: "border-box",
        }}
      >
        <input
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          placeholder="Or type to Lexi…"
          style={{
            flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 10, padding: "10px 12px", color: "#fff", fontSize: 13, outline: "none",
          }}
        />
        <button type="submit" style={{
          background: "rgba(200,170,90,0.15)", border: "1px solid rgba(200,170,90,0.4)",
          color: "#c8aa5a", borderRadius: 10, padding: "10px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>
          Send
        </button>
      </form>
    </div>
  );
}
