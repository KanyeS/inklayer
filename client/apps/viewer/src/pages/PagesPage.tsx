import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@inklayer/ui/components/empty";
import { useQuery } from "@tanstack/react-query";
import { ErrorText, Loading, Page, PageTitle } from "@/components/Layout";
import { PagesTable } from "@/components/PagesTable";
import { queries } from "@/lib/queries";

/** Every page with comments, across every project you can see. */
export function PagesPage() {
  const pages = useQuery(queries.livePages());

  return (
    <Page>
      <PageTitle>Pages</PageTitle>
      <p className="mb-4 text-muted-foreground">
        Every page with comments, in every project you can see. Open one to see its comments on the page.
      </p>
      <ErrorText error={pages.error} />
      {!pages.data && !pages.error && <Loading />}
      {pages.data?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No comments yet</EmptyTitle>
            <EmptyDescription>
              On any website, click the Inklayer toolbar button and choose "Comment on this page".
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {pages.data && pages.data.length > 0 && <PagesTable pages={pages.data} showProject />}
    </Page>
  );
}
