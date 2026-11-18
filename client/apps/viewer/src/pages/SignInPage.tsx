import { useEffect, useState } from "react";
import { get } from "../lib/api";

interface SignInProvider {
  id: string;
  displayName: string;
}

export function SignInPage() {
  const returnUrl = window.location.pathname + window.location.search;
  const [providers, setProviders] = useState<SignInProvider[] | null>(null);
  useEffect(() => {
    get<SignInProvider[]>("/auth/providers").then(setProviders, () => setProviders([]));
  }, []);

  const loginUrl = (provider?: string) =>
    `/auth/login?${provider ? `provider=${encodeURIComponent(provider)}&` : ""}returnUrl=${encodeURIComponent(returnUrl)}`;

  return (
    <div className="center">
      <div className="card signin">
        <h1>Inklayer</h1>
        <p className="muted">Comment on any web page, right on the page, with your team.</p>
        {providers && providers.length > 0 ? (
          providers.map((p) => (
            <a key={p.id} className="button primary" href={loginUrl(p.id)}>Sign in with {p.displayName}</a>
          ))
        ) : (
          <a className="button primary" href={loginUrl()}>Sign in</a>
        )}
      </div>
    </div>
  );
}
