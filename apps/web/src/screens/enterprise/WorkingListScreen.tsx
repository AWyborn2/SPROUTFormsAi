import { Badge, Button, Card, Icon, useToast, type BadgeVariant } from '@formai/ui';
import {
  useApproveTrainingRequest,
  useDeclineTrainingRequest,
  useWorkingList,
} from '../../lib/data/hooks.js';
import type { WorkingListItem } from '../../lib/data/types.js';

/** How each source reads in the list — its label and tone. */
const KIND_META: Record<WorkingListItem['kind'], { label: string; variant: BadgeVariant }> = {
  training_request: { label: 'Training request', variant: 'neutral' },
  retirement_review: { label: 'Retirement review', variant: 'warning' },
  overdue_case: { label: 'Overdue case', variant: 'danger' },
};

/**
 * The working list (U19) — everything waiting on an Admin, from every source, on
 * one screen. Nothing here is a compliance fact (that is its own report); an item
 * leaves because the thing behind it changed, not because anyone ticked it off.
 */
export function WorkingListScreen() {
  const { data: items, isLoading, isError } = useWorkingList();

  return (
    <div className="fai-rise mx-auto grid max-w-[820px] gap-5 p-[30px_28px_60px]">
      <div>
        <h2 className="font-heading text-xl font-bold">Working list</h2>
        <p className="mt-1 text-sm text-text-tertiary">
          Everything waiting on you, from every source, oldest first. An item leaves the list when
          you act on the thing behind it — nothing is ticked off here.
        </p>
      </div>

      <Card className="p-0">
        {isLoading && <div className="p-6 text-sm text-text-tertiary">Loading…</div>}
        {isError && <div className="p-6 text-sm text-danger-text">Could not load the working list.</div>}
        {items && items.length === 0 && (
          <div className="flex items-center gap-2 p-6 text-sm text-text-tertiary">
            <Icon name="check-circle-2" size={16} />
            Nothing is waiting on you.
          </div>
        )}
        {items && items.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {items.map((item) => (
              <WorkingListRow key={`${item.kind}-${item.id}`} item={item} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function WorkingListRow({ item }: { item: WorkingListItem }) {
  const { toast } = useToast();
  const approve = useApproveTrainingRequest();
  const decline = useDeclineTrainingRequest();
  const meta = KIND_META[item.kind];

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Badge variant={meta.variant}>{meta.label}</Badge>
      <span className="min-w-0 flex-1 truncate text-[13px]">{item.subject}</span>
      {item.createdAt && (
        <span className="text-[11px] text-text-tertiary">{item.createdAt.slice(0, 10)}</span>
      )}
      {item.kind === 'training_request' && (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={decline.isPending}
            onClick={() =>
              decline.mutate(item.id, {
                onSuccess: () => toast({ variant: 'success', message: 'Request declined.' }),
                onError: () => toast({ variant: 'danger', message: 'Something went wrong.' }),
              })
            }
          >
            Decline
          </Button>
          <Button
            size="sm"
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate(item.id, {
                onSuccess: () => toast({ variant: 'success', message: 'Approved and assigned.' }),
                onError: () => toast({ variant: 'danger', message: 'Something went wrong.' }),
              })
            }
          >
            Approve
          </Button>
        </div>
      )}
    </li>
  );
}
