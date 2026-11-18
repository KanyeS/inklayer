import type { ReactNode } from "react";
import { cn } from "@inklayer/ui/lib/utils";
import { useMe } from "@/App";
import { Avatar, AvatarFallback, AvatarImage } from "@inklayer/ui/components/avatar";
import { Button } from "@inklayer/ui/components/button";
import { Spinner } from "@inklayer/ui/components/spinner";
import { post } from "@/lib/api";
import { Link } from "@/lib/router";
import { NotificationBell } from "@/components/NotificationBell";

/** @param wide Full-width pages (docs) use the whole window; others sit in a centred column. */
export function Layout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { me } = useMe();
  const signOut = async () => {
    await post("/auth/logout");
    window.location.href = "/";
  };
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className={cn("mx-auto flex h-14 items-center justify-between gap-4 px-5", !wide && "max-w-6xl")}>
          <Link to="/" className="font-heading text-lg font-bold tracking-tight">Inklayer</Link>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/pages" />}>Pages</Button>
            <NotificationBell />
            {me.isSystemAdmin && (
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/admin" />}>Admin</Button>
            )}
            <Link to="/settings" className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-muted" title={`${me.fullName} · ${me.email} · Settings`}>
              <Avatar size="sm">
                {me.avatarUrl && <AvatarImage src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />}
                <AvatarFallback>{initials(me.displayName)}</AvatarFallback>
              </Avatar>
              <span className="hidden sm:inline">{me.displayName}</span>
            </Link>
            <Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-5 pt-8 pb-16", className)}>{children}</div>;
}

export function PageTitle({ children, badge }: { children: ReactNode; badge?: ReactNode }) {
  return (
    <h1 className="mt-1 mb-6 flex items-center gap-3 font-heading text-2xl font-semibold tracking-tight">
      {children}
      {badge && <span className="font-sans">{badge}</span>}
    </h1>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mt-10 mb-3 font-heading text-base font-semibold">{children}</h2>;
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 py-8 text-muted-foreground">
      <Spinner /> Loading…
    </div>
  );
}

export function ErrorText({ error }: { error: Error | null | undefined }) {
  return error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}
