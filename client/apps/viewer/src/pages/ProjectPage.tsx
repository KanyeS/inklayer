import { useState, type FormEvent } from "react";
import { ErrorText, Loading, Page, PageTitle } from "@/components/Layout";
import { Badge } from "@inklayer/ui/components/badge";
import { useMe } from "@/App";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@inklayer/ui/components/breadcrumb";
import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@inklayer/ui/components/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@inklayer/ui/components/tabs";
import { atLeast, get, patch, type LivePageSummary, type Project } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { Link } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";

export function ProjectPage({ projectId }: { projectId: string }) {
  const { me } = useMe();
  const project = useAsync(() => get<Project>(`/api/projects/${projectId}`), [projectId]);

  if (project.error) return <Page><ErrorText error={project.error} /></Page>;
  if (!project.data) return <Page><Loading /></Page>;
  const isAdmin = atLeast(project.data.myRole, "Admin");
  const orgName = me.organizations.find((o) => o.id === project.data!.organizationId)?.name ?? "Organisation";

  return (
    <Page>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link to="/" />}>Organisations</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink render={<Link to={`/orgs/${project.data.organizationId}`} />}>{orgName}</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{project.data.name}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageTitle badge={<Badge variant="secondary">{project.data.myRole}</Badge>}>{project.data.name}</PageTitle>
      <Tabs defaultValue="pages">
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="pages">Pages</TabsTrigger>
          {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
        <TabsContent value="pages"><Pages project={project.data} /></TabsContent>
        {isAdmin && <TabsContent value="settings"><Settings project={project.data} onSaved={project.reload} /></TabsContent>}
      </Tabs>
    </Page>
  );
}

/** Pages with comments in this project. Opening one shows the comments on the page itself, through the extension. */
function Pages({ project }: { project: Project }) {
  const pages = useAsync(() => get<LivePageSummary[]>(`/api/projects/${project.id}/live/pages`), [project.id]);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        Pages people have commented on with the Inklayer extension. Open one to see its comments on the page.
      </p>
      <ErrorText error={pages.error} />
      {pages.data?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No comments yet</EmptyTitle>
            <EmptyDescription>On any website, click the Inklayer toolbar button and choose "Comment on this page".</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {pages.data && pages.data.length > 0 && (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead className="w-24">Open</TableHead>
              <TableHead className="w-24">Resolved</TableHead>
              <TableHead className="w-36">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.data.map((p) => (
              <TableRow key={p.pageUrl}>
                <TableCell className="truncate">
                  <a className="text-primary hover:underline dark:text-violet-300" href={p.pageUrl} target="_blank" rel="noopener noreferrer">{p.pageUrl}</a>
                </TableCell>
                <TableCell>{p.openCount > 0 ? <Badge>{p.openCount}</Badge> : <span className="text-muted-foreground">0</span>}</TableCell>
                <TableCell className="text-muted-foreground">{p.resolvedCount}</TableCell>
                <TableCell className="text-muted-foreground">{timeAgo(p.lastActivityAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function Settings({ project, onSaved }: { project: Project; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(project.name);
  const [matchQuery, setMatchQuery] = useState(project.liveMatchQuery);
  const [matchHash, setMatchHash] = useState(project.liveMatchHash);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await patch(`/api/projects/${project.id}`, {
        name,
        liveMatchQuery: matchQuery,
        liveMatchHash: matchHash,
      });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    }
  };

  return (
    <form className="max-w-xl" onSubmit={submit}>
      <FieldGroup className="gap-6">
        <Field>
          <FieldLabel htmlFor="project-name">Name</FieldLabel>
          <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <FieldSet className="gap-4">
          <FieldLegend>Page addresses</FieldLegend>
          <FieldDescription>Which addresses count as the same page when people comment.</FieldDescription>
          <Field orientation="horizontal">
            <Checkbox id="match-query" checked={matchQuery} onCheckedChange={setMatchQuery} />
            <FieldLabel htmlFor="match-query" className="font-normal">The query string makes a different page (e.g. <code>?id=42</code>)</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="match-hash" checked={matchHash} onCheckedChange={setMatchHash} />
            <FieldLabel htmlFor="match-hash" className="font-normal">The #hash makes a different page (apps that route with <code>#/path</code>)</FieldLabel>
          </Field>
          <FieldDescription>
            When these are off, <code>/pricing?ref=email#faq</code> and <code>/pricing</code> are the same page. Only the parts that make a different page are stored,
            so leave them off if your URLs can carry secrets such as reset tokens. Turning one off later merges pages that now count as the same.
          </FieldDescription>
        </FieldSet>
        <div className="flex items-center gap-3">
          <Button type="submit">Save</Button>
          {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        </div>
        <ErrorText error={error} />
      </FieldGroup>
    </form>
  );
}
