import { useEffect, useState } from "react";
import { api } from "./api";
import { cachedContractor } from "./db/store";
import { onSyncState, pullBootstrap, startAutoSync, syncNow, type SyncState } from "./db/sync";
import { BidSheet } from "./screens/BidSheet";
import { Home } from "./screens/Home";
import { ProposalBuilder } from "./screens/ProposalBuilder";
import { Review } from "./screens/Review";
import { Settings } from "./screens/Settings";
import { WalkthroughRunner } from "./screens/WalkthroughRunner";
import type { Contractor } from "./types";

type AuthState =
  | { phase: "loading" }
  | { phase: "signed_out" }
  | { phase: "signed_in"; contractor: Contractor };

// Hash routes: "" home, "#/wt/:id" runner, "#/wt/:id/review" review,
// "#/bid/:id" bid pricing. Hash routing keeps reloads offline-safe: the
// service worker serves the app shell and the route re-resolves entirely from
// IndexedDB (Hard Rule 2).
type Route =
  | { name: "home" }
  | { name: "walkthrough"; id: string }
  | { name: "review"; id: string }
  | { name: "bid"; id: string }
  | { name: "proposal"; id: string }
  | { name: "settings" };

function parseRoute(): Route {
  const m = window.location.hash.match(/^#\/wt\/([^/]+)(\/review)?$/);
  if (m && m[1]) return m[2] ? { name: "review", id: m[1] } : { name: "walkthrough", id: m[1] };
  const b = window.location.hash.match(/^#\/bid\/([^/]+)$/);
  if (b && b[1]) return { name: "bid", id: b[1] };
  const p = window.location.hash.match(/^#\/proposal\/([^/]+)$/);
  if (p && p[1]) return { name: "proposal", id: p[1] };
  if (window.location.hash === "#/settings") return { name: "settings" };
  return { name: "home" };
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: "loading" });
  const [route, setRoute] = useState<Route>(parseRoute());
  const [sync, setSync] = useState<SyncState | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => onSyncState(setSync), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = window.location.pathname === "/auth/verify" ? params.get("token") : null;

    (async () => {
      if (token) {
        try {
          await api.verify(token);
          window.history.replaceState(null, "", "/");
        } catch {
          // fall through to session check / sign-in screen
        }
      }
      // Offline-tolerant auth (Hard Rule 2): only an explicit 401 signs us
      // out. A network failure falls back to the cached contractor so the
      // field flow keeps working in airplane mode.
      const contractor = await pullBootstrap();
      if (contractor) {
        setAuth({ phase: "signed_in", contractor });
        startAutoSync();
      } else {
        const cached = await cachedContractor();
        if (cached && !navigator.onLine) {
          setAuth({ phase: "signed_in", contractor: cached });
          startAutoSync();
        } else {
          setAuth({ phase: "signed_out" });
        }
      }
    })();
  }, []);

  if (auth.phase === "loading") return <p className="muted">Loading…</p>;
  if (auth.phase === "signed_out") return <SignIn />;

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  return (
    <div>
      <SyncBadge sync={sync} />
      {route.name === "home" && (
        <Home
          contractor={auth.contractor}
          onOpenWalkthrough={(id) => go(`#/wt/${id}`)}
          onSettings={() => go("#/settings")}
        />
      )}
      {route.name === "walkthrough" && (
        <WalkthroughRunner
          walkthroughId={route.id}
          onExit={() => go("")}
          onReview={() => go(`#/wt/${route.id}/review`)}
        />
      )}
      {route.name === "review" && (
        <Review
          walkthroughId={route.id}
          onBack={() => go(`#/wt/${route.id}`)}
          onDone={() => go("")}
          onBid={(bidSheetId) => go(`#/bid/${bidSheetId}`)}
        />
      )}
      {route.name === "bid" && (
        <BidSheet
          bidSheetId={route.id}
          onBack={() => window.history.back()}
          onProposal={(proposalId) => go(`#/proposal/${proposalId}`)}
        />
      )}
      {route.name === "proposal" && (
        <ProposalBuilder
          proposalId={route.id}
          onBack={() => window.history.back()}
          onOpenProposal={(id) => go(`#/proposal/${id}`)}
        />
      )}
      {route.name === "settings" && (
        <Settings
          contractor={auth.contractor}
          onSaved={(c) => setAuth({ phase: "signed_in", contractor: c })}
          onBack={() => go("")}
        />
      )}
    </div>
  );
}

function SyncBadge({ sync }: { sync: SyncState | null }) {
  if (!sync) return null;
  const label = !sync.online
    ? `Offline${sync.pending > 0 ? ` · ${sync.pending} queued` : " · all saved locally"}`
    : sync.syncing
      ? "Syncing…"
      : sync.pending > 0
        ? `${sync.pending} to sync`
        : "Synced";
  return (
    <button
      className={`sync-badge ${sync.online ? "sync-online" : "sync-offline"}`}
      onClick={() => void syncNow()}
      title={sync.lastError ?? undefined}
    >
      {label}
    </button>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await api.requestLink(email);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  return (
    <div>
      <h1>ScopeWalk</h1>
      <p className="muted">Field scope &amp; bid tool</p>
      <div className="card">
        {sent ? (
          <p>Check your email for a sign-in link. (Pilot: the link prints to the server console.)</p>
        ) : (
          <>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button onClick={submit} disabled={!email.includes("@")}>
              Send sign-in link
            </button>
            {error && <p className="error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
