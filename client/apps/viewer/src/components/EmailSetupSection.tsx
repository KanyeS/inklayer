import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { GuideLink } from "@/components/GuideLink";
import { SectionTitle } from "@/components/Layout";
import { api } from "@/lib/api";
import { queries } from "@/lib/queries";

/** Whether the server can send notification emails (INKLAYER_SMTP_*), with a test. Instance administrators. */
export function EmailSetupSection() {
  const setup = useQuery(queries.admin.email());
  const [result, setResult] = useState<string | null>(null);
  const test = async () => {
    const r = await api.post("/api/admin/email/test");
    setResult(r.ok ? "Sent to your address ✓" : `Failed: ${r.error}`);
  };
  return (
    <section>
      <SectionTitle>Email</SectionTitle>
      {setup.data?.configured ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge variant="secondary">Set up</Badge>
          <span className="text-muted-foreground">Sending as {setup.data.from}</span>
          <Button variant="outline" size="sm" onClick={() => void test()}>
            Send me a test email
          </Button>
          {result && <span>{result}</span>}
        </div>
      ) : (
        <p className="max-w-2xl text-sm text-muted-foreground">
          Not set up. To let organisations email notifications, set <code>INKLAYER_SMTP_HOST</code>,{" "}
          <code>INKLAYER_SMTP_PORT</code>, <code>INKLAYER_SMTP_USERNAME</code>, <code>INKLAYER_SMTP_PASSWORD</code> and{" "}
          <code>INKLAYER_SMTP_FROM</code> on the server (Amazon SES works), then restart. <GuideLink section="email" />
        </p>
      )}
    </section>
  );
}
