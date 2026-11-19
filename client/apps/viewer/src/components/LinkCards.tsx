import { Badge } from "@inklayer/ui/components/badge";
import { Card } from "@inklayer/ui/components/card";
import { ChevronRightIcon } from "lucide-react";
import { Link } from "@/lib/router";

export interface CardItem {
  key: string;
  to: string;
  title: string;
  badge: string;
}

/** A grid of navigable cards, for organisations and projects. */
export function LinkCards({ items }: { items: CardItem[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
      {items.map((item) => (
        <li key={item.key}>
          <Link
            to={item.to}
            className="group block rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <Card
              size="sm"
              className="flex-row items-center justify-between px-5 transition-shadow group-hover:shadow-lg group-hover:ring-primary/40"
            >
              <span className="truncate font-medium">{item.title}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge variant="secondary">{item.badge}</Badge>
                <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </span>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
