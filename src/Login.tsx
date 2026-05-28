import { useState, type FormEvent } from "react";
import { login } from "./auth";

type LoginProps = {
  onSuccess: () => void;
};

export function Login({ onSuccess }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const msg = await login(username, password);
      if (msg) {
        setError(msg);
        return;
      }
      onSuccess();
    } catch {
      setError("Cannot reach the API server. Run npm run dev and ensure the proxy is up.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <header className="login-header">
          <h1>Canteen EM Sensor Health</h1>
          <p className="login-lede">Sign in to view the dashboard.</p>
        </header>
        <form className="login-form" onSubmit={(e) => void onSubmit(e)}>
          <label className="login-field">
            <span className="label">Username</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={submitting}
            />
          </label>
          <label className="login-field">
            <span className="label">Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={submitting}
            />
          </label>
          {error && <div className="banner err login-error">{error}</div>}
          <button type="submit" className="primary login-submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
