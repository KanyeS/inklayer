import { Spinner } from "@inklayer/ui/components/spinner";
import { cn } from "@inklayer/ui/lib/utils";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";

/** @param wide Full-width pages (docs) use the whole window; others sit in a centred column. */
export function Layout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader wide={wide} />
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
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error.message}
    </p>
  ) : null;
}
