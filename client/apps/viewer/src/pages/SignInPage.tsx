import { buttonVariants } from "@inklayer/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@inklayer/ui/components/card";
import { useEffect, useState } from "react";
import { get } from "@/lib/api";

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
    <div className="grid min-h-svh place-items-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-bold tracking-tight">Inklayer</CardTitle>
          <CardDescription>Comment on any web page, right on the page, with your team.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {providers && providers.length > 0 ? (
            providers.map((p) => (
              <a key={p.id} className={buttonVariants({ size: "lg" })} href={loginUrl(p.id)}>
                Sign in with {p.displayName}
              </a>
            ))
          ) : (
            <a className={buttonVariants({ size: "lg" })} href={loginUrl()}>
              Sign in
            </a>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
