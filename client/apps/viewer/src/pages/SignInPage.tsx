export function SignInPage() {
  const returnUrl = window.location.pathname + window.location.search;
  return (
    <div className="center">
      <div className="card signin">
        <h1>Inklayer</h1>
        <p className="muted">Comment on any web page, right on the page, with your team.</p>
        <a className="button primary" href={`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`}>Sign in with Google</a>
      </div>
    </div>
  );
}
