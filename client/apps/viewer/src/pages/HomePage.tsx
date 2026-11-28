import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@inklayer/ui/components/empty";
import { useMe } from "@/App";
import { ConnectedApps } from "@/components/ConnectedApps";
import { Page, PageTitle } from "@/components/Layout";
import { type CardItem, LinkCards } from "@/components/LinkCards";
import { TrackerAccounts } from "@/components/TrackerAccounts";
import { MyTasks } from "@/kanban/MyTasks";
import { Link } from "@/lib/router";

export function HomePage() {
  const { me } = useMe();
  const items: CardItem[] = me.organizations.map((o) => ({
    key: o.id,
    to: `/orgs/${o.id}`,
    title: o.name,
    badge: o.role,
  }));
  return (
    <Page>
      <PageTitle>Organisations</PageTitle>
      {items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>You're not a member of any organisation yet</EmptyTitle>
            <EmptyDescription>
              {me.isSystemAdmin ? (
                <>
                  Create one on the <Link to="/admin">Admin</Link> page.
                </>
              ) : (
                "Ask an administrator to invite you."
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <LinkCards items={items} />
      )}
      {me.features.kanban && <MyTasks orgs={me.organizations} />}
      <ConnectedApps />
      <TrackerAccounts />
    </Page>
  );
}
