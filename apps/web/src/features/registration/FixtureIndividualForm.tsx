import { NumberField, TextField } from "../../components/ui";
import { RegistrationSubmitButton } from "./FixtureBatchForm";

export interface FixtureIndividualDefaults {
  namePrefix: string;
  startNumber: number | null;
  digits: string;
}

export interface FixtureIndividualDraft {
  fixtureName: string;
  ratedWatt: string;
  size: number | null;
}

export interface FixtureIndividualItem {
  nodeId: string;
  label: string;
  serialNumber: string;
  editable: boolean;
  draft: FixtureIndividualDraft;
  error?: string;
}

interface FixtureIndividualFormProps {
  defaults: FixtureIndividualDefaults;
  items: FixtureIndividualItem[];
  actionableCount: number;
  disabled: boolean;
  pending: boolean;
  onDefaultsChange: (values: FixtureIndividualDefaults) => void;
  onDraftChange: (nodeId: string, patch: Partial<FixtureIndividualDraft>) => void;
  onSubmit: () => void;
}

export function FixtureIndividualForm({
  defaults,
  items,
  actionableCount,
  disabled,
  pending,
  onDefaultsChange,
  onDraftChange,
  onSubmit
}: FixtureIndividualFormProps) {
  return (
    <form className="grid gap-3.5" data-testid="fixture-config-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="grid grid-cols-1 gap-2.5 compact:grid-cols-2 tablet:grid-cols-3">
        <TextField label="자동 이름 접두어" value={defaults.namePrefix} maxLength={100} onChange={(value) => onDefaultsChange({ ...defaults, namePrefix: value })} />
        <NumberField label="자동 이름 시작 번호" value={defaults.startNumber} minValue={1} step={1} onChange={(value) => onDefaultsChange({ ...defaults, startNumber: value })} />
        <TextField label="자동 이름 자릿수" inputMode="numeric" pattern="[1-9]" maxLength={1} value={defaults.digits} onChange={(value) => onDefaultsChange({ ...defaults, digits: value })} />
      </div>
      <div className="grid max-h-screen gap-2.5 overflow-y-auto">
        {items.map((item) => (
          <fieldset key={item.nodeId} className="m-0 grid min-w-0 grid-cols-1 gap-2.5 rounded-control border border-border-default p-2.5 disabled:bg-surface-inset disabled:opacity-70 compact:grid-cols-2 tablet:grid-cols-3" disabled={!item.editable || pending}>
            <legend className="px-1.5 text-caption font-bold text-content-primary">{item.serialNumber}</legend>
            <TextField label={`${item.label} 이름`} value={item.draft.fixtureName} maxLength={200} onChange={(value) => onDraftChange(item.nodeId, { fixtureName: value })} />
            <TextField label={`${item.label} 정격 전력`} inputMode="decimal" value={item.draft.ratedWatt} onChange={(value) => onDraftChange(item.nodeId, { ratedWatt: value })} />
            <NumberField label={`${item.label} 크기`} value={item.draft.size} minValue={1} maxValue={1000} onChange={(value) => onDraftChange(item.nodeId, { size: value })} />
            {item.error ? <p className="m-0 text-body-sm font-bold text-status-danger-foreground compact:col-span-2 tablet:col-span-3">{item.error}</p> : null}
          </fieldset>
        ))}
      </div>
      <RegistrationSubmitButton selectedCount={actionableCount} disabled={disabled} pending={pending} />
    </form>
  );
}
