import { RegistrationSubmitButton } from "./FixtureBatchForm";

export interface FixtureIndividualDefaults {
  namePrefix: string;
  startNumber: number;
  digits: number;
}

export interface FixtureIndividualDraft {
  fixtureName: string;
  ratedWatt: string;
  size: number;
  x: string;
  y: string;
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
        <label>
          자동 이름 접두어
          <input
            value={defaults.namePrefix}
            maxLength={100}
            onChange={(event) => onDefaultsChange({ ...defaults, namePrefix: event.target.value })}
          />
        </label>
        <label>
          자동 이름 시작 번호
          <input
            type="number"
            min={1}
            value={defaults.startNumber}
            onChange={(event) => onDefaultsChange({ ...defaults, startNumber: Number(event.target.value) })}
          />
        </label>
        <label>
          자동 이름 자릿수
          <input
            type="number"
            min={1}
            max={9}
            value={defaults.digits}
            onChange={(event) => onDefaultsChange({ ...defaults, digits: Number(event.target.value) })}
          />
        </label>
      </div>
      <div className="individual-fixture-list">
        {items.map((item) => (
          <fieldset key={item.nodeId} className="individual-fixture-fields" disabled={!item.editable || pending}>
            <legend>{item.serialNumber}</legend>
            <label>
              {item.label} 이름
              <input
                value={item.draft.fixtureName}
                maxLength={200}
                onChange={(event) => onDraftChange(item.nodeId, { fixtureName: event.target.value })}
              />
            </label>
            <label>
              {item.label} 정격 전력
              <input
                inputMode="decimal"
                value={item.draft.ratedWatt}
                onChange={(event) => onDraftChange(item.nodeId, { ratedWatt: event.target.value })}
              />
            </label>
            <label>
              {item.label} 크기
              <input
                type="number"
                min={1}
                max={1000}
                value={item.draft.size}
                onChange={(event) => onDraftChange(item.nodeId, { size: Number(event.target.value) })}
              />
            </label>
            <label>
              {item.label} X 좌표
              <input
                type="number"
                value={item.draft.x}
                onChange={(event) => onDraftChange(item.nodeId, { x: event.target.value })}
              />
            </label>
            <label>
              {item.label} Y 좌표
              <input
                type="number"
                value={item.draft.y}
                onChange={(event) => onDraftChange(item.nodeId, { y: event.target.value })}
              />
            </label>
            {item.error ? <p className="danger-text individual-error">{item.error}</p> : null}
          </fieldset>
        ))}
      </div>
      <RegistrationSubmitButton selectedCount={actionableCount} disabled={disabled} pending={pending} />
    </form>
  );
}
