import { Avatar, AvatarFallback, AvatarImage } from "@inklayer/ui/components/avatar";
import { Button } from "@inklayer/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@inklayer/ui/components/dropdown-menu";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  BookText,
  Building2,
  Check,
  ChevronsUpDown,
  FileText,
  House,
  LayoutGrid,
  LogOut,
  type LucideIcon,
  Settings,
  Shield,
} from "lucide-react";
import { useEffect } from "react";
import { useMe } from "@/App";
import { NotificationBell } from "@/components/NotificationBell";
import { api } from "@/lib/api";
import { queries } from "@/lib/queries";
import { Link, match, navigate, usePath } from "@/lib/router";

const LAST_ORG_KEY = "inklayer.lastOrg";

/**
 * The bar across the top: Home and Pages (across every organisation), then the organisation you're in (switch it from
 * here) and its main places, then notifications and an account menu with Settings, Admin and Sign out.
 */
export function AppHeader({ wide }: { wide?: boolean }) {
  const { me } = useMe();
  const path = usePath();
  const org = useCurrentOrg(path);
  const docsOn = me.features.docs;

  const section =
    path === "/"
      ? "home"
      : path.startsWith("/pages")
        ? "pages"
        : /^\/orgs\/[^/]+\/(docs|graph)/.test(path)
          ? "docs"
          : path.startsWith("/orgs/") || path.startsWith("/projects/")
            ? "products"
            : null;

  return (
    <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
      <div className={cn("mx-auto flex h-14 items-center gap-2 px-5", !wide && "max-w-6xl")}>
        <Link to="/" className="mr-2 font-heading text-lg font-bold tracking-tight">
          Inklayer
        </Link>
        <nav className="flex items-center gap-0.5">
          <NavLink to="/" icon={House} active={section === "home"}>
            Home
          </NavLink>
          <NavLink to="/pages" icon={FileText} active={section === "pages"}>
            Pages
          </NavLink>
        </nav>
        {org && (
          <>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            <OrgSwitcher current={org} section={section} />
            <nav className="flex items-center gap-0.5">
              <NavLink to={`/orgs/${org.id}`} icon={LayoutGrid} active={section === "products"}>
                Products
              </NavLink>
              {docsOn && (
                <NavLink to={`/orgs/${org.id}/docs`} icon={BookText} active={section === "docs"}>
                  Docs
                </NavLink>
              )}
            </nav>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

type Org = ReturnType<typeof useMe>["me"]["organizations"][number];

/**
 * The organisation the page belongs to: from the address, or a product's organisation, or else the one you were in
 * last, or your first.
 */
function useCurrentOrg(path: string): Org | undefined {
  const { me } = useMe();
  const orgInPath = /^\/orgs\/([^/]+)/.exec(path)?.[1];
  const projectId = match("/projects/:projectId", path)?.projectId;
  const project = useQuery({ ...queries.project(projectId ?? ""), enabled: !!projectId });
  const fromPage = orgInPath ?? (projectId ? project.data?.organizationId : undefined);

  useEffect(() => {
    if (fromPage) localStorage.setItem(LAST_ORG_KEY, fromPage);
  }, [fromPage]);

  const wanted = fromPage ?? localStorage.getItem(LAST_ORG_KEY);
  return me.organizations.find((o) => o.id === wanted) ?? me.organizations[0];
}

function NavLink({
  to,
  icon: Icon,
  active,
  children,
}: {
  to: string;
  icon: LucideIcon;
  active: boolean;
  children: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      nativeButton={false}
      className={cn(active ? "bg-muted text-foreground" : "text-muted-foreground")}
      aria-current={active ? "page" : undefined}
      title={children}
      render={<Link to={to} />}
    >
      <Icon data-icon="inline-start" />
      <span className="hidden sm:inline">{children}</span>
    </Button>
  );
}

/** Shows the organisation you're in; pick another to go to the same place there. */
function OrgSwitcher({ current, section }: { current: Org; section: string | null }) {
  const { me } = useMe();
  const go = (orgId: string) => navigate(section === "docs" ? `/orgs/${orgId}/docs` : `/orgs/${orgId}`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className="max-w-56 font-medium" title="Switch organisation" />}
      >
        <Building2 data-icon="inline-start" />
        <span className="truncate">{current.name}</span>
        <ChevronsUpDown className="text-muted-foreground" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuLabel>Organisations</DropdownMenuLabel>
        {me.organizations.map((o) => (
          <DropdownMenuItem key={o.id} onClick={() => go(o.id)}>
            <span className="min-w-0 flex-1 truncate">{o.name}</span>
            <span className="text-xs text-muted-foreground">{o.role}</span>
            <Check className={cn(o.id !== current.id && "invisible")} />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/")}>
          <LayoutGrid />
          All organisations
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Your face; opens Settings, Admin (for instance administrators) and Sign out. */
function AccountMenu() {
  const { me } = useMe();
  const signOut = async () => {
    await api.post("/auth/logout");
    window.location.href = "/";
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            title={`${me.fullName} · ${me.email}`}
            aria-label="Account"
          />
        }
      >
        <Avatar size="sm">
          {me.avatarUrl && <AvatarImage src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <AvatarFallback>{initials(me.displayName)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56">
        <div className="px-2.5 py-1.5">
          <div className="truncate text-sm font-medium">{me.fullName}</div>
          <div className="truncate text-xs text-muted-foreground">{me.email}</div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <Settings />
          Settings
        </DropdownMenuItem>
        {me.isSystemAdmin && (
          <DropdownMenuItem onClick={() => navigate("/admin")}>
            <Shield />
            Admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}
