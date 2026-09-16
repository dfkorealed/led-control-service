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
    <form className="registration-config-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="registration-fields individual-default-fields">
        <TextField label="자동 이름 접두어" value={defaults.namePrefix} maxLength={100} onChange={(value) => onDefaultsChange({ ...defaults, namePrefix: value })} />
        <NumberField label="자동 이름 시작 번호" value={defaults.startNumber} minValue={1} step={1} onChange={(value) => onDefaultsChange({ ...defaults, startNumber: value })} />
        <TextField label="자동 이름 자릿수" inputMode="numeric" pattern="[1-9]" maxLength={1} value={defaults.digits} onChange={(value) => onDefaultsChange({ ...defaults, digits: value })} />
      </div>
      <div className="individual-fixture-list">
        {items.map((item) => (
          <fieldset key={item.nodeId} className="individual-fixture-fields" disabled={!item.editable || pending}>
            <legend>{item.serialNumber}</legend>
            <TextField label={`${item.label} 이름`} value={item.draft.fixtureName} maxLength={200} onChange={(value) => onDraftChange(item.nodeId, { fixtureName: value })} />
            <TextField label={`${item.label} 정격 전력`} inputMode="decimal" value={item.draft.ratedWatt} onChange={(value) => onDraftChange(item.nodeId, { ratedWatt: value })} />
            <NumberField label={`${item.label} 크기`} value={item.draft.size} minValue={1} maxValue={1000} onChange={(value) => onDraftChange(item.nodeId, { size: value })} />
            {item.error ? <p className="danger-text individual-error">{item.error}</p> : null}
          </fieldset>
        ))}
      </div>
      <RegistrationSubmitButton selectedCount={actionableCount} disabled={disabled} pending={pending} />
    </form>
  );
}
