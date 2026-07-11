import { useEffect, useState } from "react";
import { api, type Contractor } from "./api";

type AuthState =
  | { phase: "loading" }
  | { phase: "signed_out" }
  | { phase: "verifying" }
  | { phase: "signed_in"; contractor: Contractor };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: "loading" });

  useEffect(() => {
    // Magic-link landing: /auth/verify?token=...
    const params = new URLSearchParams(window.location.search);
    const token = window.location.pathname === "/auth/verify" ? params.get("token") : null;

    (async () => {
      if (token) {
        setAuth({ phase: "verifying" });
        try {
          await api.verify(token);
          window.history.replaceState(null, "", "/");
        } catch {
          // fall through to session check / sign-in screen
        }
      }
      try {
        const { contractor } = await api.me();
        setAuth({ phase: "signed_in", contractor });
      } catch {
        setAuth({ phase: "signed_out" });
      }
    })();
  }, []);

  if (auth.phase === "loading" || auth.phase === "verifying") {
    return <p className="muted">Loading…</p>;
  }
  if (auth.phase === "signed_out") {
    return <SignIn />;
  }
  return <Home contractor={auth.contractor} />;
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

function Home({ contractor }: { contractor: Contractor }) {
  return (
    <div>
      <h1>ScopeWalk</h1>
      <p className="muted">{contractor.business_name}</p>
      <div className="card">
        <h2>Today's walkthroughs</h2>
        <p className="muted">None scheduled. (Walkthrough capture lands in Phase 1.)</p>
      </div>
      <button disabled title="Phase 1">Start Walkthrough</button>
      <div className="card">
        <h2>Recent projects</h2>
        <p className="muted">No projects yet.</p>
      </div>
    </div>
  );
}
