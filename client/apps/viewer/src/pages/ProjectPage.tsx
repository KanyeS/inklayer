import { Badge } from "@inklayer/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@inklayer/ui/components/breadcrumb";
import { Button } from "@inklayer/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@inklayer/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@inklayer/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useMe } from "@/App";
import { AccessSection } from "@/components/access/AccessSection";
import { RequestAccess } from "@/components/access/RequestAccess";
import { IssueTrackersSection } from "@/components/Issues";
import { ErrorText, Loading, Page, PageTitle } from "@/components/Layout";
import { PagesTable } from "@/components/PagesTable";
import { ProjectSharesSection } from "@/components/Shares";
import { api, atLeast, type Project } from "@/lib/api";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";
import { Link } from "@/lib/router";

export function ProjectPage({ projectId }: { projectId: string }) {
  const { me } = useMe();
  const project = useQuery(queries.project(projectId));

  if (project.error)
    return (
      <Page>
        <ErrorText error={project.error} />
      </Page>
    );
  if (!project.data)
    return (
      <Page>
        <Loading />
      </Page>
    );
  const isManager = atLeast(project.data.myRole, "Manager");
  const canShare = me.features.sharing && atLeast(project.data.myRole, "Commenter");
  const orgName = me.organizations.find((o) => o.id === project.data!.organizationId)?.name ?? "Organisation";

  return (
    <Page>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/" />}>Organisations</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to={`/orgs/${project.data.organizationId}`} />}>{orgName}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{project.data.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageTitle badge={project.data.myRole && <Badge variant="secondary">{project.data.myRole}</Badge>}>
        {project.data.name}
      </PageTitle>
      {project.data.myRole == null ? (
        <RequestAccess project={project.data} />
      ) : (
        <Tabs defaultValue={window.location.hash === "#access" ? "access" : "pages"}>
          <TabsList variant="line" className="mb-4">
            <TabsTrigger value="pages">Pages</TabsTrigger>
            {canShare && <TabsTrigger value="sharing">Sharing</TabsTrigger>}
            <TabsTrigger value="access">Access</TabsTrigger>
            {isManager && <TabsTrigger value="settings">Settings</TabsTrigger>}
          </TabsList>
          <TabsContent value="pages">
            <Pages project={project.data} />
          </TabsContent>
          {canShare && (
            <TabsContent value="sharing">
              <ProjectSharesSection projectId={project.data.id} />
            </TabsContent>
          )}
          <TabsContent value="access">
            <AccessSection orgId={project.data.organizationId} resourceType="project" resourceId={project.data.id} />
          </TabsContent>
          {isManager && (
            <TabsContent value="settings">
              <Settings project={project.data} />
              {me.features.issueTrackers && <IssueTrackersSection projectId={project.data.id} />}
            </TabsContent>
          )}
        </Tabs>
      )}
    </Page>
  );
}

/** Pages with comments in this product. Opening one shows the comments on the page itself, through the extension. */
function Pages({ project }: { project: Project }) {
  const pages = useQuery(queries.projectPages(project.id));

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        Pages people have commented on with the Inklayer extension. Open one to see its comments on the page. An address
        without a query string, like <code>/watch</code>, holds comments for every version of that page.
      </p>
      <ErrorText error={pages.error} />
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
      {pages.data && pages.data.length > 0 && <PagesTable pages={pages.data} showProject={false} />}
    </div>
  );
}

function Settings({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [saved, setSaved] = useState(false);
  const { run, error } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const done = await run(() =>
      api.patch("/api/projects/{projectId}", { params: { path: { projectId: project.id } }, body: { name } }),
    );
    setSaved(done.ok);
  };

  return (
    <form className="max-w-md" onSubmit={submit}>
      <FieldGroup className="gap-6">
        <Field>
          <FieldLabel htmlFor="project-name">Product name</FieldLabel>
          <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit">Save</Button>
          {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        </div>
        <ErrorText error={error} />
      </FieldGroup>
    </form>
  );
}
