import type { ReactNode } from "react";
import { Card, Heading } from "../../../../components/ui";

export function AutomationRuleCard({
  name,
  status,
  fields,
  actions
}: {
  name: string;
  status: ReactNode;
  fields: { label: string; value: ReactNode }[];
  actions?: ReactNode;
}) {
  return (
    <Card role="listitem" className="grid min-w-0 gap-4 p-4" data-automation-card="">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <Heading as="h4" variant="card-title" className="min-w-0 break-words">{name}</Heading>
        {status}
      </div>
      <dl className="m-0 grid min-w-0 gap-3 text-body-sm">
        {fields.map(({ label, value }) => (
          <div key={label} className="min-w-0 break-words">
            <dt className="text-label font-bold text-content-muted">{label}</dt>
            <dd className="m-0 mt-1 min-w-0 text-content-primary">{value}</dd>
          </div>
        ))}
      </dl>
      {actions}
    </Card>
  );
}
